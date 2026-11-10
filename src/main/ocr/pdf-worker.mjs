// Standalone Electron/Node subprocess. Do not log invoice content to stdout.
import { createCanvas, GlobalFonts } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
const require = createRequire(import.meta.url)
const resources = dirname(require.resolve('pdfjs-dist/package.json'))
const limits = JSON.parse(process.argv[2])
const resource = name => `${join(resources, name)}${sep}`.replaceAll('\\', '/')
// Native canvas generic-family fallback can select a Latin font on Windows
// Server even when a CJK font is installed. Match PDF.js' STSong substitution
// explicitly, so non-embedded Chinese glyphs do not become empty boxes.
const serif = ['SimSun', 'Noto Serif CJK SC', 'Songti SC'].find(name => GlobalFonts.has(name))
const sans = ['Microsoft YaHei', 'Noto Sans CJK SC', 'PingFang SC'].find(name => GlobalFonts.has(name))
if (serif) for (const alias of ['serif', 'STSong', 'STSong-Light']) GlobalFonts.setAlias(serif, alias)
if (sans) GlobalFonts.setAlias(sans, 'sans-serif')
function check(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > limits.edge || height > limits.edge || width * height > limits.pagePixels) {
    throw Object.assign(new Error('PDF 页面尺寸过大或无效，请缩小页面后重试'), { code: 'PDF_TOO_LARGE' })
  }
}
class CanvasFactory {
  getNoAlphaContext(canvas) { return canvas.getContext('2d', { alpha: false }) }
  create(width, height) { width = Math.ceil(width); height = Math.ceil(height); check(width, height); const canvas = createCanvas(width, height); return { canvas, context: canvas.getContext('2d') } }
  reset(pair, width, height) { check(Math.ceil(width), Math.ceil(height)); pair.canvas.width = Math.ceil(width); pair.canvas.height = Math.ceil(height) }
  destroy(pair) { pair.canvas.width = 0; pair.canvas.height = 0 }
}
const chunks = []
let bytes = 0
for await (const chunk of process.stdin) { bytes += chunk.length; if (bytes > 25 * 1024 * 1024) process.exit(1); chunks.push(chunk) }
const write = value => process.stdout.write(JSON.stringify(value))
let document
try {
  document = await getDocument({ data: new Uint8Array(Buffer.concat(chunks)), CanvasFactory,
    standardFontDataUrl: resource('standard_fonts'), cMapUrl: resource('cmaps'), cMapPacked: true,
    wasmUrl: resource('wasm'), useSystemFonts: true, verbosity: 0 }).promise
  if (document.numPages > limits.pages) throw Object.assign(new Error('单个 PDF 最多支持 20 页'), { code: 'PDF_TOO_MANY_PAGES' })
  const images = [], factory = new CanvasFactory()
  let total = 0
  for (let number = 1; number <= document.numPages; number++) {
    const page = await document.getPage(number), base = page.getViewport({ scale: 1 })
    check(base.width, base.height)
    const viewport = page.getViewport({ scale: Math.min(2, 2200 / base.width) })
    check(Math.ceil(viewport.width), Math.ceil(viewport.height))
    total += Math.ceil(viewport.width) * Math.ceil(viewport.height)
    if (total > limits.totalPixels) throw Object.assign(new Error('PDF 页面合计过大，请拆分文件后重试'), { code: 'PDF_TOO_LARGE' })
    const pair = factory.create(viewport.width, viewport.height)
    await page.render({ canvas: pair.canvas, canvasContext: pair.context, viewport }).promise
    images.push(pair.canvas.toBuffer('image/png').toString('base64'))
    factory.destroy(pair); page.cleanup()
  }
  write({ images })
} catch (error) { write({ error: { code: error.code || 'PDF_RENDER_ERROR', message: error.code ? error.message : 'PDF 无法解析，请检查文件是否损坏或加密' } }) }
finally { await document?.loadingTask.destroy() }
