import type { InvoiceFields } from './contracts'

function normalizeIdentifier(value: string): string {
  return value.normalize('NFKC').replace(/[\s-]/g, '').toUpperCase()
}

export function buildBusinessKey(fields: Pick<InvoiceFields, 'invoiceCode' | 'invoiceNumber' | 'invoiceDate' | 'sellerTaxId'>): string | null {
  const code = normalizeIdentifier(fields.invoiceCode)
  const number = normalizeIdentifier(fields.invoiceNumber)
  if (!number) return null
  if (code) return `code:${code}:number:${number}`
  if (/^\d{20}$/.test(number)) return `number:${number}`
  const sellerTaxId = normalizeIdentifier(fields.sellerTaxId)
  if (sellerTaxId && fields.invoiceDate) {
    return `number:${number}:seller:${sellerTaxId}:date:${fields.invoiceDate}`
  }
  return null
}
