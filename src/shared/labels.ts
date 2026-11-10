import type { InvoiceStatus, ReviewStatus, OcrStatus } from './contracts'
export const OCR_STATUS_LABELS: Record<OcrStatus, string> = { pending: '待识别', queued: '排队中', running: '识别中', succeeded: '识别成功', failed: '识别失败' }

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  unprocessed: '未处理',
  reimbursed: '已报销',
  booked: '已提交',
  void: '已作废',
}

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  unreviewed: '未核对',
  needs_review: '待核对',
  confirmed: '已确认',
}
