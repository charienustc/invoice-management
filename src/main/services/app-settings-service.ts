import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { appSettingsSchema, DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/contracts'

export const windowStateSchema = z.object({ x: z.number().int().min(-100_000).max(100_000), y: z.number().int().min(-100_000).max(100_000), width: z.number().int().min(1080).max(10_000), height: z.number().int().min(700).max(10_000), maximized: z.boolean() })
export type WindowState = z.infer<typeof windowStateSchema>
type WorkArea = { x: number; y: number; width: number; height: number }

export function fitWindowState(state: WindowState | null, areas: WorkArea[]): WindowState | undefined {
  if (!state || !areas.length) return undefined
  const overlap = (area: WorkArea) => Math.max(0, Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x)) * Math.max(0, Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y))
  const area = [...areas].sort((a, b) => overlap(b) - overlap(a))[0]
  const width = Math.max(1080, Math.min(state.width, area.width)), height = Math.max(700, Math.min(state.height, area.height))
  return { width, height, maximized: state.maximized, x: Math.max(area.x, Math.min(state.x, area.x + area.width - width)), y: Math.max(area.y, Math.min(state.y, area.y + area.height - height)) }
}

export class AppSettingsService {
  private value = { ...DEFAULT_APP_SETTINGS }
  private pending: Promise<unknown> = Promise.resolve()
  warning?: string
  constructor(private readonly directory: string) {}
  get current(): AppSettings { return { ...this.value } }
  async load(): Promise<void> {
    try { this.value = appSettingsSchema.parse(JSON.parse(await readFile(join(this.directory, 'preferences.json'), 'utf8'))) }
    catch (error) {
      this.value = { ...DEFAULT_APP_SETTINGS }
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) this.warning = '偏好设置文件无法读取，已临时使用默认值。保存通用设置可修复。'
    }
  }
  save(settings: AppSettings): Promise<AppSettings> {
    const validated = appSettingsSchema.parse(settings)
    const operation = this.pending.then(async () => {
      await mkdir(this.directory, { recursive: true })
      const temporary = join(this.directory, `preferences-${randomUUID()}.tmp`)
      try {
        await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 })
        await rename(temporary, join(this.directory, 'preferences.json'))
        this.value = validated
        this.warning = undefined
        return this.current
      } finally { await unlink(temporary).catch(() => {}) }
    })
    this.pending = operation.catch(() => {})
    return operation
  }
  readWindowState(): WindowState | null {
    try { return windowStateSchema.parse(JSON.parse(readFileSync(join(this.directory, 'window-state.json'), 'utf8'))) } catch { return null }
  }
  saveWindowState(state: WindowState): void {
    try { writeFileSync(join(this.directory, 'window-state.json'), JSON.stringify(windowStateSchema.parse(state))) } catch (error) { console.warn('窗口状态保存失败', error) }
  }
}
