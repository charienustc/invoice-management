import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, rename, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { BackupService, applyPendingRestore, validateBackup } from '../../src/main/services/backup-service'

let root: string
let data: string
let db: InvoiceDatabase | undefined
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'invoice-backup-')); data = join(root, 'data'); db = new InvoiceDatabase(data) })
afterEach(async () => { db?.close(); await rm(root, { recursive: true, force: true }) })

async function seed() {
  const source = join(root, 'original.png')
  await writeFile(source, png)
  const result = await new ImportService(db!, data, vi.fn()).import([source])
  const id = result.imported[0].id
  const project = db!.createProject({ name: '设备采购', description: '项目备注' })
  db!.setInvoiceProjects([id], [project.id])
  db!.recordOcrSuccess(id, { rawResponse: { lines: [{ text: '测试' }] }, normalizedText: '测试', parsedFields: { invoiceNumber: '12345678' }, evidence: {}, warnings: [] })
  db!.setInvoiceTags(id, ['差旅'])
  return id
}

it('备份恢复包含原件、回收站、标签和 OCR 记录，并生成恢复前安全备份', async () => {
  const id = await seed()
  db!.softDelete([id])
  const backups = new BackupService(db!, data)
  const path = await backups.create(join(root, 'exports'))
  await validateBackup(path)
  db!.restore([id])
  db!.setInvoiceTags(id, ['修改后'])
  const safety = await backups.prepareRestore(path)
  await validateBackup(safety)
  db!.close(); db = undefined
  await applyPendingRestore(data)
  db = new InvoiceDatabase(data)
  expect(db.get(id)).toMatchObject({ deletedAt: expect.any(String), tags: ['差旅'], invoiceNumber: '12345678' })
  expect(db.get(id)?.projects[0].name).toBe('设备采购')
  expect(db.listProjects()[0]).toMatchObject({ name: '设备采购', description: '项目备注', invoiceCount: 0 })
  expect(db.getOcrResults(id)[0].normalizedText).toBe('测试')
  expect(await readFile(join(data, db.getStoragePath(id)!))).toEqual(png)
  expect((await readdir(data)).includes('restore-pending.json')).toBe(false)
})

it('损坏原件与越界清单被拒绝，当前记录不变且不安排重启恢复', async () => {
  const id = await seed()
  const backups = new BackupService(db!, data)
  const path = await backups.create(join(root, 'exports'))
  await writeFile(join(path, db!.getStoragePath(id)!), 'corrupted')
  await expect(backups.prepareRestore(path)).rejects.toThrow('备份不完整')
  expect(db!.get(id)).not.toBeNull()
  expect((await readdir(data)).includes('restore-pending.json')).toBe(false)
  const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
  manifest.files[0].path = '../invoice.db'
  await writeFile(join(path, 'manifest.json'), JSON.stringify(manifest))
  await expect(validateBackup(path)).rejects.toMatchObject({ code: 'BACKUP_INVALID' })
})

it('恢复交换中断后根据日志回滚，下一次可正常打开原数据', async () => {
  const id = await seed()
  db!.close(); db = undefined
  const rollback = 'restore-rollback-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const existed = (await readdir(data)).filter((name) => ['invoice.db', 'invoice.db-wal', 'invoice.db-shm', 'invoice-files'].includes(name))
  await mkdir(join(data, rollback))
  await rename(join(data, 'invoice.db'), join(data, rollback, 'invoice.db'))
  await writeFile(join(data, 'invoice.db'), 'interrupted replacement')
  await writeFile(join(data, 'restore-pending.json'), JSON.stringify({ stage: 'restore-stage-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', rollback, existed }))
  await applyPendingRestore(data)
  db = new InvoiceDatabase(data)
  expect(db.get(id)?.invoiceNumber).toBe('12345678')
})
