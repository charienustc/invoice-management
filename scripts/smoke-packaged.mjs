import { _electron as electron, expect } from '@playwright/test'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyOcrLicenses } from './verify-ocr-licenses.mjs'
import { createServer } from 'node:http'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'

const temporaryRoot = resolve('.tmp')
await mkdir(temporaryRoot, { recursive: true })
const dataDirectory = await mkdtemp(join(temporaryRoot, 'packaged-smoke-'))
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const executablePath = resolve(process.env.INVOICE_PACKAGED_EXE ?? `artifacts/${version}/win-unpacked/InvoiceManagement.exe`)
await verifyOcrLicenses(join(dirname(executablePath), 'resources/ocr'))
expect((await readFile(join(dirname(executablePath), 'LICENSE.electron.txt'), 'utf8')).length).toBeGreaterThan(100)
let application
let workerPid
try {
  const launchEnv = { ...process.env, TEMP: temporaryRoot, TMP: temporaryRoot, INVOICE_DISABLE_OCR_AUTOSTART: '1', ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/ignored-in-production' }
  for (const key of Object.keys(launchEnv)) if (/^(PYTHON|CONDA)/i.test(key)) delete launchEnv[key]
  if (process.platform === 'win32') {
    for (const key of Object.keys(launchEnv)) if (key.toLowerCase() === 'path') delete launchEnv[key]
    launchEnv.PATH = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32;${process.env.SystemRoot ?? 'C:\\Windows'}`
  }
  application = await electron.launch({
    executablePath,
    args: ['--no-sandbox', `--user-data-dir=${dataDirectory}`],
    env: launchEnv,
  })
  const page = await application.firstWindow()
  await application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.overlayCalls = 0
    const original = window.setTitleBarOverlay.bind(window)
    window.setTitleBarOverlay = (options) => { window.overlayCalls++; window.lastOverlay = options; original(options) }
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await expect(page).toHaveTitle('发票管理')
  await expect(page.getByRole('banner', { name: '窗口标题栏' })).toBeVisible()
  await expect(page.getByRole('button', { name: '切换侧栏', exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.windowControlsOverlay?.visible ?? false)).toBe(true)
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1080, 800))
  await expect(page.locator('.invoice-list')).toHaveAttribute('data-layout', 'compact')
  await expect.poll(() => page.locator('.el-table__header-wrapper table').evaluate((node) => node.getBoundingClientRect().width - document.querySelector('.table-wrap').getBoundingClientRect().width)).toBeLessThanOrEqual(1)
  expect(await application.evaluate(({ Menu }) => Menu.getApplicationMenu())).toBeNull()
  await expect.poll(() => page.evaluate(() => window.invoiceApi.getSettings().then((settings) => settings.fileField))).toBe('file')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  const projectDialog = page.getByRole('dialog', { name: '新建项目', exact: true })
  await projectDialog.locator('.el-form-item').filter({ hasText: '项目名称' }).locator('input').fill('发布检查项目')
  await projectDialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(projectDialog).not.toBeVisible()
  const projectLink = page.getByRole('navigation', { name: '项目列表' }).getByRole('link', { name: /发布检查项目/ })
  await expect(projectLink).toBeVisible()
  await projectLink.click()
  await expect(page.locator('.toolbar-title')).toContainText('发布检查项目')
  expect(await page.evaluate(() => window.invoiceApi.listProjects().then((projects) => projects[0].name))).toBe('发布检查项目')
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存通用设置', exact: true })).toBeVisible()
  await expect(page.getByRole('switch', { name: '开机启动', exact: true })).toBeEnabled()
  await expect(page.getByRole('tablist', { name: '设置分类' }).getByRole('tab')).toHaveText(['通用', '外观', '识别服务', '连接', '数据', '关于'])
  await page.getByRole('tab', { name: '外观', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存外观设置', exact: true })).toBeVisible()
  await expect(page.getByLabel('列表外观预览', { exact: true })).toBeVisible()
  await page.locator('.appearance-row').filter({ hasText: '颜色' }).locator('.el-select').click()
  await page.getByRole('option', { name: '深色模式', exact: true }).click()
  await page.getByRole('button', { name: '保存外观设置', exact: true }).click()
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  expect(await page.evaluate(() => window.invoiceApi.getAppSettings().then((settings) => settings.colorMode))).toBe('dark')
  await expect.poll(() => application.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({ source: 'dark', dark: true })
  await page.locator('.appearance-row').filter({ hasText: '颜色' }).locator('.el-select').click()
  await page.getByRole('option', { name: '浅色模式', exact: true }).click()
  await page.getByRole('button', { name: '保存外观设置', exact: true }).click()
  await expect.poll(() => application.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))).toEqual({ source: 'light', dark: false })
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].lastOverlay)).toMatchObject({ color: '#f5f5f7', symbolColor: '#65656d' })
  await page.getByRole('tab', { name: '识别服务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '发票识别' })).toBeVisible()
  expect(await page.evaluate(() => window.invoiceApi.getSettings().then((settings) => settings.engineMode))).toBe('builtin')
  expect((await page.evaluate(() => window.invoiceApi.getOcrServiceStatus())).pid).toBeUndefined()
  await page.getByRole('button', { name: '测试内置 OCR', exact: true }).click()
  await expect(page.locator('.test-result')).toBeVisible({ timeout: 60000 })
  workerPid = (await page.evaluate(() => window.invoiceApi.getOcrServiceStatus())).pid
  expect(workerPid).toBeGreaterThan(0)
  // Use synthetic data only. Exercise actual packaged models, image import and PDF rendering.
  const canvas = createCanvas(1200, 820)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111'; ctx.font = '28px "Noto Sans CJK SC", "Microsoft YaHei"'
  const sample = [
    '电子发票（普通发票）', '发票号码：12345678901234567890', '开票日期：2026年11月06日',
    '购买方 名称：测试购买公司', '纳税人识别号：91310000ABCDEF1234',
    '销售方 名称：测试销售公司', '纳税人识别号：91320000ZYXWVU9876',
    '合计 ¥100.00 ¥6.00', '价税合计（小写）¥106.00',
  ]
  sample.forEach((text, index) => ctx.fillText(text, 60, 75 + index * 70))
  const png = canvas.toBuffer('image/png')
  const imagePath = join(dataDirectory, '内置识别 测试.png')
  const pdfPath = join(dataDirectory, '内置识别 测试.pdf')
  await writeFile(imagePath, png)
  const pdf = await PDFDocument.create()
  const pdfImage = await pdf.embedPng(png)
  pdf.addPage([600, 410]).drawImage(pdfImage, { x: 0, y: 0, width: 600, height: 410 })
  await writeFile(pdfPath, await pdf.save())
  await application.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths }) }, [imagePath, pdfPath])
  const imported = await page.evaluate(() => window.invoiceApi.importFiles())
  expect(imported.failures).toEqual([])
  expect(imported.imported).toHaveLength(2)
  for (const { id } of imported.imported) {
    await expect.poll(() => page.evaluate(async (id) => (await window.invoiceApi.getInvoice(id)).invoice.ocrStatus, id), { timeout: 60000 }).toBe('succeeded')
    const detail = await page.evaluate((id) => window.invoiceApi.getInvoice(id), id)
    expect(detail.invoice).toMatchObject({ invoiceNumber: '12345678901234567890', invoiceDate: '2026-11-06', buyerName: '测试购买公司', sellerName: '测试销售公司', amountExcludingTax: 10000, taxAmount: 600, totalAmount: 10600, reviewStatus: 'needs_review' })
    expect(detail.ocrResults).toHaveLength(1)
    expect(detail.ocrResults[0].evidence.invoiceNumber.region).toMatchObject({ page: 1, imageWidth: 1200, imageHeight: 820 })
  }
  expect((await page.evaluate(() => window.invoiceApi.getOcrServiceStatus())).pid).toBe(workerPid)
  await writeFile(resolve(`artifacts/${version}/ocr-settings.png`), Buffer.from(await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64'))
  console.log('Packaged offline OCR passed: real CPU worker, PNG + PDF, parsed fields, process reuse')
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, dataDirectory)
  const bundle = await page.evaluate(ids => window.invoiceApi.exportReimbursementBundle({ invoiceIds: ids }), imported.imported.map(invoice => invoice.id))
  expect(bundle.count).toBe(2)
  expect((await PDFDocument.load(await readFile(join(bundle.filePath, '合并打印.pdf')))).getPageCount()).toBe(2)
  expect(await readdir(join(bundle.filePath, '原始发票'))).toHaveLength(2)
  expect((await readFile(join(bundle.filePath, '费用清单.xlsx'))).length).toBeGreaterThan(0)
  console.log('Packaged reimbursement bundle passed: XLSX + originals + merged PDF')
  await page.getByRole('link', { name: '统计分析', exact: true }).click()
  await page.locator('.stats-filter .project-select').click()
  const statsMenu = page.locator('.el-select__popper:visible')
  await expect(statsMenu).toHaveCSS('transform', 'none')
  await expect(statsMenu).toHaveCSS('transition-duration', '0s')
  await expect(statsMenu.getByRole('option', { name: '全部项目', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(statsMenu).toBeHidden()
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('0')
  await page.locator('.stats-filter .scope-select').click()
  await page.getByRole('option', { name: '全部发票（含待核对）', exact: true }).click()
  await expect(page.locator('.stat-card').first().locator('strong')).toHaveText('2')
  await expect(page.locator('.stat-card').nth(1).locator('strong')).toHaveText('212.00')
  const reportPath = join(dataDirectory, '统计报表.xlsx')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, reportPath)
  await page.getByRole('button', { name: '导出统计报表', exact: true }).click()
  await expect(page.getByText('已导出 2 张发票的统计报表', { exact: true })).toBeVisible()
  expect((await readFile(reportPath)).subarray(0, 2).toString()).toBe('PK')
  console.log('Packaged statistics passed: confirmed/all scope + XLSX report')
  await page.getByRole('link', { name: '垫付记录', exact: true }).click()
  await page.getByRole('button', { name: '新增垫付', exact: true }).click()
  const advanceEditor = page.getByRole('dialog', { name: '新增垫付', exact: true })
  await advanceEditor.getByRole('textbox', { name: '垫付事项', exact: true }).fill('安装包垫付验证')
  await advanceEditor.getByRole('textbox', { name: '垫付金额', exact: true }).fill('120.00')
  await advanceEditor.getByRole('button', { name: '保存记录', exact: true }).click()
  await expect(advanceEditor).not.toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  const advanceDetail = page.getByRole('dialog', { name: '垫付详情', exact: true })
  await expect(advanceDetail).toBeVisible()
  await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, imagePath)
  await advanceDetail.getByRole('button', { name: '添加附件', exact: true }).click()
  await expect(advanceDetail.getByRole('button', { name: '内置识别 测试.png', exact: true })).toBeVisible()
  await advanceDetail.getByRole('textbox', { name: '本次收回金额', exact: true }).fill('40.00')
  await advanceDetail.getByRole('button', { name: '登记收回', exact: true }).click()
  await expect(advanceDetail.locator('.section-toolbar').last()).toContainText('80.00')
  await advanceDetail.getByRole('button', { name: '完成', exact: true }).click()
  await expect(advanceDetail).not.toBeVisible()
  const advances = await page.evaluate(() => window.invoiceApi.listAdvances({}))
  expect(advances).toMatchObject({ total: 1, amount: 12000, recovered: 4000, remaining: 8000, unbilledAmount: 12000 })
  expect(advances.items[0].attachments).toHaveLength(1)
  const advanceReport = join(dataDirectory, '垫付报表.xlsx')
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }) }, advanceReport)
  await page.getByRole('button', { name: '导出', exact: true }).click()
  await expect(page.getByText('已导出 1 笔垫付记录', { exact: true })).toBeVisible()
  expect((await readFile(advanceReport)).subarray(0, 2).toString()).toBe('PK')
  console.log('Packaged advances passed: create + attachment + partial recovery + XLSX export')
  // Run the bundled models on travel documents, rather than mocking OCR text.
  for (const [kind, text, expected] of [
    ['railway', ['电子发票（铁路电子客票）', '发票号码：99000000123456789001', '开票日期：2026年10月19日',
      '南京南站    G7679    合肥南站', '2026年10月18日 14:33开    二等座', '票价：￥69.00',
      '电子客票号：9900000012345678901234567', '购买方名称：测试大学'],
      { invoiceType: '电子发票（铁路电子客票）', invoiceNumber: '99000000123456789001', invoiceDate: '2026-10-19', totalAmount: 6900 }],
    ['aviation', ['航空运输电子客票行程单', '电子客票号码：781-1234567890', '填开日期：2026年10月19日',
      '票价：800.00', '燃油附加费：40.00', '民航发展基金：50.00', '合计：CNY890.00', '销售单位：测试航空服务有限公司'],
      { invoiceType: '航空运输电子客票行程单', invoiceNumber: '7811234567890', invoiceDate: '2026-10-19', totalAmount: 89000 }],
  ]) {
    const travel = createCanvas(1600, 850), context = travel.getContext('2d')
    context.fillStyle = kind === 'railway' ? '#dff3f5' : '#ffffff'; context.fillRect(0, 0, 1600, 850)
    context.fillStyle = '#111'; context.font = '32px "Noto Sans CJK SC", "Microsoft YaHei"'
    text.forEach((line, index) => context.fillText(line, 55, 70 + index * 85))
    const filePath = join(dataDirectory, `${kind}.pdf`)
    const document = await PDFDocument.create(), image = await document.embedPng(travel.toBuffer('image/png'))
    document.addPage([800, 425]).drawImage(image, { x: 0, y: 0, width: 800, height: 425 })
    await writeFile(filePath, await document.save())
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }) }, filePath)
    const result = await page.evaluate(() => window.invoiceApi.importFiles())
    expect(result.failures).toEqual([])
    const id = result.imported[0].id
    await expect.poll(() => page.evaluate(async id => (await window.invoiceApi.getInvoice(id)).invoice.ocrStatus, id), { timeout: 60000 }).toBe('succeeded')
    const detail = await page.evaluate(id => window.invoiceApi.getInvoice(id), id)
    expect(detail.invoice).toMatchObject(expected)
    expect(detail.invoice.taxAmount).toBeNull()
    expect(detail.invoice.amountExcludingTax).toBeNull()
  }
  console.log('Packaged travel OCR passed: railway ticket + aviation itinerary, actual offline models')
  await page.getByRole('link', { name: '发票管理', exact: true }).click()
  await page.getByText('99000000123456789001', { exact: true }).first().dblclick()
  await expect(page.getByText('识别记录与原始文本', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '更多发票操作' })).toHaveCount(0)
  const attempt = await page.evaluate(async () => {
    const invoice = (await window.invoiceApi.listInvoices({ page: 1, pageSize: 20 })).items.find(item => item.invoiceNumber === '99000000123456789001')
    return { id: invoice.id, count: invoice.ocrAttempts }
  })
  await page.getByRole('button', { name: '重新识别', exact: true }).click()
  await expect.poll(() => page.evaluate(async id => {
    const detail = await window.invoiceApi.getInvoice(id)
    return { status: detail.invoice.ocrStatus, count: detail.invoice.ocrAttempts }
  }, attempt.id), { timeout: 60000 }).toEqual({ status: 'succeeded', count: attempt.count + 1 })
  await expect(page.locator('[data-field="totalAmount"] input')).toHaveValue('69.00')
  console.log('Packaged direct re-recognition passed: toolbar action + automatic field update')
  await page.getByRole('link', { name: '设置', exact: true }).click()
  await page.getByRole('tab', { name: '连接', exact: true }).click()
  await expect(page.getByRole('switch', { name: '启用 MCP 服务', exact: true })).not.toBeChecked()
  const portProbe = createServer()
  await new Promise((done) => portProbe.listen(0, '127.0.0.1', done))
  const port = portProbe.address().port
  await new Promise((done) => portProbe.close(done))
  await page.getByRole('spinbutton', { name: 'MCP 本机端口', exact: true }).fill(String(port))
  await page.getByRole('switch', { name: '启用 MCP 服务', exact: true }).locator('..').click()
  await page.getByRole('button', { name: '保存连接设置', exact: true }).click()
  await expect(page.locator('.connection-state')).toHaveText('运行中')
  const connection = await page.evaluate(() => window.invoiceApi.getMcpConnection())
  const config = JSON.parse(connection.stdio)
  const client = new Client({ name: 'packaged-smoke', version: '1.0.0' })
  try {
    await client.connect(new StdioClientTransport({ ...config, stderr: 'pipe' }))
    expect((await client.listTools()).tools).toHaveLength(7)
    const projects = await client.callTool({ name: 'invoice_list_projects', arguments: {} })
    expect(projects.structuredContent.data.items[0].name).toBe('发布检查项目')
  } finally { await client.close() }
  if (process.env.INVOICE_MCP_INSPECTOR === '1') {
    const configPath = join(dataDirectory, 'inspector-config.json')
    await writeFile(configPath, connection.desktop, { mode: 0o600 })
    let output
    try {
      output = await promisify(execFile)(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `npx --yes @modelcontextprotocol/inspector@v1-latest --cli --config "${configPath}" --server invoice-management --method tools/list`], { timeout: 60000, windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 1024 * 1024 })
    } catch (error) { throw new Error(`Official MCP Inspector compatibility check failed: ${String(error.stderr ?? error.message).replaceAll(connection.token, '<redacted>').slice(0, 2500)}`) }
    // Never print the connection configuration or credentials from the inspector.
    expect(output.stdout).toContain('invoice_list_projects')
    expect(output.stdout).not.toContain('invoice_update_fields')
    console.log('MCP Inspector discovered the packaged read-only tools')
  }
  await page.getByRole('switch', { name: '启用 MCP 服务', exact: true }).locator('..').click()
  await page.getByRole('button', { name: '保存连接设置', exact: true }).click()
  await expect(page.locator('.connection-state')).toHaveText('已关闭')
  await page.getByRole('tab', { name: '数据', exact: true }).click()
  await expect(page.getByRole('button', { name: '创建备份', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '恢复备份', exact: true })).toBeVisible()
  await page.getByRole('tab', { name: '关于', exact: true }).click()
  await expect(page.locator('.about-settings .setting-row').filter({ hasText: '版本' })).toContainText(version)
  await page.getByRole('tab', { name: '数据', exact: true }).click()
  const oldLocation = await page.evaluate(() => window.invoiceApi.getApplicationInfo())
  const movedLocation = join(dataDirectory, 'moved-data')
  await mkdir(movedLocation)
  await application.evaluate(({ app, dialog }, path) => {
    app.relaunch = () => {}
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, movedLocation)
  const exited = new Promise(done => application.process().once('exit', done))
  await page.getByRole('button', { name: '更改目录', exact: true }).click()
  await exited
  application = await electron.launch({ executablePath, args: ['--no-sandbox', `--user-data-dir=${dataDirectory}`], env: launchEnv })
  const migratedPage = await application.firstWindow()
  migratedPage.on('pageerror', error => errors.push(error.message))
  await expect(migratedPage.getByRole('link', { name: '发票管理', exact: true })).toBeVisible()
  expect((await migratedPage.evaluate(() => window.invoiceApi.getApplicationInfo())).dataDirectory).toBe(movedLocation)
  expect((await migratedPage.evaluate(() => window.invoiceApi.listInvoices({ page: 1, pageSize: 20 }))).total).toBe(4)
  const movedAdvances = await migratedPage.evaluate(() => window.invoiceApi.listAdvances({}))
  expect(movedAdvances).toMatchObject({ total: 1, amount: 12000, recovered: 4000, remaining: 8000 })
  expect(movedAdvances.items[0].attachments).toHaveLength(1)
  expect((await readFile(join(oldLocation.dataDirectory, 'invoice.db'))).length).toBeGreaterThan(0)
  console.log('Packaged data migration passed: actual restart + invoice/advance/attachment persistence')
  expect(errors).toEqual([])
  console.log('Packaged application smoke test passed')
} finally {
  await application?.close()
  if (workerPid) await expect.poll(() => { try { process.kill(workerPid, 0); return true } catch { return false } }).toBe(false)
  if (!resolve(dataDirectory).startsWith(temporaryRoot + '\\')) throw new Error('Unexpected smoke-test data path')
  await rm(dataDirectory, { recursive: true, force: true })
}
