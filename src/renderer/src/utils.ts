import type { InvoiceStatus, OcrStatus, ReviewStatus } from '@shared/contracts'
import { INVOICE_STATUS_LABELS } from '@shared/labels'

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请稍后重试'
}

export const ocrStatusMeta: Record<OcrStatus, { text: string; type: 'info' | 'warning' | 'success' | 'danger' | 'primary' }> = {
  pending: { text: '等待识别', type: 'info' },
  queued: { text: '排队中', type: 'warning' },
  running: { text: '识别中', type: 'primary' },
  succeeded: { text: '识别完成', type: 'success' },
  failed: { text: '识别失败', type: 'danger' },
}

export const reviewStatusMeta: Record<ReviewStatus, { text: string; type: 'info' | 'warning' | 'success' }> = {
  unreviewed: { text: '未核对', type: 'info' },
  needs_review: { text: '待核对', type: 'warning' },
  confirmed: { text: '已确认', type: 'success' },
}

export const invoiceStatusMeta: Record<InvoiceStatus, { text: string; type: 'info' | 'success' | 'primary' | 'danger' }> = {
  unprocessed: { text: INVOICE_STATUS_LABELS.unprocessed, type: 'info' },
  reimbursed: { text: INVOICE_STATUS_LABELS.reimbursed, type: 'success' },
  booked: { text: INVOICE_STATUS_LABELS.booked, type: 'primary' },
  void: { text: INVOICE_STATUS_LABELS.void, type: 'danger' },
}
