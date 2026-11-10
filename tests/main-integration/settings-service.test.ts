import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SettingsService } from '../../src/main/services/settings-service'
import { DEFAULT_OCR_SETTINGS } from '@shared/contracts'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'invoice-settings-test-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('OCR 设置迁移', () => {
  it('新安装使用内置识别且不带个人电脑启动路径', async () => {
    expect(await new SettingsService(directory).get()).toMatchObject({ engineMode: 'builtin', startupExecutable: '' })
  })
  it('已有外部服务升级后保留配置，切换内置再读写也保留外部参数', async () => {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ endpoint: 'http://127.0.0.1:4567/ocr', startupExecutable: 'C:\\OCR\\run.exe' }))
    const service = new SettingsService(directory)
    const saved = await service.get()
    expect(saved).toMatchObject({ engineMode: 'external', endpoint: 'http://127.0.0.1:4567/ocr' })
    await service.save({ ...saved, engineMode: 'builtin' })
    expect(await service.get()).toMatchObject({ engineMode: 'builtin', startupExecutable: 'C:\\OCR\\run.exe' })
  })
  it('旧版空地址升级为 PaddleX 原生默认配置', async () => {
    await writeFile(join(directory, 'settings.json'), JSON.stringify({ endpoint: '', fileField: 'file', timeoutMs: 60000, concurrency: 2, maxRetries: 2, adapter: 'auto' }))
    const settings = await new SettingsService(directory).get()
    expect(settings.endpoint).toBe(DEFAULT_OCR_SETTINGS.endpoint)
    expect(settings.requestProtocol).toBe('paddlex-json')
    expect(settings.autoStart).toBe(true)
  })
})
