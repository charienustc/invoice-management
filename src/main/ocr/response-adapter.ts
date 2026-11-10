import type { OcrSettings } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { measureLayout } from './layout'

export interface OcrLine {
  id: number
  text: string
  confidence?: number
  bbox?: number[][]
  page?: number
  imageWidth?: number
  imageHeight?: number
}

export interface NormalizedOcrResult {
  lines: OcrLine[]
  warnings: string[]
  rawResponse: unknown
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBox(value: unknown): number[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const points = value.flatMap((point) => {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return []
    return [[point[0], point[1]]]
  })
  return points.length >= 4 ? points : undefined
}

function sortLines(lines: OcrLine[]): OcrLine[] {
  const layout = measureLayout(lines)
  return [...lines].sort((a, b) => {
    if ((a.page ?? 0) !== (b.page ?? 0)) return (a.page ?? 0) - (b.page ?? 0)
    if (!a.bbox || !b.bbox) return a.id - b.id
    const ay = layout.get(a)!.top
    const by = layout.get(b)!.top
    if (Math.abs(ay - by) > 8) return ay - by
    return layout.get(a)!.left - layout.get(b)!.left
  }).map((line, id) => ({ ...line, id }))
}

function fromLines(value: UnknownRecord): OcrLine[] | null {
  if (!Array.isArray(value.lines)) return null
  const lines: OcrLine[] = []
  for (const item of value.lines) {
    if (!isRecord(item) || typeof item.text !== 'string') return null
    lines.push({
      id: lines.length,
      text: item.text,
      confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
      bbox: normalizeBox(item.bbox),
      page: typeof item.page === 'number' ? item.page : undefined,
    })
  }
  return lines
}

function fromPaddleX(value: UnknownRecord): OcrLine[] | null {
  if (!Array.isArray(value.rec_texts) || !value.rec_texts.every((text) => typeof text === 'string')) return null
  const scores = Array.isArray(value.rec_scores) ? value.rec_scores : []
  const boxes = Array.isArray(value.rec_polys) ? value.rec_polys : Array.isArray(value.dt_polys) ? value.dt_polys : []
  return value.rec_texts.map((text, index) => ({
    id: index,
    text,
    confidence: typeof scores[index] === 'number' ? scores[index] as number : undefined,
    bbox: normalizeBox(boxes[index]),
  }))
}

function fromLegacyPaddle(value: unknown): OcrLine[] | null {
  if (!Array.isArray(value)) return null
  const lines: OcrLine[] = []
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) {
      return value.length === 1 ? fromLegacyPaddle(value[0]) : null
    }
    const recognition = item[1]
    if (!Array.isArray(recognition) || typeof recognition[0] !== 'string') {
      return value.length === 1 ? fromLegacyPaddle(value[0]) : null
    }
    lines.push({
      id: lines.length,
      text: recognition[0],
      confidence: typeof recognition[1] === 'number' ? recognition[1] : undefined,
      bbox: normalizeBox(item[0]),
    })
  }
  return lines
}

function candidates(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [raw]
  const values: unknown[] = [raw]
  for (const key of ['result', 'data', 'ocr', 'prunedResult']) {
    const nested = raw[key]
    if (nested !== undefined) values.push(nested)
    if (Array.isArray(nested)) values.push(...nested)
  }
  for (const container of [raw, isRecord(raw.result) ? raw.result : undefined]) {
    if (!container || !Array.isArray(container.ocrResults)) continue
    values.push(...container.ocrResults)
    for (const item of container.ocrResults) {
      if (isRecord(item) && item.prunedResult !== undefined) values.push(item.prunedResult)
    }
  }
  return values
}

export function adaptOcrResponse(rawResponse: unknown, adapter: OcrSettings['adapter'] = 'auto'): NormalizedOcrResult {
  for (const candidate of candidates(rawResponse)) {
    let lines: OcrLine[] | null = null
    if (adapter !== 'paddle' && isRecord(candidate)) lines = fromLines(candidate)
    if (!lines && adapter !== 'lines') {
      lines = fromLegacyPaddle(candidate)
      if (!lines && isRecord(candidate)) lines = fromPaddleX(candidate)
    }
    if (lines) return { lines: sortLines(lines), warnings: [], rawResponse }
  }
  throw new AppError('OCR_SCHEMA_UNSUPPORTED', '无法识别 PaddleOCR 响应结构，请提供响应示例以补充适配器')
}
