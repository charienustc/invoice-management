import { expect, it } from 'vitest'
import { reparseOcrResponse } from '../../src/main/ocr/reparse'

it('多页识别保留原图尺寸和字段所在页，重解析后仍能定位', () => {
  const bbox = [[100, 200], [400, 200], [400, 240], [100, 240]]
  const result = reparseOcrResponse({ pages: [
    { response: { lines: [{ text: '发票号码：12345678', bbox }] }, imageSize: { width: 1200, height: 800 } },
    { response: { lines: [{ text: '小写：¥106.00', bbox }] }, imageSize: { width: 1000, height: 600 } },
  ] })
  expect(result.evidence.invoiceNumber?.region).toEqual({ page: 1, bbox, imageWidth: 1200, imageHeight: 800 })
  expect(result.evidence.totalAmount?.region).toEqual({ page: 2, bbox, imageWidth: 1000, imageHeight: 600 })
  expect(result.fields.totalAmount).toBe(10600)
})

it('旧响应保留坐标而不虚构尺寸，没有坐标的响应不会生成高亮位置', () => {
  expect(reparseOcrResponse({ lines: [{ text: '发票号码：12345678' }] }).evidence.invoiceNumber?.region).toBeUndefined()
  const result = reparseOcrResponse({ lines: [{ text: '发票号码：12345678', bbox: [[0, 0], [100, 0], [100, 30], [0, 30]] }] })
  expect(result.evidence.invoiceNumber?.region?.page).toBe(1)
  expect(result.evidence.invoiceNumber?.region?.imageWidth).toBeUndefined()
})
