import { app, BrowserWindow, dialog, ipcMain, shell, clipboard } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import {
  batchTagsInputSchema,
  exportFilesInputSchema,
  exportInputSchema,
  idsInputSchema,
  invoiceFilterSchema,
  statsFilterSchema,
  invoiceQuerySchema,
  ocrSettingsSchema,
  saveInvoiceInputSchema,
  setStatusInputSchema,
  setTagsInputSchema,
  projectInputSchema,
  updateProjectInputSchema,
  setInvoiceProjectsSchema,
  appSettingsSchema,
  type ImportSummary,
  type IpcResponse,
} from '@shared/contracts'
import { toAppErrorPayload } from '@shared/errors'
import { InvoiceDatabase } from './db/database'
import { ImportService } from './services/import-service'
import { InvoiceService } from './services/invoice-service'
import { OcrQueue } from './services/ocr-queue'
import { SettingsService } from './services/settings-service'
import { StatsService } from './services/stats-service'
import { ExportService } from './services/export-service'
import { OcrClient } from './ocr/client'
import { OcrServiceManager } from './services/ocr-service-manager'
import { BackupService } from './services/backup-service'
import { AppError } from '@shared/errors'
import { AdvanceService } from './services/advance-service'
import { advanceSaveSchema, advanceFilterSchema, advanceMutationSchema, advanceReturnSchema } from '@shared/advances'
import type { DataLocationService } from './services/data-location-service'
import { AppSettingsService } from './services/app-settings-service'
import type { McpService } from './services/mcp-service'
import { mcpSettingsSchema, MCP_CONNECTION_FORMATS } from '@shared/mcp'
import { applyNativeAppearance } from './services/appearance'
import { pathToFileURL } from 'node:url'
import { matchesRendererUrl } from './services/ipc-security'

interface IpcServices {
  db: InvoiceDatabase
  imports: ImportService
  invoices: InvoiceService
  queue: OcrQueue
  settings: SettingsService
  stats: StatsService
  exports: ExportService
  ocrClient: OcrClient
  serviceManager: OcrServiceManager
  testMode: boolean
  backups: BackupService
  preferences: AppSettingsService
  mcp: McpService
  storage: DataLocationService
  getWindow: () => BrowserWindow | null
}

let dataBusy = false
let activeWrites = 0
let trustedWindow: () => BrowserWindow | null = () => null
export const isDataOperationBusy = (): boolean => dataBusy
const reads = new Set(['invoices:list', 'invoices:get', 'files:get-data', 'settings:get', 'settings:service-status', 'stats:get', 'tags:list', 'projects:list', 'preferences:get', 'application:info', 'mcp:status', 'mcp:connection'])

function handle<T>(channel: string, action: (input: unknown) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, input): Promise<IpcResponse<T>> => {
    let counted = false
    try {
      const window = trustedWindow()
      const expected = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(join(app.getAppPath(), 'out/renderer/index.html')).href
      if (!window || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !matchesRendererUrl(event.senderFrame.url, expected)) throw new AppError('IPC_FORBIDDEN', '请求来源不受信任')
      if (dataBusy && !reads.has(channel)) throw new AppError('DATA_BUSY', '数据备份或恢复中，请稍候再操作')
      if (!reads.has(channel)) { activeWrites++; counted = true }
      return { ok: true, data: await action(input) }
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ZodError')) {
        console.error(`[IPC:${channel}] ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
      return { ok: false, error: toAppErrorPayload(error) }
    } finally { if (counted) activeWrites-- }
  })
}

const idSchema = z.string().uuid()

export function registerIpc(services: IpcServices): void {
  trustedWindow = services.getWindow
  const advances = new AdvanceService(services.db, services.storage.directory)
  reads.add('advances:list')
  const changed = <T>(value: T): T => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('data:changed'); return value }
  handle('advances:list', input => advances.list(advanceFilterSchema.parse(input ?? {})))
  handle('advances:save', input => changed(advances.save(advanceSaveSchema.parse(input))))
  handle('advances:delete', input => { const value = advanceMutationSchema.extend({ deleted: z.boolean() }).parse(input); advances.setDeleted(value.id, value.revision, value.deleted); changed(undefined) })
  handle('advances:return-add', input => changed(advances.addReturn(advanceReturnSchema.parse(input))))
  handle('advances:return-remove', input => { const value = advanceMutationSchema.extend({ returnId: idSchema }).parse(input); return changed(advances.removeReturn(value.id, value.revision, value.returnId)) })
  handle('advances:attachments-add', async input => {
    const value = advanceMutationSchema.parse(input)
    const choice = await dialog.showOpenDialog({ title: '添加付款凭证或收据', properties: ['openFile', 'multiSelections'], filters: [{ name: '图片或 PDF', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'pdf'] }] })
    if (choice.canceled) return advances.get(value.id)
    return changed(await advances.addAttachments(value.id, value.revision, choice.filePaths))
  })
  handle('advances:attachment-open', async input => {
    const value = z.object({ id: idSchema, attachmentId: idSchema }).parse(input)
    const error = await shell.openPath(advances.attachmentPath(value.id, value.attachmentId))
    if (error) throw new AppError('OPEN_FILE_FAILED', '无法打开附件，请检查原文件或默认查看器')
  })
  handle('advances:attachment-remove', async input => { const value = advanceMutationSchema.extend({ attachmentId: idSchema }).parse(input); return changed(await advances.removeAttachment(value.id, value.revision, value.attachmentId)) })
  handle('advances:export', async input => {
    const filter = advanceFilterSchema.parse(input ?? {})
    const choice = await dialog.showSaveDialog({ title: '导出垫付记录', defaultPath: '垫付记录.xlsx', filters: [{ name: 'Excel', extensions: ['xlsx'] }] })
    if (choice.canceled || !choice.filePath) return { canceled: true, count: 0 }
    const workbook = advances.workbook(filter), count = workbook.getWorksheet('垫付记录')!.rowCount - 1
    await workbook.xlsx.writeFile(choice.filePath)
    return { canceled: false, count, filePath: choice.filePath }
  })
  const connection = () => services.mcp.connection(app.getPath('exe'), join(app.getAppPath(), 'out/main/mcp-stdio.js'))
  handle('mcp:status', () => services.mcp.getStatus())
  handle('mcp:settings-save', (input) => services.mcp.configure(mcpSettingsSchema.parse(input)))
  handle('mcp:rotate-token', () => services.mcp.rotateToken())
  handle('mcp:connection', connection)
  handle('mcp:copy-connection', (input) => { const format = z.enum(MCP_CONNECTION_FORMATS).parse(input); return clipboard.writeText(connection()[format]) })
  const loginStartupSupported = app.isPackaged && process.platform === 'win32'
  const effectivePreferences = () => {
    const settings = services.preferences.current
    if (settings.defaultProjectId && !services.db.listProjects().some((project) => project.id === settings.defaultProjectId)) settings.defaultProjectId = null
    settings.openAtLogin = loginStartupSupported ? app.getLoginItemSettings().openAtLogin : false
    return settings
  }
  handle('preferences:get', () => effectivePreferences())
  let preferenceSave: Promise<unknown> = Promise.resolve()
  handle('preferences:save', (input) => {
    const settings = appSettingsSchema.parse(input)
    const operation = preferenceSave.then(async () => {
    if (settings.defaultProjectId && !services.db.listProjects().some((project) => project.id === settings.defaultProjectId)) throw new AppError('PROJECT_NOT_FOUND', '默认项目已不存在，请重新选择')
    const previous = effectivePreferences()
    if (settings.openAtLogin && !loginStartupSupported) throw new AppError('LOGIN_STARTUP_UNSUPPORTED', '开机启动仅在 Windows 安装版中可用')
    const changedLogin = settings.openAtLogin !== previous.openAtLogin
    if (changedLogin) app.setLoginItemSettings({ openAtLogin: settings.openAtLogin })
    try { await services.preferences.save(settings) } catch (error) {
      if (changedLogin) app.setLoginItemSettings({ openAtLogin: previous.openAtLogin })
      throw error
    }
    services.queue.wake()
    applyNativeAppearance(settings.colorMode)
    if (settings.uiScale !== previous.uiScale) for (const window of BrowserWindow.getAllWindows()) window.webContents.setZoomFactor(settings.uiScale / 100)
    return effectivePreferences()
    })
    preferenceSave = operation.catch(() => {})
    return operation
  })
  handle('application:info', () => ({ version: app.getVersion(), electronVersion: process.versions.electron, platform: process.platform, arch: process.arch, dataDirectory: services.storage.directory, defaultDataDirectory: services.storage.defaultDirectory, configDirectory: services.storage.configDirectory, ...services.db.storageSummary(), loginStartupSupported, preferencesWarning: services.preferences.warning }))
  handle('application:open-data', async () => {
    const error = await shell.openPath(services.storage.directory)
    if (error) throw new AppError('OPEN_DIRECTORY_FAILED', '无法打开数据文件夹')
  })
  handle('settings:select-path', async (input) => {
    const kind = z.enum(['executable', 'directory']).parse(input)
    const result = await dialog.showOpenDialog({ title: kind === 'executable' ? '选择 OCR 启动程序' : '选择 OCR 工作目录', properties: kind === 'executable' ? ['openFile'] : ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  async function importWithPreferences(paths: string[], contextProject?: string | null): Promise<ImportSummary> {
    const target = contextProject === undefined ? effectivePreferences().defaultProjectId : contextProject
    const summary = await services.imports.import(paths)
    if (target && summary.imported.length) {
      if (services.db.listProjects().some((project) => project.id === target)) services.db.setInvoiceProjects(summary.imported.map((invoice) => invoice.id), [target])
      else summary.warnings = ['项目已删除，新导入发票暂未分配项目']
    }
    summary.imported = summary.imported.map((invoice) => services.db.get(invoice.id) ?? invoice)
    return summary
  }
  handle('projects:list', () => services.db.listProjects())
  handle('projects:create', (input) => services.db.createProject(projectInputSchema.parse(input)))
  handle('projects:update', (input) => services.db.updateProject(updateProjectInputSchema.parse(input)))
  handle('projects:delete', (input) => services.db.deleteProject(idSchema.parse(input)))
  handle('invoices:projects-set', (input) => {
    const parsed = setInvoiceProjectsSchema.parse(input)
    return services.db.setInvoiceProjects(parsed.ids, parsed.projectIds)
  })
  handle('files:import', async (input) => {
    const contextProject = idSchema.nullable().optional().parse(input)
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      title: '选择发票文件',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>,
      filters: [{ name: '发票文件', extensions: ['jpg', 'jpeg', 'png', 'bmp', 'webp', 'pdf'] }],
    }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return { imported: [], duplicates: [], failures: [] } satisfies ImportSummary
    return importWithPreferences(result.filePaths, contextProject)
  })
  handle('files:get-data', async (input) => (await services.imports.readInvoiceFile(idSchema.parse(input))).data)
  handle('invoices:list', (input) => services.db.list(invoiceQuerySchema.parse(input ?? {})))
  handle('invoices:get', (input) => services.invoices.detail(idSchema.parse(input)))
  handle('invoices:save', (input) => {
    const parsed = saveInvoiceInputSchema.parse(input)
    return services.invoices.save(parsed.id, parsed.fields, parsed.confirm, parsed.expectedRevision, parsed.expectedFieldRevision)
  })
  handle('invoices:apply-ocr', (input) => {
    const parsed = z.object({ invoiceId: z.string().uuid(), resultId: z.string().uuid() }).parse(input)
    return services.invoices.applyOcr(parsed.invoiceId, parsed.resultId)
  })
  handle('invoices:retry-ocr', (input) => services.queue.retry(idSchema.parse(input)))
  handle('settings:get', () => services.settings.get())
  handle('settings:save', async (input) => {
    const saved = await services.settings.save(ocrSettingsSchema.parse(input))
    await services.serviceManager.configure(saved)
    if (saved.autoStart && !services.testMode) {
      void services.serviceManager.ensure().catch((error) => console.error('OCR auto start failed', error))
    }
    return saved
  })
  handle('settings:test-ocr', (input) => services.ocrClient.testConnection(ocrSettingsSchema.parse(input)))
  handle('settings:service-status', () => services.serviceManager.check())
  handle('settings:start-service', async (input) => {
    const saved = await services.settings.save(ocrSettingsSchema.parse(input))
    await services.serviceManager.configure(saved)
    return services.serviceManager.start()
  })
  handle('stats:get', (input) => services.stats.get(statsFilterSchema.parse(input ?? {})))
  handle('stats:export', (input) => services.exports.exportStats(statsFilterSchema.parse(input ?? {})))
  handle('invoices:export', (input) => services.exports.export(exportInputSchema.parse(input)))
  handle('invoices:export-files', (input) => services.exports.exportFiles(exportFilesInputSchema.parse(input)))
  handle('invoices:export-bundle', (input) => services.exports.exportBundle(exportFilesInputSchema.parse(input)))
  handle('invoices:delete', (input) => services.invoices.deleteInvoices(idsInputSchema.parse(input)))
  handle('invoices:restore', (input) => services.invoices.restoreInvoices(idsInputSchema.parse(input)))
  handle('invoices:purge', (input) => services.invoices.purgeInvoices(idsInputSchema.parse(input)))
  handle('invoices:confirm-batch', (input) => services.invoices.confirmInvoices(idsInputSchema.parse(input)))
  handle('invoices:retry-batch', (input) => services.invoices.retryOcrInvoices(idsInputSchema.parse(input)))
  handle('invoices:status-batch', (input) => {
    const parsed = setStatusInputSchema.parse(input)
    return services.invoices.setInvoicesStatus(parsed.ids, parsed.status)
  })
  handle('invoices:tags-set', (input) => {
    const parsed = setTagsInputSchema.parse(input)
    services.invoices.setInvoiceTags(parsed.id, parsed.tags)
  })
  handle('invoices:tags-add', (input) => {
    const parsed = batchTagsInputSchema.parse(input)
    return services.invoices.addInvoicesTags(parsed.ids, parsed.tags)
  })
  handle('invoices:tags-remove', (input) => {
    const parsed = batchTagsInputSchema.parse(input)
    return services.invoices.removeInvoicesTags(parsed.ids, parsed.tags)
  })
  handle('tags:list', () => services.invoices.getTags())

  handle('data:backup', async () => {
    dataBusy = true
    try {
      const choice = await dialog.showOpenDialog({ title: '选择备份保存目录', properties: ['openDirectory', 'createDirectory'] })
      if (choice.canceled || !choice.filePaths.length) return { canceled: true }
      return { canceled: false, path: await services.backups.create(choice.filePaths[0]) }
    } finally { dataBusy = false }
  })
  handle('data:change-location', async input => {
    const mode = z.enum(['select', 'default']).parse(input)
    if (activeWrites > 1 || services.queue.isActive) throw new AppError('DATA_BUSY', '还有识别或文件操作未完成，请完成后再迁移数据')
    dataBusy = true
    let restarting = false, paused = false
    try {
      let destination = services.storage.defaultDirectory
      if (mode === 'select') {
        const choice = await dialog.showOpenDialog({ title: '选择空的数据文件夹', defaultPath: services.storage.directory, properties: ['openDirectory', 'createDirectory'] })
        if (choice.canceled || !choice.filePaths.length) return { canceled: true }
        destination = choice.filePaths[0]
      }
      const target = await services.storage.destination(destination, mode === 'default')
      if (target === services.storage.directory) return { canceled: true }
      const confirmation = await dialog.showMessageBox({ type: 'question', title: '迁移数据目录', message: `将业务数据迁移到：\n${target}`, detail: '迁移发票、项目、垫付、收回记录及全部凭证，校验完成后重启。原数据和旧备份保留在原位置，程序设置保持不变。恢复默认目录时，本应用留在默认位置的旧副本会另外保留。', buttons: ['取消', '迁移并重启'], defaultId: 0, cancelId: 0 })
      if (confirmation.response !== 1) return { canceled: true }
      // New mutating IPC/MCP requests are blocked; pre-existing mutating requests and OCR must be idle.
      if (activeWrites > 1 || services.queue.isActive) throw new AppError('DATA_BUSY', '识别或文件操作尚未结束，请稍后迁移')
      services.queue.stop(); paused = true
      const directory = await services.storage.migrate(target, services.backups, mode === 'default')
      restarting = true
      // Leave an idle external OCR process available if copying fails. Stop only after commit.
      await services.serviceManager.stop().catch(() => console.warn('OCR shutdown during data migration failed'))
      setTimeout(() => { app.relaunch(); app.quit() }, 500)
      return { canceled: false, directory }
    } finally { if (!restarting) { dataBusy = false; if (paused) services.queue.start() } }
  })
  handle('data:restore', async () => {
    dataBusy = true
    let restarting = false
    try {
      const choice = await dialog.showOpenDialog({ title: '选择包含 manifest.json 的票夹备份文件夹', properties: ['openDirectory'] })
      if (choice.canceled || !choice.filePaths.length) return { canceled: true }
      const confirm = await dialog.showMessageBox({ type: 'warning', title: '恢复本地数据', message: '恢复会替换全部现有发票、垫付记录及凭证、项目、标签和识别记录，并重启应用。', detail: '恢复前将校验备份并自动备份当前数据。应用设置保持不变。', buttons: ['取消', '校验并恢复'], defaultId: 0, cancelId: 0 })
      if (confirm.response !== 1) return { canceled: true }
      const safetyBackupPath = await services.backups.prepareRestore(choice.filePaths[0])
      restarting = true
      setTimeout(() => { app.relaunch(); app.quit() }, 500)
      return { canceled: false, safetyBackupPath }
    } finally { if (!restarting) dataBusy = false }
  })

  if (services.testMode) {
    handle('test:import-paths', (input) => importWithPreferences(z.array(z.string().min(1).max(32_767)).max(100).parse(input)))
  }
}
