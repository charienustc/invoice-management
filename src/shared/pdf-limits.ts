export const MAX_PDF_PAGES = 20
export const MAX_PDF_PAGE_PIXELS = 16_000_000
export const MAX_PDF_TOTAL_PIXELS = 80_000_000
export const MAX_PDF_EDGE = 16_384

export function checkPdfDimensions(width: number, height: number): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || width > MAX_PDF_EDGE || height > MAX_PDF_EDGE || width * height > MAX_PDF_PAGE_PIXELS) {
    throw new Error('PDF 页面尺寸过大或无效，请缩小页面后重试')
  }
}
