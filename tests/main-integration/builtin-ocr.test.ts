import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BuiltinOcrEngine } from '../../src/main/ocr/builtin-engine'
import { OcrClient } from '../../src/main/ocr/client'
import { OcrServiceManager } from '../../src/main/services/ocr-service-manager'
import { DEFAULT_OCR_SETTINGS } from '@shared/contracts'

let directory: string
let engine: BuiltinOcrEngine
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'builtin-ocr-'))
  engine = new BuiltinOcrEngine(process.execPath, directory, [resolve('tests/fixtures/ocr/stdio-worker.mjs')])
})
afterEach(async () => { await engine.stop(); await rm(directory, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('内置 OCR 进程与请求生命周期', () => {
  it('按需启动、串行复用进程，并在每次请求后删除临时图片', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No HTTP permitted'))
    const manager = new OcrServiceManager(engine)
    await manager.configure(DEFAULT_OCR_SETTINGS)
    expect((await manager.ensure()).pid).toBeUndefined()
    const client = new OcrClient(engine)
    const upload = (text: string) => ({ data: Buffer.from(text), fileName: 'x.png', mimeType: 'image/png' })
    const first = client.recognize(upload('first'), { ...DEFAULT_OCR_SETTINGS, adapter: 'paddle' })
    const second = client.recognize(upload('second'), DEFAULT_OCR_SETTINGS)
    await expect(first).resolves.toMatchObject({ lines: [{ text: 'first' }] })
    const pid = (await manager.check()).pid
    await expect(second).resolves.toMatchObject({ lines: [{ text: 'second' }] })
    expect((await manager.check()).pid).toBe(pid)
    expect(await readdir(directory)).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    await manager.configure({ ...DEFAULT_OCR_SETTINGS, engineMode: 'external', autoStart: false })
    expect((await engine.status()).pid).toBeUndefined()
  })

  it.each(['crash', 'hang', 'malformed'])('请求异常 %s 后释放文件，下次请求重建进程', async (input) => {
    await expect(engine.recognize(Buffer.from(input), 100)).rejects.toMatchObject({ code: expect.stringMatching(/^OCR_/) })
    expect(await readdir(directory)).toEqual([])
    expect((await engine.status()).state).toBe('error')
    await expect(engine.recognize(Buffer.from('recovered'), 1000)).resolves.toMatchObject({ lines: [{ text: 'recovered' }] })
  })

  it('停止时拒绝当前与排队请求，且不会自动重新拉起旧任务', async () => {
    const active = engine.recognize(Buffer.from('hang'), 1000)
    const queued = engine.recognize(Buffer.from('queued'), 1000)
    const results = Promise.allSettled([active, queued])
    await vi.waitFor(async () => expect((await engine.status()).state).toBe('online'))
    await engine.stop()
    expect((await results).every((result) => result.status === 'rejected')).toBe(true)
    expect((await engine.status()).pid).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
  })

  it('启动中停止也会结束等待，缺失文件能给出明确错误', async () => {
    const ready = engine.start().catch((error: unknown) => error)
    await engine.stop()
    expect(await ready).toMatchObject({ code: 'OCR_STOPPED' })
    engine = new BuiltinOcrEngine(join(directory, 'missing.exe'), directory)
    expect((await engine.status()).message).toContain('文件缺失')
    await expect(engine.start()).rejects.toMatchObject({ code: 'OCR_START_FAILED' })
  })
})
