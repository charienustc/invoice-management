import { adaptOcrResponse, type OcrLine } from './response-adapter'
import { parseInvoiceLines, type ParsedInvoice } from './parser'

export function reparseOcrResponse(rawResponse: unknown): ParsedInvoice {
  function pageLines(raw: unknown, page: number): OcrLine[] {
    const record = raw as { response?: unknown; imageSize?: { width: number; height: number } } | null
    const wrapped = record && typeof record === 'object' && 'response' in record && record.imageSize
    return adaptOcrResponse(wrapped ? record.response : raw).lines.map(line => ({ ...line, page,
      imageWidth: wrapped ? record.imageSize?.width : undefined, imageHeight: wrapped ? record.imageSize?.height : undefined }))
  }
  let lines: OcrLine[]
  if (typeof rawResponse === 'object' && rawResponse !== null && 'pages' in rawResponse && Array.isArray(rawResponse.pages)) {
    lines = rawResponse.pages.flatMap((page, pageIndex) => pageLines(page, pageIndex + 1))
  } else {
    lines = pageLines(rawResponse, 1)
  }
  return parseInvoiceLines(lines.map((line, id) => ({ ...line, id })))
}
