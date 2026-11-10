import { app, BrowserWindow, Menu, protocol, dialog, screen } from 'electron'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { InvoiceDatabase } from './db/database'
import { ImportService } from './services/import-service'
import { InvoiceService } from './services/invoice-service'
import { OcrQueue } from './services/ocr-queue'
import { SettingsService } from './services/settings-service'
import { StatsService } from './services/stats-service'
import { ExportService } from './services/export-service'
import { OcrClient } from './ocr/client'
import { BuiltinOcrEngine } from './ocr/builtin-engine'
import { registerIpc, isDataOperationBusy } from './ipc'
import { McpService } from './services/mcp-service'
import { OcrServiceManager } from './services/ocr-service-manager'
import { BackupService, applyPendingRestore } from './services/backup-service'
import { AppSettingsService, fitWindowState } from './services/app-settings-service'
import { applyNativeAppearance, applyWindowAppearance, windowColors } from './services/appearance'
import { DataLocationService } from './services/data-location-service'

protocol.registerSchemesAsPrivileged([
  { scheme: 'invoice-file', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

const currentDirectory = dirname(fileURLToPath(import.meta.url))
const testMode = !app.isPackaged && process.argv.includes('--invoice-e2e=1')
if (testMode && process.env.INVOICE_E2E_DATA_DIR) app.setPath('userData', process.env.INVOICE_E2E_DATA_DIR)

let mainWindow: BrowserWindow | null = null
let database: InvoiceDatabase | null = null
let queue: OcrQueue | null = null
let serviceManager: OcrServiceManager | null = null
let preferences: AppSettingsService | null = null
let mcp: McpService | null = null

function createWindow(): BrowserWindow {
  const state = preferences?.current.rememberWindowState ? fitWindowState(preferences.readWindowState(), screen.getAllDisplays().map((display) => display.workArea)) : undefined
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    ...(state ? { x: state.x, y: state.y, width: state.width, height: state.height } : {}),
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: windowColors().background,
    title: '发票管理',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: windowColors().titlebar, symbolColor: windowColors().symbol, height: 38 },
    webPreferences: {
      zoomFactor: (preferences?.current.uiScale ?? 100) / 100,
      preload: join(currentDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: testMode ? ['--invoice-e2e=1'] : [],
    },
  })
  // Chromium can reset file:// zoom on reload; keep the saved application scale.
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor((preferences?.current.uiScale ?? 100) / 100))
  window.once('ready-to-show', () => {
    applyWindowAppearance(window)
    // Apply saved outer bounds after Windows has initialized the native frame.
    if (state) window.setBounds({ x: state.x, y: state.y, width: state.width, height: state.height })
    if (state?.maximized) window.maximize()
    window.show()
  })
  window.on('close', () => {
    if (preferences?.current.rememberWindowState) preferences.saveWindowState({ ...window.getNormalBounds(), maximized: window.isMaximized() })
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const hash = preferences?.current.startupPage === 'stats' ? '/stats' : '/invoices'
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) { const url = new URL(process.env.ELECTRON_RENDERER_URL); url.hash = hash; window.loadURL(url.toString()) }
  else window.loadFile(join(currentDirectory, '../renderer/index.html'), { hash })
  window.on('closed', () => { mainWindow = null })
  return window
}

async function initialize(): Promise<void> {
  Menu.setApplicationMenu(null)
  const configDirectory = app.getPath('userData')
  const isolatedProfile = testMode || app.commandLine.hasSwitch('user-data-dir')
  const defaultDataDirectory = process.platform === 'win32' && !isolatedProfile
    ? join(process.env.LOCALAPPDATA || join(app.getPath('home'), 'AppData', 'Local'), 'invoice-management', 'Data')
    : join(configDirectory, 'data')
  const storage = new DataLocationService(configDirectory, defaultDataDirectory, dirname(app.getPath('exe')))
  let dataDirectory: string
  try { dataDirectory = await storage.initialize() }
  catch (error) { dialog.showErrorBox('数据目录不可用', error instanceof Error ? error.message : '请检查数据磁盘和目录配置'); throw error }
  try { await applyPendingRestore(dataDirectory) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'RESTORE_VALIDATION') dialog.showErrorBox('恢复未完成', error.message)
    else throw error
  }
  try { database = new InvoiceDatabase(dataDirectory); await storage.persist() }
  catch (error) { dialog.showErrorBox('数据目录无法初始化', error instanceof Error ? error.message : '请检查数据目录及程序配置目录的写入权限'); throw error }
  preferences = new AppSettingsService(configDirectory)
  await preferences.load()
  applyNativeAppearance(preferences.current.colorMode)
  const settings = new SettingsService(configDirectory)
  // This directory is exclusively owned by the OCR worker; remove crash leftovers.
  await rm(join(dataDirectory, 'ocr-temp'), { recursive: true, force: true })
  const builtin = new BuiltinOcrEngine(
    app.isPackaged ? join(process.resourcesPath, 'ocr', 'InvoiceOcr.exe') : join(app.getAppPath(), '.tmp', 'ocr-runtime', 'InvoiceOcr.exe'),
    join(dataDirectory, 'ocr-temp'),
  )
  serviceManager = new OcrServiceManager(builtin)
  const savedSettings = await settings.get()
  await serviceManager.configure(testMode || process.env.INVOICE_DISABLE_OCR_AUTOSTART === '1' ? { ...savedSettings, autoStart: false } : savedSettings)
  const imports = new ImportService(database, dataDirectory, (invoiceId) => { if (preferences!.current.autoRecognize) queue?.enqueue(invoiceId) })
  const ocrClient = new OcrClient(builtin)
  queue = new OcrQueue(database, settings, imports, ocrClient, (progress) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ocr:progress', progress)
  }, () => preferences!.current.autoRecognize)
  const invoices = new InvoiceService(database, imports, queue)
  const stats = new StatsService(database)
  const exports = new ExportService(database, imports, app.getPath('documents'), () => mainWindow)

  protocol.handle('invoice-file', async (request) => {
    try {
      const url = new URL(request.url)
      const id = url.pathname.slice(1)
      if (url.hostname !== 'invoice' || !database?.get(id)) return new Response('Not found', { status: 404 })
      const storagePath = database.getStoragePath(id)
      if (!storagePath) return new Response('Not found', { status: 404 })
      const data = await readFile(imports.resolveStoragePath(storagePath))
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'Content-Type': database.get(id)!.mimeType,
          'Content-Length': String(data.byteLength),
          'Access-Control-Allow-Origin': '*',
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })

  const backups = new BackupService(database, dataDirectory)
  mcp = new McpService(configDirectory, { db: database, invoices, serviceManager, version: app.getVersion(), isBusy: isDataOperationBusy, changed: () => { for (const window of BrowserWindow.getAllWindows()) window.webContents.send('data:changed') } })
  await mcp.initialize()
  registerIpc({ db: database, imports, invoices, queue, settings, stats, exports, ocrClient, serviceManager, backups, preferences, mcp, testMode, storage, getWindow: () => mainWindow })
  mainWindow = createWindow()
  queue.start()
  if (!testMode && process.env.INVOICE_DISABLE_OCR_AUTOSTART !== '1') {
    void serviceManager.ensure().catch((error) => console.error('OCR service startup failed', error))
  }
}

const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(initialize).catch((error) => {
    console.error('Application initialization failed', error)
    app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && database) mainWindow = createWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    void mcp?.stop()
    queue?.stop()
    void serviceManager?.stop()
    database?.close()
  })
}
