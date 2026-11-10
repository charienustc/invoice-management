import type { OcrProgress, OcrSettings } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { InvoiceDatabase } from '../db/database'
import { ImportService } from './import-service'
import { SettingsService } from './settings-service'
import { OcrClient } from '../ocr/client'
import { adaptOcrResponse, type OcrLine } from '../ocr/response-adapter'
import { parseInvoiceLines } from '../ocr/parser'
import { convertPdfToPng } from '../ocr/pdf-converter'
import { loadImage } from '@napi-rs/canvas'

export class OcrQueue {
  get isActive(): boolean { return this.active.size > 0 }
  private readonly active = new Set<string>()
  private readonly retryWaiting = new Set<string>()
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()
  private stopped = false

  constructor(
    private readonly db: InvoiceDatabase,
    private readonly settings: SettingsService,
    private readonly files: ImportService,
    private readonly client: OcrClient,
    private readonly emit: (progress: OcrProgress) => void,
    private readonly autoRecognizePending: () => boolean = () => true,
  ) {}

  start(): void {
    this.stopped = false
    this.db.recoverQueue()
    this.pump()
  }

  enqueue(invoiceId: string): void {
    if (this.stopped || this.active.has(invoiceId)) return
    const invoice = this.db.get(invoiceId)
    if (!invoice || invoice.deletedAt) return
    this.db.setOcrStatus(invoiceId, 'queued')
    this.emit({ invoiceId, status: 'queued', attempt: this.db.get(invoiceId)?.ocrAttempts ?? 0 })
    this.pump()
  }

  retry(invoiceId: string): boolean {
    const invoice = this.db.get(invoiceId)
    if (!invoice || invoice.deletedAt) throw new AppError('INVOICE_NOT_FOUND', '发票不存在或已移入回收站')
    if (this.stopped || this.active.has(invoiceId)) return false
    const timer = this.retryTimers.get(invoiceId)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(invoiceId)
    this.retryWaiting.delete(invoiceId)
    this.db.resetOcrRound(invoiceId)
    this.enqueue(invoiceId)
    return true
  }

  private pump(): void {
    if (this.stopped) return
    const settingsPromise = this.settings.get()
    void settingsPromise.then((settings) => {
      if (this.stopped) return
      const available = (settings.engineMode === 'builtin' ? 1 : settings.concurrency) - this.active.size
      if (available <= 0) return
      const queued = this.db.nextQueued(available, [...this.active, ...this.retryWaiting], this.autoRecognizePending())
      for (const invoice of queued.slice(0, available)) {
        this.active.add(invoice.id)
        this.db.setOcrStatus(invoice.id, 'running')
        this.emit({ invoiceId: invoice.id, status: 'running', attempt: invoice.ocrAttempts + 1 })
        void this.execute(invoice.id, settings).finally(() => {
          this.active.delete(invoice.id)
          this.pump()
        })
      }
    }).catch((error) => {
      console.error('OCR queue settings error', error)
    })
  }

  private async execute(invoiceId: string, settings: OcrSettings): Promise<void> {
    const invoice = this.db.get(invoiceId)
    if (!invoice || invoice.deletedAt) return
    const attempt = invoice.ocrAttempts
    const roundAttempt = this.db.getOcrRound(invoiceId)
    try {
      const file = await this.files.readInvoiceFile(invoiceId)
      if (this.stopped) return
      const images = file.mimeType === 'application/pdf'
        ? (await convertPdfToPng(file.data)).map((data, index) => ({ data, fileName: `${file.fileName}-page-${index + 1}.png`, mimeType: 'image/png' }))
        : [file]
      const rawResponses: unknown[] = []
      const lines: OcrLine[] = []
      for (let index = 0; index < images.length; index++) {
        if (this.stopped || !this.db.get(invoiceId) || this.db.get(invoiceId)!.deletedAt) return
        const raw = await this.client.recognize(images[index], settings)
        let imageSize: { width: number; height: number } | undefined
        try { const image = await loadImage(images[index].data); imageSize = { width: image.width, height: image.height } } catch { /* OCR may support image formats unavailable to the local preview decoder. */ }
        rawResponses.push(imageSize ? { response: raw, imageSize } : raw)
        const adapted = adaptOcrResponse(raw, settings.engineMode === 'builtin' ? 'lines' : settings.adapter)
        lines.push(...adapted.lines.map((line) => ({ ...line, page: index + 1, imageWidth: imageSize?.width, imageHeight: imageSize?.height })))
      }
      const ordered = lines.map((line, id) => ({ ...line, id }))
      const parsed = parseInvoiceLines(ordered)
      if (this.stopped || !this.db.get(invoiceId) || this.db.get(invoiceId)!.deletedAt) return
      this.db.recordOcrSuccess(invoiceId, {
        rawResponse: rawResponses.length === 1 ? rawResponses[0] : { pages: rawResponses },
        normalizedText: parsed.normalizedText,
        parsedFields: parsed.fields,
        evidence: parsed.evidence,
        warnings: parsed.warnings,
      })
      this.emit({ invoiceId, status: 'succeeded', attempt })
    } catch (error) {
      if (this.stopped || !this.db.get(invoiceId) || this.db.get(invoiceId)!.deletedAt) return
      const message = error instanceof AppError ? error.message : 'OCR 处理失败，请检查原文件后重试'
      const retryable = error instanceof AppError && 'retryable' in error && error.retryable === true
      if (retryable && roundAttempt <= settings.maxRetries) {
        const delay = Math.min(30_000, 1000 * 2 ** (roundAttempt - 1))
        this.retryWaiting.add(invoiceId)
        this.db.setOcrStatus(invoiceId, 'queued', message)
        this.emit({ invoiceId, status: 'queued', attempt, error: `${message}，${Math.ceil(delay / 1000)} 秒后重试` })
        const timer = setTimeout(() => {
          this.retryTimers.delete(invoiceId)
          this.retryWaiting.delete(invoiceId)
          this.pump()
        }, delay)
        this.retryTimers.set(invoiceId, timer)
      } else {
        this.db.setOcrStatus(invoiceId, 'failed', message)
        this.emit({ invoiceId, status: 'failed', attempt, error: message })
      }
    }
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    this.retryWaiting.clear()
  }

  wake(): void { this.pump() }
}
