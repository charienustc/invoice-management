import Database from 'better-sqlite3'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import type { InvoiceDatabase } from '../db/database'

const manifestSchema = z.object({
  format: z.literal('invoice-management-backup'), version: z.literal(1), createdAt: z.string(),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(200_000),
})
const pendingSchema = z.object({ stage: z.string().regex(/^restore-stage-[a-f0-9-]+$/), rollback: z.string().regex(/^restore-rollback-[a-f0-9-]+$/).optional(), existed: z.array(z.string()).optional() })
const liveNames = ['invoice.db', 'invoice.db-wal', 'invoice.db-shm', 'invoice-files']

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function member(root: string, relative: string): string {
  if (relative !== 'invoice.db' && !/^invoice-files\/[a-zA-Z0-9_./-]+$/.test(relative)) throw new AppError('BACKUP_INVALID', '备份文件路径无效')
  if (relative.split('/').some((part) => part === '..' || part === '.' || !part)) throw new AppError('BACKUP_INVALID', '备份包含越界路径')
  const target = resolve(root, relative)
  if (!target.startsWith(`${resolve(root)}${sep}`)) throw new AppError('BACKUP_INVALID', '备份文件路径越界')
  return target
}

function snapshotFiles(path: string): Array<{ path: string; sha256: string }> {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const version = db.pragma('user_version', { simple: true }) as number
    if (version < 2 || version > 5 || db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new AppError('BACKUP_INVALID', '备份数据库损坏或版本不兼容')
    // Verify the expected tables before scheduling replacement of any live data.
    db.prepare('SELECT id, invoice_id, raw_response FROM ocr_results LIMIT 1').get()
    db.prepare('SELECT id, name FROM tags LIMIT 1').get()
    db.prepare('SELECT invoice_id, tag_id FROM invoice_tags LIMIT 1').get()
    if (version >= 4) {
      db.prepare('SELECT id, name, description FROM projects LIMIT 1').get()
      db.prepare('SELECT invoice_id, project_id FROM invoice_projects LIMIT 1').get()
    }
    const rows = db.prepare('SELECT storage_path, sha256 FROM invoices').all() as Array<{ storage_path: string; sha256: string }>
    if (version >= 5) {
      db.prepare('SELECT id, amount, revision FROM advances LIMIT 1').get()
      db.prepare('SELECT id, advance_id, amount FROM advance_returns LIMIT 1').get()
      rows.push(...db.prepare('SELECT storage_path, sha256 FROM advance_attachments').all() as typeof rows)
    }
    return rows.map((row) => ({ path: row.storage_path.replaceAll('\\', '/'), sha256: row.sha256 }))
  } finally { db.close() }
}

export async function validateBackup(root: string): Promise<z.infer<typeof manifestSchema>> {
  try {
    const manifest = manifestSchema.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')))
    const paths = new Set(manifest.files.map((file) => file.path))
    if (paths.size !== manifest.files.length || !paths.has('invoice.db')) throw new Error('Missing or repeated database')
    const base = await realpath(root)
    for (const file of manifest.files) {
      const path = member(root, file.path)
      if (!(await realpath(path)).startsWith(`${base}${sep}`) || await hashFile(path) !== file.sha256) throw new Error('Checksum mismatch')
    }
    const records = snapshotFiles(member(root, 'invoice.db'))
    const fileMap = new Map(manifest.files.map((file) => [file.path, file]))
    for (const record of records) {
      const entry = fileMap.get(record.path)
      if (!entry || entry.sha256 !== record.sha256) throw new Error('Original invoice missing')
    }
    if (paths.size !== new Set(records.map((record) => record.path)).size + 1) throw new Error('Unexpected backup files')
    return manifest
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('BACKUP_INVALID', '备份不完整、文件校验失败或数据库不兼容，当前数据未被替换')
  }
}

export class BackupService {
  constructor(private readonly db: InvoiceDatabase, private readonly dataDirectory: string) {}

  async create(destination: string): Promise<string> {
    await mkdir(destination, { recursive: true })
    const folder = await mkdtemp(join(destination, `票夹备份-${new Date().toISOString().replace(/[:.]/g, '-')}-`))
    try {
      const dbPath = join(folder, 'invoice.db')
      await this.db.backup(dbPath)
      const files = [{ path: 'invoice.db', sha256: await hashFile(dbPath) }, ...snapshotFiles(dbPath)]
      for (const file of files.slice(1)) {
        const target = member(folder, file.path)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(member(this.dataDirectory, file.path), target)
        if (await hashFile(target) !== file.sha256) throw new AppError('BACKUP_COPY_FAILED', '原文件校验失败，备份未完成')
      }
      await writeFile(join(folder, 'manifest.json'), JSON.stringify({ format: 'invoice-management-backup', version: 1, createdAt: new Date().toISOString(), files }, null, 2))
      await validateBackup(folder)
      return folder
    } catch (error) {
      // folder is created by mkdtemp inside the explicitly selected destination.
      await rm(folder, { recursive: true, force: true })
      throw error
    }
  }

  async prepareRestore(source: string): Promise<string> {
    const manifest = await validateBackup(source)
    const stage = `restore-stage-${randomUUID()}`
    const stagePath = join(this.dataDirectory, stage)
    await mkdir(stagePath)
    try {
      for (const file of manifest.files) {
        const target = member(stagePath, file.path)
        await mkdir(dirname(target), { recursive: true })
        await copyFile(member(source, file.path), target)
      }
      await writeFile(join(stagePath, 'manifest.json'), JSON.stringify(manifest))
      await validateBackup(stagePath)
      const safety = await this.create(join(this.dataDirectory, 'backups'))
      await writeFile(join(this.dataDirectory, 'restore-pending.json.tmp'), JSON.stringify({ stage }))
      renameSync(join(this.dataDirectory, 'restore-pending.json.tmp'), join(this.dataDirectory, 'restore-pending.json'))
      return safety
    } catch (error) { await rm(stagePath, { recursive: true, force: true }); throw error }
  }
}

// Runs before opening the live database. A journal also recovers interrupted swaps.
export async function applyPendingRestore(dataDirectory: string): Promise<void> {
  const pendingPath = join(dataDirectory, 'restore-pending.json')
  if (!existsSync(pendingPath)) return
  const pending = pendingSchema.parse(JSON.parse(readFileSync(pendingPath, 'utf8')))
  const stagePath = join(dataDirectory, pending.stage)
  const rollbackName = pending.rollback ?? `restore-rollback-${randomUUID()}`
  const rollbackPath = join(dataDirectory, rollbackName)
  const rollback = () => {
    for (const name of liveNames) {
      const old = join(rollbackPath, name)
      if (existsSync(old)) {
        rmSync(join(dataDirectory, name), { recursive: true, force: true })
        renameSync(old, join(dataDirectory, name))
      } else if (!pending.existed?.includes(name)) rmSync(join(dataDirectory, name), { recursive: true, force: true })
    }
    rmSync(pendingPath, { force: true })
  }
  if (pending.rollback) { rollback(); return }
  try { await validateBackup(stagePath) } catch {
    rmSync(pendingPath, { force: true })
    throw new AppError('RESTORE_VALIDATION', '待恢复数据校验失败，原有数据未被替换，请重新选择备份')
  }
  await mkdir(join(stagePath, 'invoice-files'), { recursive: true })
  await mkdir(rollbackPath)
  pending.existed = liveNames.filter((name) => existsSync(join(dataDirectory, name)))
  writeFileSync(pendingPath, JSON.stringify({ ...pending, rollback: rollbackName }))
  try {
    for (const name of pending.existed) renameSync(join(dataDirectory, name), join(rollbackPath, name))
    renameSync(join(stagePath, 'invoice.db'), join(dataDirectory, 'invoice.db'))
    renameSync(join(stagePath, 'invoice-files'), join(dataDirectory, 'invoice-files'))
    rmSync(pendingPath)
  } catch (error) { rollback(); throw error }
  // Keep the rollback directory as a second local recovery copy.
}
