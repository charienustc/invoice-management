import { beforeEach, afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AppSettingsService, fitWindowState } from '../../src/main/services/app-settings-service'
import { DEFAULT_APP_SETTINGS } from '@shared/contracts'
let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'invoice-preferences-')) })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

it('通用偏好使用默认值，旧字段缺失时补齐并在重载后保留', async () => {
  const service = new AppSettingsService(directory)
  await service.load()
  expect(service.current).toEqual(DEFAULT_APP_SETTINGS)
  await writeFile(join(directory, 'preferences.json'), JSON.stringify({ density: 'compact', autoRecognize: false }))
  await service.load()
  expect(service.current).toMatchObject({ density: 'compact', autoRecognize: false, pageSize: 20, uiScale: 100, colorMode: 'system' })
  await service.save({ ...service.current, pageSize: 50, motion: 'reduce', uiScale: 125, colorMode: 'dark' })
  const restored = new AppSettingsService(directory)
  await restored.load()
  expect(restored.current).toMatchObject({ pageSize: 50, motion: 'reduce', autoRecognize: false, uiScale: 125, colorMode: 'dark' })
  expect(() => service.save({ ...service.current, colorMode: 'invalid' } as never)).toThrow()
  expect(() => service.save({ ...service.current, uiScale: 200 } as never)).toThrow()
})

it('损坏偏好不会阻止打开应用，保存后修复；无效输入不覆盖现有设置', async () => {
  await writeFile(join(directory, 'preferences.json'), 'broken json')
  const service = new AppSettingsService(directory)
  await service.load()
  expect(service.warning).toContain('无法读取')
  expect(service.current).toEqual(DEFAULT_APP_SETTINGS)
  await service.save({ ...service.current, density: 'compact' })
  expect(service.warning).toBeUndefined()
  expect(() => service.save({ ...service.current, pageSize: 0 } as never)).toThrow()
  expect(JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8')).density).toBe('compact')
})

it('并发保存按调用顺序落盘，不遗留临时写入文件', async () => {
  const service = new AppSettingsService(directory)
  await Promise.all([service.save({ ...DEFAULT_APP_SETTINGS, density: 'compact' }), service.save({ ...DEFAULT_APP_SETTINGS, pageSize: 100 })])
  expect(service.current).toMatchObject({ density: 'comfortable', pageSize: 100 })
  expect(JSON.parse(await readFile(join(directory, 'preferences.json'), 'utf8'))).toEqual(service.current)
})

it('记住窗口位置；断开显示器后把窗口限制在当前屏幕', () => {
  const service = new AppSettingsService(directory)
  service.saveWindowState({ x: 3000, y: 1500, width: 1400, height: 900, maximized: true })
  const fitted = fitWindowState(service.readWindowState(), [{ x: 0, y: 0, width: 1920, height: 1080 }])!
  expect(fitted.x + fitted.width).toBeLessThanOrEqual(1920)
  expect(fitted.y + fitted.height).toBeLessThanOrEqual(1080)
  expect(fitted.maximized).toBe(true)
})
