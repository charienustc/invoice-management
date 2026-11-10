import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { createReadStream } from 'node:fs'
import type { ImportSummary } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { InvoiceDatabase } from '../db/database'

const MAX_FILE_SIZE = 25 * 1024 * 1024
const EXTENSIONS: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.bmp': 'image/bmp', '.webp': 'image/webp', '.pdf': 'application/pdf',
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

export function hasValidSignature(buffer: Buffer, extension: string): boolean {
  if (extension === '.jpg' || extension === '.jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (extension === '.png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (extension === '.bmp') return buffer.length >= 2 && buffer.subarray(0, 2).toString() === 'BM'
  if (extension === '.pdf') return buffer.length >= 5 && buffer.subarray(0, 5).toString() === '%PDF-'
  if (extension === '.webp') return buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP'
  return false
}

export class ImportService {
  constructor(
    private readonly db: InvoiceDatabase,
    private readonly dataDirectory: string,
    private readonly onImported: (invoiceId: string) => void,
  ) {}

  async import(paths: string[]): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: [], duplicates: [], failures: [] }
    for (const sourcePath of paths) {
      const fileName = basename(sourcePath)
      try {
        const result = await this.importOne(sourcePath)
        if (typeof result === 'string') summary.duplicates.push({ fileName, invoiceId: result, deleted: !!this.db.get(result)?.deletedAt })
        else summary.imported.push(result)
      } catch (error) {
        summary.failures.push({
          fileName,
          message: error instanceof AppError ? error.message : '文件导入失败，请检查文件是否可读取',
        })
      }
    }
    return summary
  }

  private async importOne(sourcePath: string) {
    const source = resolve(sourcePath)
    const fileStat = await stat(source)
    if (!fileStat.isFile()) throw new AppError('FILE_INVALID', '只能选择文件')
    if (fileStat.size > MAX_FILE_SIZE) throw new AppError('FILE_TOO_LARGE', '单个文件不能超过 25 MB')
    if (fileStat.size < 12) throw new AppError('FILE_INVALID', '文件内容不完整')
    const extension = extname(source).toLowerCase()
    const mimeType = EXTENSIONS[extension]
    if (!mimeType) throw new AppError('FILE_TYPE_UNSUPPORTED', '仅支持 JPG、PNG、BMP、WebP 和 PDF')
    const handle = await open(source, 'r')
    const header = Buffer.alloc(16)
    try {
      await handle.read(header, 0, 16, 0)
    } finally {
      await handle.close()
    }
    if (!hasValidSignature(header, extension)) throw new AppError('FILE_SIGNATURE_INVALID', '文件内容与扩展名不一致')
    const sha256 = await hashFile(source)
    const existing = this.db.getByHash(sha256)
    if (existing) return existing.id

    const relativeDirectory = join('invoice-files', sha256.slice(0, 2))
    const absoluteDirectory = join(this.dataDirectory, relativeDirectory)
    await mkdir(absoluteDirectory, { recursive: true })
    const finalName = `${randomUUID()}${extension}`
    const finalPath = join(absoluteDirectory, finalName)
    const temporaryPath = `${finalPath}.tmp-${randomUUID()}`
    try {
      await copyFile(source, temporaryPath)
      if (await hashFile(temporaryPath) !== sha256) throw new AppError('FILE_COPY_FAILED', '文件复制校验失败')
      await rename(temporaryPath, finalPath)
      try {
        const invoice = this.db.create({
          fileName: basename(source),
          storagePath: join(relativeDirectory, finalName),
          mimeType,
          fileSize: fileStat.size,
          sha256,
        })
        this.onImported(invoice.id)
        return invoice
      } catch (error) {
        await unlink(finalPath).catch(() => undefined)
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          const duplicate = this.db.getByHash(sha256)
          if (duplicate) return duplicate.id
        }
        throw error
      }
    } finally {
      await unlink(temporaryPath).catch(() => undefined)
    }
  }

  resolveStoragePath(storagePath: string): string {
    const root = resolve(this.dataDirectory)
    const target = resolve(root, storagePath)
    if (!target.startsWith(`${root}${sep}`)) throw new AppError('FILE_PATH_INVALID', '文件路径无效')
    return target
  }

  async readInvoiceFile(invoiceId: string): Promise<{ data: Buffer; fileName: string; mimeType: string }> {
    const invoice = this.db.get(invoiceId)
    if (!invoice) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
    const storagePath = this.db.getStoragePath(invoiceId)
    if (!storagePath) throw new AppError('FILE_NOT_FOUND', '原文件不存在')
    const data = await readFile(this.resolveStoragePath(storagePath))
    return { data, fileName: invoice.fileName, mimeType: invoice.mimeType }
  }
}
