import { describe, expect, it } from 'vitest'
import { adaptOcrResponse } from '../../src/main/ocr/response-adapter'

describe('OCR 响应适配', () => {
  it('适配通用 lines 并按坐标排序', () => {
    const result = adaptOcrResponse({ lines: [
      { text: '第二行', bbox: [[0, 30], [20, 30], [20, 40], [0, 40]], confidence: 0.8 },
      { text: '第一行', bbox: [[0, 0], [20, 0], [20, 10], [0, 10]] },
    ] })
    expect(result.lines.map((line) => line.text)).toEqual(['第一行', '第二行'])
    expect(result.lines.map((line) => line.id)).toEqual([0, 1])
  })

  it('适配 PaddleX 和旧版 PaddleOCR', () => {
    expect(adaptOcrResponse({ result: { rec_texts: ['发票号码', '12345678'], rec_scores: [0.9, 0.95] } }).lines).toHaveLength(2)
    const legacy = [[[[0, 0], [10, 0], [10, 10], [0, 10]], ['开票日期', 0.99]]]
    expect(adaptOcrResponse(legacy).lines[0]).toMatchObject({ text: '开票日期', confidence: 0.99 })
  })

  it('展开 PaddleX 原生 ocrResults.prunedResult', () => {
    const raw = { errorCode: 0, result: { ocrResults: [{ prunedResult: { rec_texts: ['原生服务文本'], rec_scores: [0.99] } }] } }
    expect(adaptOcrResponse(raw).lines[0]).toMatchObject({ text: '原生服务文本', confidence: 0.99 })
  })

  it('未知结构明确报错', () => {
    expect(() => adaptOcrResponse({ unexpected: true })).toThrow('无法识别')
  })
})
