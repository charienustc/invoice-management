import type { OcrLine } from './response-adapter'

export function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/[\t\r ]+/g, ' ').trim()
}

export function normalizeLines(lines: OcrLine[]): OcrLine[] {
  return lines.map((line) => ({ ...line, text: normalizeText(line.text) })).filter((line) => line.text)
}
