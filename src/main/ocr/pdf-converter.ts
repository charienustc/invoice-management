import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { AppError } from '@shared/errors'
import { MAX_PDF_PAGES, MAX_PDF_EDGE, MAX_PDF_PAGE_PIXELS, MAX_PDF_TOTAL_PIXELS } from '@shared/pdf-limits'

/** Parse untrusted PDFs outside the app process; kill stalled/native decoders. */
export async function convertPdfToPng(data: Buffer, timeoutMs = 30_000): Promise<Buffer[]> {
  if (data.length > 25 * 1024 * 1024) throw new AppError('PDF_TOO_LARGE', 'PDF 文件不能超过 25 MB')
  return new Promise((resolve, reject) => {
    const worker = fileURLToPath(new URL('./pdf-worker.mjs', import.meta.url))
    const limits = { pages: MAX_PDF_PAGES, edge: MAX_PDF_EDGE, pagePixels: MAX_PDF_PAGE_PIXELS, totalPixels: MAX_PDF_TOTAL_PIXELS }
    const child = spawn(process.execPath, ['--max-old-space-size=512', worker, JSON.stringify(limits)], {
      windowsHide: true, shell: false, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
    })
    const chunks: Buffer[] = []
    let bytes = 0, settled = false
    const fail = (error: Error) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); reject(error) }
    const timer = setTimeout(() => fail(new AppError('PDF_TIMEOUT', 'PDF 处理超时，请检查文件或拆分页面后重试')), timeoutMs)
    child.once('error', () => fail(new AppError('PDF_PROCESS_ERROR', '无法启动 PDF 处理进程')))
    child.stdin.on('error', () => {})
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 160 * 1024 * 1024) fail(new AppError('PDF_TOO_LARGE', 'PDF 转图数据过大，请拆分文件后重试')); else chunks.push(chunk) })
    child.once('close', code => {
      if (settled) return
      try {
        if (code !== 0) throw new Error()
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { images?: string[]; error?: { code: string; message: string } }
        if (result.error) { fail(new AppError(result.error.code, result.error.message)); return }
        if (!Array.isArray(result.images) || result.images.length > MAX_PDF_PAGES || result.images.some(image => typeof image !== 'string')) throw new Error()
        settled = true; clearTimeout(timer); resolve(result.images.map(image => Buffer.from(image, 'base64')))
      } catch { fail(new AppError('PDF_RENDER_ERROR', 'PDF 无法解析，请检查文件是否损坏或加密')) }
    })
    child.stdin.end(data)
  })
}
