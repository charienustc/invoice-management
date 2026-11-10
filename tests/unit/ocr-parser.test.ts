import { describe, expect, it } from 'vitest'
import { parseInvoiceLines } from '../../src/main/ocr/parser'
import { adaptOcrResponse } from '../../src/main/ocr/response-adapter'

const lines = [
  '电子发票（增值税专用发票）',
  '发票代码：011001900211',
  '发票号码：12345678',
  '开票日期：2026年11月04日',
  '购买方',
  '名称：测试购买方有限公司',
  '统一社会信用代码/纳税人识别号：91310000ABCDEF1234',
  '销售方',
  '名称：测试销售方有限公司',
  '纳税人识别号：91320000ZYXWVU9876',
  '合 计 ￥100.00 ￥6.00',
  '价税合计（大写）壹佰零陆圆整（小写）￥106.00',
].map((text, id) => ({ id, text, confidence: 0.98 }))

describe('国内发票字段解析', () => {
  it('提取关键字段、购销方与金额证据', () => {
    const result = parseInvoiceLines(lines)
    expect(result.fields).toMatchObject({
      invoiceType: '增值税专用发票', invoiceCode: '011001900211', invoiceNumber: '12345678',
      invoiceDate: '2026-11-04', buyerName: '测试购买方有限公司', sellerName: '测试销售方有限公司',
      amountExcludingTax: 10000, taxAmount: 600, totalAmount: 10600,
    })
    expect(result.evidence.invoiceNumber?.lineId).toBe(2)
    expect(result.warnings).toEqual([])
  })

  it('同一行包含双方信息时不会串区', () => {
    const result = parseInvoiceLines([
      { id: 0, text: '购买方 名称：甲方公司 纳税人识别号：91310000ABCDEF1234 销售方 名称：乙方公司 纳税人识别号：91320000ZYXWVU9876' },
    ])
    expect(result.fields.buyerName).toBe('甲方公司')
    expect(result.fields.sellerName).toBe('乙方公司')
    expect(result.fields.buyerTaxId).toBe('91310000ABCDEF1234')
    expect(result.fields.sellerTaxId).toBe('91320000ZYXWVU9876')
  })

  it('兼容合成电子普通发票的误识别、双栏税号和跨行合计', () => {
    const box = (x: number) => [[x, 0], [x + 10, 0], [x + 10, 10], [x, 10]]
    const result = parseInvoiceLines([
      { id: 0, text: '电子发统(普通发票)' },
      { id: 1, text: '发票号码：99000000987654321001' },
      { id: 2, text: '开票日期：2026年10月19日' },
      { id: 3, text: '购买方信息', bbox: box(2) },
      { id: 4, text: '名称：示例购买方大学', bbox: box(41) },
      { id: 5, text: '销售方信息', bbox: box(601) },
      { id: 6, text: '名称：示例销售方科技有限公司', bbox: box(635) },
      { id: 7, text: '统一社会信用代码/纳税人识别号：TESTBUYER0000000001', bbox: box(41) },
      { id: 8, text: '统一社会信用代码/纳税人识别号：TESTSELLER000000001', bbox: box(631) },
      { id: 9, text: '合' },
      { id: 10, text: '计' },
      { id: 11, text: '¥47.38' },
      { id: 12, text: '¥1.42' },
      { id: 13, text: '（小写）¥48.80' },
    ])
    expect(result.fields).toMatchObject({
      invoiceType: '电子发票（普通发票）',
      buyerTaxId: 'TESTBUYER0000000001',
      sellerTaxId: 'TESTSELLER000000001',
      amountExcludingTax: 4738,
      taxAmount: 142,
      totalAmount: 4880,
    })
  })

  it('坐标重排后仍按列归属购销方名称和税号', () => {
    const box = (x: number, y: number) => [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]]
    const raw = { lines: [
      { text: '购买方信息', bbox: box(2, 155) },
      { text: '名称：示例购买方大学', bbox: box(41, 165) },
      { text: '销售方信息', bbox: box(601, 157) },
      { text: '名称：示例销售方科技有限公司', bbox: box(635, 170) },
      { text: '纳税人识别号：TESTBUYER0000000001', bbox: box(41, 236) },
      { text: '纳税人识别号：TESTSELLER000000001', bbox: box(631, 239) },
    ] }
    const result = parseInvoiceLines(adaptOcrResponse(raw).lines)
    expect(result.fields).toMatchObject({
      buyerName: '示例购买方大学',
      sellerName: '示例销售方科技有限公司',
      buyerTaxId: 'TESTBUYER0000000001',
      sellerTaxId: 'TESTSELLER000000001',
    })
  })

  it('金额不平衡和缺字段会给出警告', () => {
    const result = parseInvoiceLines([
      { id: 0, text: '不含税金额：100.00' },
      { id: 1, text: '税额：6.00' },
      { id: 2, text: '价税合计（小写）：999.00' },
    ])
    expect(result.warnings.some((warning) => warning.includes('不一致'))).toBe(true)
    expect(result.warnings.some((warning) => warning.includes('发票号码'))).toBe(true)
  })

  it.each([-2, 0, 2])('倾斜 %s 度的双栏名称与分割合计按版式解析', (degrees) => {
    const angle = degrees * Math.PI / 180
    const box = (x: number, y: number, w = 180, h = 20) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
      .map(([px, py]) => [px * Math.cos(angle) - py * Math.sin(angle), px * Math.sin(angle) + py * Math.cos(angle)])
    const result = parseInvoiceLines(adaptOcrResponse({ lines: [
      { text: '购买方信息', bbox: box(10, 140, 20, 100) },
      { text: '名称：甲公司', bbox: box(50, 170) },
      { text: '销售方信息', bbox: box(580, 140, 20, 100) },
      { text: '名称：乙公司', bbox: box(620, 170) },
      { text: '合', bbox: box(80, 300, 20) }, { text: '计', bbox: box(140, 300, 20) },
      { text: '¥100.00', bbox: box(650, 300, 90) }, { text: '¥6.00', bbox: box(850, 300, 90) },
      { text: '价税合计（小写）¥106.00', bbox: box(600, 350, 340) },
    ] }).lines)
    expect(result.fields).toMatchObject({ buyerName: '甲公司', sellerName: '乙公司', amountExcludingTax: 10000, taxAmount: 600, totalAmount: 10600 })
  })

  it('合计标签缺字时必须有同排金额且与价税合计相符', () => {
    const box = (x: number, y: number) => [[x, y], [x + 80, y], [x + 80, y + 20], [x, y + 20]]
    const values = [
      { text: '计', bbox: box(10, 100) },
      { text: '¥100.00', bbox: box(200, 100) }, { text: '¥6.00', bbox: box(400, 100) },
    ]
    const parse = (total: string) => parseInvoiceLines(adaptOcrResponse({ lines: [...values, { text: `小写：¥${total}`, bbox: box(200, 150) }] }).lines)
    expect(parse('106.00').fields).toMatchObject({ amountExcludingTax: 10000, taxAmount: 600 })
    expect(parse('999.00').fields.amountExcludingTax).toBeUndefined()
    expect(parseInvoiceLines(adaptOcrResponse({ lines: values }).lines).fields.taxAmount).toBeUndefined()
  })
})
