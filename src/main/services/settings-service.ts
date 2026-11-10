import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_OCR_SETTINGS, ocrSettingsSchema, type OcrSettings } from '@shared/contracts'
import { AppError } from '@shared/errors'

export class SettingsService {
  private readonly path: string

  constructor(dataDirectory: string) {
    this.path = join(dataDirectory, 'settings.json')
  }

  async get(): Promise<OcrSettings> {
    try {
      const value: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      const stored = value as Partial<OcrSettings>
      const merged = { ...DEFAULT_OCR_SETTINGS, ...stored }
      // Existing installations keep their external service until the user switches.
      if (!stored.engineMode) merged.engineMode = stored.endpoint ? 'external' : 'builtin'
      if (!stored.requestProtocol && !stored.endpoint) merged.endpoint = DEFAULT_OCR_SETTINGS.endpoint
      return ocrSettingsSchema.parse(merged)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return DEFAULT_OCR_SETTINGS
      throw new AppError('SETTINGS_INVALID', '设置文件无法读取，请修正 settings.json 或重新保存设置')
    }
  }

  async save(settings: OcrSettings): Promise<OcrSettings> {
    const validated = ocrSettingsSchema.parse(settings)
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.path)
    return validated
  }
}
