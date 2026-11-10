import { describe, expect, it } from 'vitest'
import { centsToDecimal, formatMoney, parseMoneyToCents } from '@shared/money'
import { buildBusinessKey } from '@shared/business-key'

describe('金额与业务键', () => {
  it('精确解析中文金额格式', () => {
    expect(parseMoneyToCents('￥1,234.50')).toBe(123450)
    expect(parseMoneyToCents('0.01')).toBe(1)
    expect(parseMoneyToCents('12.345')).toBeNull()
    expect(centsToDecimal(123450)).toBe('1234.50')
    expect(formatMoney(123450)).toContain('1,234.50')
  })

  it('按发票类型生成稳定业务键', () => {
    expect(buildBusinessKey({ invoiceCode: ' 011001900211 ', invoiceNumber: '12345678', invoiceDate: '', sellerTaxId: '' })).toBe('code:011001900211:number:12345678')
    expect(buildBusinessKey({ invoiceCode: '', invoiceNumber: '12345678901234567890', invoiceDate: '', sellerTaxId: '' })).toBe('number:12345678901234567890')
    expect(buildBusinessKey({ invoiceCode: '', invoiceNumber: '12345678', invoiceDate: '2026-11-04', sellerTaxId: '91310000ABCDEF1234' })).toContain(':seller:91310000ABCDEF1234:')
    expect(buildBusinessKey({ invoiceCode: '', invoiceNumber: '12345678', invoiceDate: '', sellerTaxId: '' })).toBeNull()
  })
})
