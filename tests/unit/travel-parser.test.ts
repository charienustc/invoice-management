import { describe, expect, it } from 'vitest'
import { parseInvoiceLines } from '../../src/main/ocr/parser'

const parse = (...text: string[]) => parseInvoiceLines(text.map((text, id) => ({ id, text })))
describe('交通票据字段', () => {
  it('铁路客票区分开票日期、乘车日期及长电子客票号', () => {
    const result = parse('电子发票（铁路电子客票）', '发票号码：99000000123456789001',
      '开票日期：2026年10月19日', '2026年10月18日 14:33开', '票价：￥69.00',
      '电子客票号：9900000012345678901234567', '购买方名称：示例购买方大学', '统一社会信用代码：TESTBUYER0000000001')
    expect(result.fields).toMatchObject({ invoiceType: '电子发票（铁路电子客票）', invoiceNumber: '99000000123456789001',
      invoiceDate: '2026-10-19', totalAmount: 6900, buyerName: '示例购买方大学', buyerTaxId: 'TESTBUYER0000000001' })
    expect(result.fields.taxAmount).toBeUndefined()
    expect(result.fields.amountExcludingTax).toBeUndefined()
    expect(result.evidence.totalAmount?.rule).toBe('railway-fare')
    expect(result.warnings).toEqual([])
  })
  it('分开的票价标签按同一页同排寻找金额并保留坐标', () => {
    const box = (x: number, y: number) => [[x,y],[x+90,y],[x+90,y+20],[x,y+20]]
    const result = parseInvoiceLines([
      { id: 0, text: '铁路电子客票' }, { id: 1, text: '票价：', bbox: box(10,100), page: 1 },
      { id: 2, text: '999.00', bbox: box(120,100), page: 2 },
      { id: 3, text: '￥69.00', bbox: box(120,100), page: 1 },
    ])
    expect(result.fields.totalAmount).toBe(6900)
    expect(result.evidence.totalAmount?.region).toMatchObject({ page: 1, bbox: box(120,100) })
  })
  it('航空电子发票提取合计，不把票价和燃油附加费误当税前金额及税额', () => {
    const result = parse('电子发票（航空运输电子客票行程单）', '发票号码：99000000123456789002',
      '电子客票号：781-1234567890', '开票日期：2026年10月19日', '票价：800.00',
      '燃油附加费：40.00', '民航发展基金：50.00', '合计：CNY890.00', '税额：69.36')
    expect(result.fields).toMatchObject({ invoiceType: '电子发票（航空运输电子客票行程单）', invoiceNumber: '99000000123456789002', totalAmount: 89000, taxAmount: 6936 })
    expect(result.fields.amountExcludingTax).toBeUndefined()
  })
  it('旧航空行程单使用票号和填开日期，仅记录打印的合计', () => {
    expect(parse('航空运输电子客票行程单', '电子客票号码：781-1234567890', '日期 2026年10月18日',
      '填开日期：2026-10-19', '合计', '￥890.00', '销售单位：测试航空服务有限公司').fields)
      .toMatchObject({ invoiceNumber: '7811234567890', invoiceDate: '2026-10-19', totalAmount: 89000, sellerName: '测试航空服务有限公司' })
  })
  it('不能用乘车日期和电子客票长编号补造发票日期及号码', () => {
    const result = parse('铁路电子客票', '2026年10月18日 14:33开', '电子客票号：9900000012345678901234567', '票价：￥69')
    expect(result.fields.totalAmount).toBe(6900)
    expect(result.fields.invoiceNumber).toBeUndefined()
    expect(result.fields.invoiceDate).toBeUndefined()
  })
})
