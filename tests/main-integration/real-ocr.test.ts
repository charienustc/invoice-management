import { afterEach, describe, expect, it } from 'vitest'
import { OcrServiceManager } from '../../src/main/services/ocr-service-manager'
import { OcrClient } from '../../src/main/ocr/client'
import { DEFAULT_OCR_SETTINGS as BUILTIN_OCR_SETTINGS } from '@shared/contracts'

const DEFAULT_OCR_SETTINGS = { ...BUILTIN_OCR_SETTINGS, engineMode: 'external' as const }

let manager: OcrServiceManager | undefined
afterEach(async () => { await manager?.stop() })

describe('本机真实 PaddleOCR 服务', () => {
  it.runIf(process.env.REAL_OCR_TEST === '1')('自动启动、健康检查并识别内置测试图片', async () => {
    manager = new OcrServiceManager()
    await manager.configure(DEFAULT_OCR_SETTINGS)
    const status = await manager.ensure()
    expect(status.state).toBe('online')
    try {
      const result = await new OcrClient().testConnection(DEFAULT_OCR_SETTINGS)
      expect(result.lineCount).toBeGreaterThanOrEqual(0)
    } catch (error) {
      console.error('PaddleOCR service logs', manager.getRecentLogs())
      throw error
    }
  }, 240_000)
})
