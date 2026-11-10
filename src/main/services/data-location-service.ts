import { access, mkdir, readFile, readdir, realpath, rename, rmdir, stat, writeFile, unlink } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import { BackupService, validateBackup } from './backup-service'

const locationSchema = z.object({ version: z.literal(1), directory: z.string().min(1).max(32767).refine(isAbsolute) }).strict()
const key = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
const same = (a: string, b: string) => key(a) === key(b)
const inside = (child: string, parent: string) => key(child).startsWith(key(parent).replace(/[\\/]$/, '') + sep)

/** Only database/originals move. Preferences and the location pointer stay in userData. */
export class DataLocationService {
  private active = ''
  constructor(readonly configDirectory: string, readonly defaultDirectory: string, private readonly applicationDirectory: string) {}
  get directory(): string { return this.active }
  get isDefault(): boolean { return same(this.active, this.defaultDirectory) }
  private get configPath() { return join(this.configDirectory, 'storage-location.json') }
  async initialize(): Promise<string> {
    let stored: z.infer<typeof locationSchema> | undefined
    try { stored = locationSchema.parse(JSON.parse(await readFile(this.configPath, 'utf8'))) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new AppError('STORAGE_CONFIG_INVALID', `数据目录配置无法读取，请检查 ${this.configPath}`)
    }
    if (stored) {
      try {
        if (!(await stat(stored.directory)).isDirectory()) throw new Error()
        await access(join(stored.directory, 'invoice.db'), constants.R_OK | constants.W_OK)
      } catch { throw new AppError('STORAGE_UNAVAILABLE', `数据目录不可用：${stored.directory}。请连接原磁盘或恢复目录；目录配置位于 ${this.configPath}。未创建新的空数据库。`) }
      this.active = resolve(stored.directory)
    } else {
      // Keep existing installations in place until the user explicitly migrates.
      const legacy = await stat(join(this.configDirectory, 'invoice.db')).then(value => value.isFile(), () => false)
      this.active = resolve(legacy ? this.configDirectory : this.defaultDirectory)
      await mkdir(this.active, { recursive: true })
    }
    return this.active
  }
  async persist(directory = this.active): Promise<void> {
    const value = locationSchema.parse({ version: 1, directory: resolve(directory) })
    await mkdir(this.configDirectory, { recursive: true })
    if (!same(directory, this.configDirectory)) await writeFile(join(directory, '.data-location-owner.json'), JSON.stringify({ application: 'invoice-management', version: 1 }))
    const temporary = join(this.configDirectory, `storage-location-${randomUUID()}.tmp`)
    try { await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, this.configPath) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  private async reusableDefault(target: string, allowed: boolean): Promise<boolean> {
    if (!allowed || !same(target, this.defaultDirectory)) return false
    try { const owner = JSON.parse(await readFile(join(target, '.data-location-owner.json'), 'utf8')); return owner.application === 'invoice-management' && owner.version === 1 }
    catch { return false }
  }
  async destination(input: string, reuseDefault = false): Promise<string> {
    if (!isAbsolute(input)) throw new AppError('STORAGE_PATH_INVALID', '请选择数据目录的绝对路径')
    const chosen = resolve(input)
    if (same(chosen, parse(chosen).root)) throw new AppError('STORAGE_PATH_INVALID', '请选择数据文件夹，不能直接使用磁盘根目录')
    // No recursive copying into a source ancestor/descendant, or application files.
    if (same(chosen, this.active)) return this.active
    if (inside(chosen, this.active) || inside(this.active, chosen) || same(chosen, this.applicationDirectory) || inside(chosen, this.applicationDirectory)
      || same(chosen, this.configDirectory) || inside(this.configDirectory, chosen)) throw new AppError('STORAGE_PATH_INVALID', '不能选择当前数据目录的上级、子目录、配置目录或程序安装目录')
    await mkdir(chosen, { recursive: true })
    const target = await realpath(chosen), source = await realpath(this.active), application = await realpath(this.applicationDirectory)
    if (same(target, source)) return this.active
    if (inside(target, source) || inside(source, target) || same(target, application) || inside(target, application)
      || same(target, this.configDirectory) || inside(this.configDirectory, target)) throw new AppError('STORAGE_PATH_INVALID', '目标目录与当前数据或程序目录重叠')
    if ((await readdir(target)).length && !await this.reusableDefault(target, reuseDefault)) throw new AppError('STORAGE_NOT_EMPTY', '请选择空文件夹，避免覆盖已有数据')
    await access(target, constants.R_OK | constants.W_OK)
    return target
  }
  async migrate(input: string, backups: BackupService, reuseDefault = false): Promise<string> {
    const target = await this.destination(input, reuseDefault)
    if (same(target, this.active)) return this.active
    // BackupService uses SQLite backup + hashes and includes every invoice/advance attachment.
    // The verified snapshot is atomically renamed into the user's empty destination.
    const snapshot = await backups.create(dirname(target))
    await validateBackup(snapshot)
    let preserved: string | undefined
    if ((await readdir(target)).length) {
      if (!await this.reusableDefault(target, reuseDefault)) throw new AppError('STORAGE_NOT_EMPTY', `目标文件夹已有内容，迁移未切换；校验副本保留在 ${snapshot}`)
      preserved = `${target}.previous-${randomUUID()}`
      if (dirname(resolve(preserved)) !== dirname(resolve(target))) throw new Error('Unexpected preserved directory')
      await rename(target, preserved)
    } else await rmdir(target) // Empty directory only; no recursive deletion of the user's destination.
    try { await rename(snapshot, target) }
    catch (error) { if (preserved) await rename(preserved, target); else await mkdir(target, { recursive: true }); throw error }
    try { await this.persist(target) }
    catch { throw new AppError('STORAGE_SWITCH_FAILED', `数据已复制到 ${target}，但目录配置保存失败，仍使用原目录。两份数据均已保留。`) }
    return target
  }
}
