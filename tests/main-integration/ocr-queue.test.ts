import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { SettingsService } from '../../src/main/services/settings-service'
import { OcrQueue } from '../../src/main/services/ocr-queue'
import { OcrClient } from '../../src/main/ocr/client'
import { OcrRequestError } from '../../src/main/ocr/client'
import { InvoiceService } from '../../src/main/services/invoice-service'
import { DEFAULT_OCR_SETTINGS as BUILTIN_OCR_SETTINGS, type OcrProgress } from '@shared/contracts'

const DEFAULT_OCR_SETTINGS = { ...BUILTIN_OCR_SETTINGS, engineMode: 'external' as const }

let directory: string
let db: InvoiceDatabase
let server: Server
let queue: OcrQueue | undefined
let requestCount = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-queue-test-'))
  db = new InvoiceDatabase(directory)
  requestCount = 0
  server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      requestCount++
      response.writeHead(requestCount === 1 ? 500 : 200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ lines: [{ text: '发票号码：12345678901234567890' }, { text: '开票日期：2026年11月04日' }, { text: '价税合计（小写）：106.00' }] }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})
afterEach(async () => {
  queue?.stop()
  db.close()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await rm(directory, { recursive: true, force: true })
})

describe('OCR 队列', () => {
  it('关闭自动识别时不处理待识别记录，手动重试仍可执行', async () => {
    const settings = new SettingsService(directory)
    await settings.save({ ...DEFAULT_OCR_SETTINGS, autoStart: false })
    const source = join(directory, 'manual.png')
    await writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const imports = new ImportService(db, directory, vi.fn())
    const id = (await imports.import([source])).imported[0].id
    const client = new OcrClient()
    const recognize = vi.spyOn(client, 'recognize').mockResolvedValue({ lines: [{ text: '发票号码：12345678' }] })
    queue = new OcrQueue(db, settings, imports, client, vi.fn(), () => false)
    queue.start()
    queue.wake()
    await new Promise((resolve) => setImmediate(resolve))
    expect(recognize).not.toHaveBeenCalled()
    expect(db.get(id)?.ocrStatus).toBe('pending')
    queue.retry(id)
    await vi.waitFor(() => expect(db.get(id)?.ocrStatus).toBe('succeeded'))
    expect(recognize).toHaveBeenCalledTimes(1)
  })
  it('手动重试重置本轮额度但保留历史次数，恢复时唤醒空闲队列', async () => {
    const settings = new SettingsService(directory)
    await settings.save({ ...DEFAULT_OCR_SETTINGS, maxRetries: 1, autoStart: false })
    const source = join(directory, 'retry.png')
    await writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const imports = new ImportService(db, directory, vi.fn())
    const id = (await imports.import([source])).imported[0].id
    for (let i = 0; i < 4; i++) db.setOcrStatus(id, 'running')
    db.setOcrStatus(id, 'failed')
    const client = new OcrClient()
    const recognize = vi.spyOn(client, 'recognize').mockRejectedValueOnce(new OcrRequestError('OCR_HTTP_ERROR', '临时失败', true)).mockResolvedValue({ lines: [{ text: '发票号码：12345678' }] })
    queue = new OcrQueue(db, settings, imports, client, vi.fn())
    queue.start()
    queue.retry(id)
    await vi.waitFor(() => expect(db.get(id)?.ocrStatus).toBe('succeeded'), { timeout: 5000 })
    expect(recognize).toHaveBeenCalledTimes(2)
    expect(db.get(id)?.ocrAttempts).toBe(6)
    db.setOcrStatus(id, 'queued')
    db.softDelete([id])
    new InvoiceService(db, imports, queue).restoreInvoices([id])
    await vi.waitFor(() => expect(db.get(id)?.ocrStatus).toBe('succeeded'), { timeout: 5000 })
    expect(recognize).toHaveBeenCalledTimes(3)
  })
  it('服务错误自动重试并保存解析结果', async () => {
    const settings = new SettingsService(directory)
    await settings.save({ ...DEFAULT_OCR_SETTINGS, endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/ocr`, maxRetries: 1 })
    const progress: OcrProgress[] = []
    let imports: ImportService
    let finished: () => void
    let failed: (message: string) => void
    const done = new Promise<void>((resolve, reject) => { finished = resolve; failed = reject })
    imports = new ImportService(db, directory, (id) => queue!.enqueue(id))
    queue = new OcrQueue(db, settings, imports, new OcrClient(), (event) => {
      progress.push(event)
      if (event.status === 'succeeded') finished()
      if (event.status === 'failed') failed(event.error ?? 'OCR failed')
    })
    queue.start()
    const source = join(directory, 'invoice.png')
    await writeFile(source, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
    const result = await imports.import([source])
    await done
    expect(requestCount).toBe(2)
    expect(db.get(result.imported[0].id)).toMatchObject({ ocrStatus: 'succeeded', ocrAttempts: 2, invoiceNumber: '12345678901234567890', totalAmount: 10600 })
    expect(progress.some((event) => event.status === 'queued' && event.error?.includes('重试'))).toBe(true)
  }, 15_000)
})
