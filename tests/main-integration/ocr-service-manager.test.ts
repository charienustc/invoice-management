import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { OcrServiceManager } from '../../src/main/services/ocr-service-manager'
import { OcrClient } from '../../src/main/ocr/client'
import { adaptOcrResponse } from '../../src/main/ocr/response-adapter'
import { DEFAULT_OCR_SETTINGS as BUILTIN_OCR_SETTINGS } from '@shared/contracts'

const DEFAULT_OCR_SETTINGS = { ...BUILTIN_OCR_SETTINGS, engineMode: 'external' as const }

let manager: OcrServiceManager | undefined
afterEach(async () => { await manager?.stop() })

async function availablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe('OCR 服务自动启动与健康检测', () => {
  it('拉活服务、避免重复启动、完成原生识别并清理子进程', async () => {
    const port = await availablePort()
    const settings = {
      ...DEFAULT_OCR_SETTINGS,
      endpoint: `http://127.0.0.1:${port}/ocr`,
      startupExecutable: process.execPath,
      startupArgs: [resolve('tests/fixtures/ocr/mock-server.mjs'), String(port)],
      startupTimeoutMs: 10_000,
    }
    manager = new OcrServiceManager()
    await manager.configure(settings)
    const started = await manager.ensure()
    expect(started).toMatchObject({ state: 'online', managedByApp: true })
    expect(started.pid).toBeGreaterThan(0)

    const duplicate = await manager.start()
    expect(duplicate.pid).toBe(started.pid)
    const raw = await new OcrClient().recognize({ data: Buffer.from('test-image'), fileName: 'test.png', mimeType: 'image/png' }, settings)
    expect(adaptOcrResponse(raw).lines[0].text).toContain('模拟识别')

    await manager.stop()
    expect((await manager.check()).state).toBe('offline')
  }, 20_000)
})
