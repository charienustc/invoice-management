import type { OcrConnectionResult, OcrSettings } from '@shared/contracts'
import { AppError } from '@shared/errors'
import { createCanvas } from '@napi-rs/canvas'
import { adaptOcrResponse } from './response-adapter'
import { BuiltinOcrEngine } from './builtin-engine'

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
const TEST_PNG = (() => {
  const canvas = createCanvas(64, 64)
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, 64, 64)
  return canvas.toBuffer('image/png')
})()

export class OcrRequestError extends AppError {
  constructor(code: string, message: string, public readonly retryable: boolean) {
    super(code, message)
    this.name = 'OcrRequestError'
  }
}

export interface OcrUpload {
  data: Buffer
  fileName: string
  mimeType: string
}

export class OcrClient {
  constructor(private readonly builtin?: BuiltinOcrEngine) {}

  async recognize(upload: OcrUpload, settings: OcrSettings): Promise<unknown> {
    if (settings.engineMode === 'builtin') {
      if (!this.builtin) throw new AppError('OCR_NOT_AVAILABLE', '内置 OCR 未初始化')
      return this.builtin.recognize(upload.data, settings.timeoutMs)
    }
    if (!settings.endpoint) throw new AppError('OCR_NOT_CONFIGURED', '请先在设置页填写 PaddleOCR 服务地址')
    const isPaddleX = settings.requestProtocol === 'paddlex-json'
    const body = isPaddleX
      ? JSON.stringify({ file: upload.data.toString('base64'), fileType: upload.mimeType === 'application/pdf' ? 0 : 1 })
      : (() => {
          const form = new FormData()
          form.append(settings.fileField, new Blob([new Uint8Array(upload.data)], { type: upload.mimeType }), upload.fileName)
          return form
        })()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), settings.timeoutMs)
    try {
      const response = await fetch(settings.endpoint, {
        method: 'POST',
        headers: isPaddleX ? { 'Content-Type': 'application/json' } : undefined,
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
      if (response.status >= 300 && response.status < 400) {
        throw new OcrRequestError('OCR_REDIRECT_REJECTED', 'OCR 服务返回重定向，请直接填写最终服务地址', false)
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500
        throw new OcrRequestError('OCR_HTTP_ERROR', `OCR 服务返回 HTTP ${response.status}`, retryable)
      }
      const contentLength = Number(response.headers.get('content-length') ?? 0)
      if (contentLength > MAX_RESPONSE_BYTES) throw new OcrRequestError('OCR_RESPONSE_TOO_LARGE', 'OCR 响应超过 10 MB 限制', false)
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new OcrRequestError('OCR_RESPONSE_TOO_LARGE', 'OCR 响应超过 10 MB 限制', false)
      try {
        const result = JSON.parse(Buffer.from(buffer).toString('utf8')) as unknown
        if (typeof result === 'object' && result !== null && 'errorCode' in result) {
          const errorCode = (result as { errorCode?: unknown }).errorCode
          if (typeof errorCode === 'number' && errorCode !== 0) {
            const errorMsg = 'errorMsg' in result && typeof result.errorMsg === 'string' ? result.errorMsg : '未知错误'
            throw new OcrRequestError('OCR_SERVICE_ERROR', `PaddleOCR 返回错误 ${errorCode}：${errorMsg}`, false)
          }
        }
        return result
      } catch (error) {
        if (error instanceof OcrRequestError) throw error
        throw new OcrRequestError('OCR_INVALID_JSON', 'OCR 服务未返回有效 JSON', false)
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      if (controller.signal.aborted) throw new OcrRequestError('OCR_TIMEOUT', `OCR 请求超过 ${settings.timeoutMs} ms`, true)
      throw new OcrRequestError('OCR_CONNECTION_ERROR', '无法连接 PaddleOCR 服务，请检查地址和服务状态', true)
    } finally {
      clearTimeout(timeout)
    }
  }

  async testConnection(settings: OcrSettings): Promise<OcrConnectionResult> {
    const started = Date.now()
    const raw = await this.recognize({ data: TEST_PNG, fileName: 'connection-test.png', mimeType: 'image/png' }, settings)
    const adapted = adaptOcrResponse(raw, settings.engineMode === 'builtin' ? 'lines' : settings.adapter)
    return { lineCount: adapted.lines.length, durationMs: Date.now() - started }
  }
}
