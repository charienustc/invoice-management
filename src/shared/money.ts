export function parseMoneyToCents(value: string): number | null {
  const normalized = value.normalize('NFKC').replace(/[,，¥￥\s]/g, '')
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return null
  const negative = normalized.startsWith('-')
  const unsigned = negative ? normalized.slice(1) : normalized
  const [whole, fraction = ''] = unsigned.split('.')
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) return null
  return negative ? -cents : cents
}

export function formatMoney(cents: number | null): string {
  if (cents === null) return '—'
  return (cents / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function centsToDecimal(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2)
}
