import { unlink } from 'node:fs/promises'
import type { BatchConfirmResult, InvoiceDetail, InvoiceFields, InvoiceStatus } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { InvoiceDatabase } from '../db/database'
import { ImportService } from './import-service'
import type { OcrQueue } from './ocr-queue'
import { reparseOcrResponse } from '../ocr/reparse'
import { dataRevision, fieldRevision } from './revision'

export class InvoiceService {
  constructor(
    private readonly db: InvoiceDatabase,
    private readonly files: ImportService,
    private readonly queue?: OcrQueue,
  ) {}

  detail(id: string): InvoiceDetail {
    const invoice = this.db.get(id)
    if (!invoice) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
    const ocrResults = this.db.getOcrResults(id)
    for (const result of ocrResults) {
      if (Object.values(result.evidence).some(value => value && !value.region)) {
        try { result.evidence = reparseOcrResponse(result.rawResponse).evidence } catch { /* Keep old evidence if an external response cannot be reparsed. */ }
      }
    }
    return { invoice, revision: dataRevision(invoice), fieldRevision: fieldRevision(invoice), ocrResults, duplicates: this.db.getDuplicates(id) }
  }

  save(id: string, fields: InvoiceFields, confirm: boolean, expectedRevision?: string, expectedFieldRevision?: string): InvoiceDetail {
    if (expectedRevision && dataRevision(this.db.get(id)) !== expectedRevision) throw new AppError('DATA_CONFLICT', '发票已在其他位置更新，请重新载入后再保存')
    if (expectedFieldRevision && fieldRevision(this.db.get(id)) !== expectedFieldRevision) throw new AppError('DATA_CONFLICT', '发票字段已在其他位置更新，请重新载入后再保存')
    this.db.updateFields(id, fields, confirm)
    return this.detail(id)
  }

  applyOcr(invoiceId: string, resultId: string): InvoiceDetail {
    const result = this.db.getOcrResults(invoiceId).find((item) => item.id === resultId)
    if (!result) throw new AppError('OCR_RESULT_NOT_FOUND', '识别结果不存在')
    const reparsed = reparseOcrResponse(result.rawResponse)
    this.db.applyOcrResult(invoiceId, resultId, {
      rawResponse: result.rawResponse,
      normalizedText: reparsed.normalizedText,
      parsedFields: reparsed.fields,
      evidence: reparsed.evidence,
      warnings: reparsed.warnings,
    })
    return this.detail(invoiceId)
  }

  deleteInvoices(ids: string[]): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    return this.db.softDelete(ids)
  }

  restoreInvoices(ids: string[]): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    const restoring = [...new Set(ids)].filter((id) => this.db.get(id)?.deletedAt)
    if (!restoring.length) return 0
    const count = this.db.restore(restoring)
    for (const id of restoring) {
      if (['pending', 'queued'].includes(this.db.get(id)!.ocrStatus)) this.queue?.retry(id)
    }
    return count
  }

  async purgeInvoices(ids: string[]): Promise<number> {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    const storagePaths = this.db.purge(ids)
    await Promise.all(storagePaths.map((path) => unlink(this.files.resolveStoragePath(path)).catch(() => undefined)))
    return storagePaths.length
  }

  confirmInvoices(ids: string[]): BatchConfirmResult {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    return this.db.batchConfirm(ids)
  }

  retryOcrInvoices(ids: string[]): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    if (!this.queue) return 0
    let enqueued = 0
    for (const id of ids) {
      const invoice = this.db.get(id)
      if (!invoice || invoice.deletedAt || invoice.ocrStatus === 'running') continue
      if (this.queue.retry(id)) enqueued += 1
    }
    return enqueued
  }

  setInvoicesStatus(ids: string[], status: InvoiceStatus): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    return this.db.batchSetStatus(ids, status)
  }

  setInvoiceTags(invoiceId: string, tags: string[]): void {
    this.db.setInvoiceTags(invoiceId, tags)
  }

  addInvoicesTags(ids: string[], tags: string[]): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    for (const id of ids) {
      const invoice = this.db.get(id)
      if (!invoice || invoice.deletedAt) throw new AppError('INVOICE_NOT_FOUND', '发票不存在或已移入回收站，请刷新后重试')
      if (new Set([...invoice.tags, ...tags]).size > 20) throw new AppError('TAG_LIMIT', '单张发票最多保留 20 个标签，请先移除部分标签')
    }
    return this.db.addInvoicesTags(ids, tags)
  }

  removeInvoicesTags(ids: string[], tags: string[]): number {
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    return this.db.removeInvoicesTags(ids, tags)
  }

  getTags(): string[] {
    return this.db.getTags()
  }
}
