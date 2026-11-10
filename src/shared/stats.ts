import type { InvoiceStats } from './contracts'

export function monthSeries(rows: InvoiceStats['monthly'], mode: 'recent' | 'all', dateFrom?: string, dateTo?: string): InvoiceStats['monthly'] {
  if (!rows.length) return []
  if (mode === 'all') return rows
  const number = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 1
  const end = number(dateTo || rows[rows.length - 1].month)
  const start = Math.max(end - 11, dateFrom ? number(dateFrom) : end - 11)
  const indexed = new Map(rows.map(row => [row.month, row]))
  const result: InvoiceStats['monthly'] = []
  for (let month = start; month <= end; month++) {
    const key = `${String(Math.floor(month / 12)).padStart(4, '0')}-${String(month % 12 + 1).padStart(2, '0')}`
    result.push(indexed.get(key) ?? { month: key, invoiceCount: 0, totalAmount: 0, taxAmount: 0 })
  }
  return result
}

export function monthDates(month: string): [string, string] {
  const first = `${month}-01`
  const last = new Date(`${first}T12:00:00Z`)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  return [first, last.toISOString().slice(0, 10)]
}
