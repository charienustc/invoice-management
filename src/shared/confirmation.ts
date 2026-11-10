import type { InvoiceFields } from './contracts'

export function confirmationError(fields: InvoiceFields): string | null {
  const missing = [!fields.invoiceNumber.trim() && '发票号码', !fields.invoiceDate && '开票日期', fields.totalAmount === null && '价税合计'].filter(Boolean)
  if (missing.length) return `确认前请填写${missing.join('、')}`
  const date = new Date(`${fields.invoiceDate}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== fields.invoiceDate) return '开票日期不是有效日期'
  return null
}
