import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { AddressInfo } from 'node:net'
import { OcrClient } from '../../src/main/ocr/client'
import { adaptOcrResponse } from '../../src/main/ocr/response-adapter'
import { DEFAULT_OCR_SETTINGS as BUILTIN_OCR_SETTINGS } from '@shared/contracts'

const DEFAULT_OCR_SETTINGS = { ...BUILTIN_OCR_SETTINGS, engineMode: 'external' as const }

let server: Server
let endpoint: string
let requests: Array<{ headers: Record<string, string | string[] | undefined>; body: Buffer }>
let behavior: (body: Buffer) => { status?: number; body: string; delay?: number }

beforeEach(async () => {
  requests = []
  behavior = () => ({ body: JSON.stringify({ lines: [{ text: '测试' }] }) })
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks)
      requests.push({ headers: request.headers, body })
      const result = behavior(body)
      setTimeout(() => {
        response.writeHead(result.status ?? 200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(result.body) })
        response.end(result.body)
      }, result.delay ?? 0)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ocr`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('OCR multipart 客户端', () => {
  it('发送配置文件字段、文件名和真实文件内容', async () => {
    const client = new OcrClient()
    const result = await client.recognize({ data: Buffer.from('image-content'), fileName: 'invoice.png', mimeType: 'image/png' }, { ...DEFAULT_OCR_SETTINGS, endpoint, fileField: 'upload', requestProtocol: 'multipart' })
    expect(result).toEqual({ lines: [{ text: '测试' }] })
    const request = requests[0]
    expect(String(request.headers['content-type'])).toContain('multipart/form-data')
    expect(request.body.toString('utf8')).toContain('name="upload"')
    expect(request.body.toString('utf8')).toContain('filename="invoice.png"')
    expect(request.body.toString('utf8')).toContain('image-content')
  })

  it('区分可重试服务错误与不可重试响应错误', async () => {
    behavior = () => ({ status: 500, body: '{}' })
    const client = new OcrClient()
    await expect(client.recognize({ data: Buffer.from('x'), fileName: 'a.png', mimeType: 'image/png' }, { ...DEFAULT_OCR_SETTINGS, endpoint })).rejects.toMatchObject({ retryable: true })
    behavior = () => ({ body: 'not-json' })
    await expect(client.recognize({ data: Buffer.from('x'), fileName: 'a.png', mimeType: 'image/png' }, { ...DEFAULT_OCR_SETTINGS, endpoint })).rejects.toMatchObject({ code: 'OCR_INVALID_JSON', retryable: false })
  })

  it('按 PaddleX 原生协议发送 Base64 并展开响应', async () => {
    behavior = () => ({ body: JSON.stringify({ errorCode: 0, result: { ocrResults: [{ prunedResult: { rec_texts: ['原生文本'] } }] } }) })
    const client = new OcrClient()
    const content = Buffer.from('native-content')
    const raw = await client.recognize({ data: content, fileName: 'invoice.png', mimeType: 'image/png' }, { ...DEFAULT_OCR_SETTINGS, endpoint })
    const body = JSON.parse(requests[0].body.toString('utf8')) as { file: string; fileType: number }
    expect(body.file).toBe(content.toString('base64'))
    expect(body.fileType).toBe(1)
    expect(requests[0].headers['content-type']).toBe('application/json')
    expect(adaptOcrResponse(raw).lines[0].text).toBe('原生文本')
  })

  it('超时返回稳定错误码', async () => {
    behavior = () => ({ body: '{}', delay: 100 })
    const client = new OcrClient()
    const promise = client.recognize({ data: Buffer.from('x'), fileName: 'a.png', mimeType: 'image/png' }, { ...DEFAULT_OCR_SETTINGS, endpoint, timeoutMs: 20 })
    await expect(promise).rejects.toEqual(expect.objectContaining({ code: 'OCR_TIMEOUT', retryable: true }))
  })
})
