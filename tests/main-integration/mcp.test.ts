import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { InvoiceDatabase } from '../../src/main/db/database'
import { InvoiceService } from '../../src/main/services/invoice-service'
import { ImportService } from '../../src/main/services/import-service'
import { McpService } from '../../src/main/services/mcp-service'
import { seedMcpFixture } from '../fixtures/mcp-fixture'

let directory: string, db: InvoiceDatabase, service: McpService, invoices: InvoiceService
let fixture: ReturnType<typeof seedMcpFixture>, busy = false
const clients: Client[] = [], servers: Server[] = []
const changed = vi.fn()
async function freePort(): Promise<number> {
  const server = createServer(); await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((done) => server.close(() => done())); return port
}
async function start(writes = false) { await service.configure({ enabled: true, allowWrites: writes, port: await freePort() }) }
async function connect(token = service.connection('', '').token): Promise<Client> {
  const client = new Client({ name: 'invoice-protocol-test', version: '1.0.0' })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(service.getStatus().url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  return client
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(JSON.stringify(result.content))
  return (result.structuredContent as { data: any }).data
}
const headers = () => ({ Authorization: `Bearer ${service.connection('', '').token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' })
const dependencies = () => ({ db, invoices, version: '0.7.4', changed, isBusy: () => busy })
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-mcp-')); db = new InvoiceDatabase(directory)
  invoices = new InvoiceService(db, new ImportService(db, directory, vi.fn()))
  fixture = seedMcpFixture(db); busy = false; changed.mockClear()
  service = new McpService(directory, dependencies()); await service.initialize()
})
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await service.stop()
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => done()) })))
  db.close()
  if (!resolve(directory).startsWith(resolve(tmpdir()) + '\\')) throw new Error('Unexpected fixture path')
  await rm(directory, { recursive: true, force: true })
})

it('默认关闭；标准 SDK 握手、只读工具发现、资源和分页正常', async () => {
  expect(service.getStatus()).toMatchObject({ state: 'stopped', settings: { enabled: false, allowWrites: false } })
  await start(); const client = await connect()
  const tools = await client.listTools()
  expect(tools.tools).toHaveLength(7)
  expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint)).toBe(true)
  expect(tools.tools.some((tool) => tool.name === 'invoice_update_fields')).toBe(false)
  expect((await client.readResource({ uri: 'invoice://guide' })).contents[0]).toMatchObject({ text: expect.stringContaining('整数分') })
  const first = await call(client, 'invoice_list', { pageSize: 2 })
  expect(first).toMatchObject({ total: 5, hasMore: true, nextPage: 2 })
  const second = await call(client, 'invoice_list', { page: 2, pageSize: 2 })
  expect(new Set([...first.items, ...second.items].map((item: any) => item.id)).size).toBe(4)
  const last = await call(client, 'invoice_list', { page: 3, pageSize: 2 })
  expect(last).toMatchObject({ hasMore: false, nextPage: null }); expect(last.items).toHaveLength(1)
  expect((await call(client, 'invoice_get_app_info')).invoiceCount).toBe(5)
  expect(changed).not.toHaveBeenCalled()
})

it('通用配置提供独立 HTTP/stdio 参数；多个客户端可同时连接', async () => {
  await start()
  const config = service.connection('C:\\Invoice App\\app.exe', 'C:\\Invoice App\\bridge.js')
  const http = JSON.parse(config.http), stdio = JSON.parse(config.stdio)
  expect(http.type).toBe('http'); expect(http.url).toBe(service.getStatus().url)
  expect(http.headers.Authorization === config.authorization).toBe(true)
  expect(stdio.command).toBe(config.command); expect(stdio.args).toEqual(JSON.parse(config.args))
  expect(stdio.env.INVOICE_MCP_TOKEN === JSON.parse(config.env).INVOICE_MCP_TOKEN).toBe(true)
  expect(JSON.parse(config.desktop).mcpServers['invoice-management'].command).toBe(stdio.command)
  const first = await connect(), second = await connect()
  await Promise.all([call(first, 'invoice_list'), call(second, 'invoice_list_projects')])
  await first.close()
  expect((await call(second, 'invoice_list')).total).toBe(5)
})

it('无效令牌、外部 Origin/Host、无效路径及超大请求被拒绝', async () => {
  await start(); const url = service.getStatus().url
  expect((await fetch(url)).status).toBe(401)
  expect((await fetch(url, { headers: { ...headers(), Origin: 'https://evil.example' } })).status).toBe(403)
  const hostStatus = await new Promise<number | undefined>((done, reject) => {
    request(url, { headers: { ...headers(), Host: 'evil.example' } }, (response) => { response.resume(); done(response.statusCode) }).on('error', reject).end()
  })
  expect(hostStatus).toBe(403)
  expect((await fetch(url + '/wrong', { headers: headers() })).status).toBe(404)
  expect((await fetch(url, { headers: headers() })).status).toBe(405)
  expect((await fetch(url, { method: 'POST', headers: headers(), body: '{bad' })).status).toBe(400)
  expect((await fetch(url, { method: 'POST', headers: headers(), body: 'x'.repeat(1024 * 1024 + 1) })).status).toBe(413)
  await expect(connect('wrong-token')).rejects.toThrow()
})

it('开放写入后沿用业务规则；校正、确认、标签、项目、状态均可调用', async () => {
  await start(true); const client = await connect(), id = fixture.invoices[0].id
  expect((await client.listTools()).tools).toHaveLength(15)
  let detail = await call(client, 'invoice_get', { id })
  detail = await call(client, 'invoice_update_fields', { id, expectedRevision: detail.revision, changes: { remark: '校对记录', totalAmount: 10800 } })
  expect(detail.invoice).toMatchObject({ reviewStatus: 'needs_review', totalAmount: 10800, remark: '校对记录', sellerName: '科仪商贸' })
  detail = await call(client, 'invoice_confirm', { id, expectedRevision: detail.revision })
  expect(detail.invoice.reviewStatus).toBe('confirmed')
  detail = await call(client, 'invoice_set_tags', { id, expectedRevision: detail.revision, tags: ['办公', '已核对'] })
  expect(detail.invoice.tags).toEqual(['办公', '已核对'])
  detail = await call(client, 'invoice_set_project', { id, expectedRevision: detail.revision, projectId: fixture.travel.id })
  expect(detail.invoice.projects).toEqual([{ id: fixture.travel.id, name: '会议出差' }])
  detail = await call(client, 'invoice_set_project', { id, expectedRevision: detail.revision, projectId: null })
  expect(detail.invoice.projects).toEqual([])
  detail = await call(client, 'invoice_set_status', { id, expectedRevision: detail.revision, status: 'booked' })
  expect(detail.invoice.status).toBe('booked')
  expect(changed).toHaveBeenCalledTimes(6)
  expect(service.getStatus().lastCall).toMatchObject({ tool: 'invoice_set_status', success: true })
})

it('拒绝旧版本、无效日期及回收站写入，不覆盖已有数据', async () => {
  await start(true); const client = await connect(), id = fixture.invoices[0].id
  const detail = await call(client, 'invoice_get', { id })
  await call(client, 'invoice_update_fields', { id, expectedRevision: detail.revision, changes: { remark: '先到的修改' } })
  await expect(call(client, 'invoice_set_tags', { id, expectedRevision: detail.revision, tags: [] })).rejects.toThrow('DATA_CONFLICT')
  const current = await call(client, 'invoice_get', { id })
  await expect(call(client, 'invoice_update_fields', { id, expectedRevision: current.revision, changes: { invoiceDate: '2026-02-30' } })).rejects.toThrow('INVALID_DATE')
  await expect(call(client, 'invoice_update_fields', { id, expectedRevision: current.revision, changes: { totalAmount: -1 } })).rejects.toThrow()
  const deleted = await call(client, 'invoice_get', { id: fixture.invoices[4].id })
  await expect(call(client, 'invoice_set_status', { id: deleted.invoice.id, expectedRevision: deleted.revision, status: 'booked' })).rejects.toThrow('INVOICE_NOT_FOUND')
  expect(db.get(id)?.remark).toBe('先到的修改'); expect(changed).toHaveBeenCalledTimes(1)
})

it('备份恢复期间阻止修改；关闭写入权限后旧客户端也无法继续写', async () => {
  await start(true); const client = await connect(), id = fixture.invoices[0].id
  const detail = await call(client, 'invoice_get', { id }); busy = true
  await expect(call(client, 'invoice_set_tags', { id, expectedRevision: detail.revision, tags: [] })).rejects.toThrow('DATA_BUSY')
  expect((await call(client, 'invoice_list')).total).toBe(5); busy = false
  await service.configure({ ...service.getStatus().settings, allowWrites: false })
  await expect(call(client, 'invoice_set_tags', { id, expectedRevision: detail.revision, tags: [] })).rejects.toThrow()
  expect((await client.listTools()).tools).toHaveLength(7)
  expect(changed).not.toHaveBeenCalled()
})

it('项目创建与重命名检查重复和版本', async () => {
  await start(true); const client = await connect()
  const project = await call(client, 'invoice_create_project', { name: '研究项目', description: '采购' })
  await expect(call(client, 'invoice_create_project', { name: '研究项目' })).rejects.toThrow('同名')
  const updated = await call(client, 'invoice_update_project', { id: project.id, expectedRevision: project.revision, name: '研究项目二', description: '更新' })
  expect(updated.name).toBe('研究项目二')
  await expect(call(client, 'invoice_update_project', { id: project.id, expectedRevision: project.revision, name: '旧快照' })).rejects.toThrow('DATA_CONFLICT')
})

it('令牌轮换立即撤销旧凭证，配置和新凭证跨重启保留', async () => {
  await start(); const old = service.connection('app.exe', 'bridge.js')
  expect(JSON.parse(old.desktop).mcpServers['invoice-management']).toMatchObject({ command: 'app.exe', args: ['bridge.js'], env: { ELECTRON_RUN_AS_NODE: '1' } })
  await service.rotateToken()
  expect(service.connection('', '').token).not.toBe(old.token)
  expect((await fetch(service.getStatus().url, { headers: { ...headers(), Authorization: `Bearer ${old.token}` } })).status).toBe(401)
  const settings = service.getStatus().settings, token = service.connection('', '').token
  await service.stop(); service = new McpService(directory, dependencies()); await service.initialize()
  expect(service.getStatus()).toMatchObject({ state: 'running', settings })
  expect(service.connection('', '').token).toBe(token)
  expect((await call(await connect(), 'invoice_list')).total).toBe(5)
})

it('端口冲突保留原服务和配置；关闭后停止监听', async () => {
  await start(); const original = service.getStatus(), stored = await readFile(join(directory, 'mcp-settings.json'), 'utf8')
  const occupied = createServer(); servers.push(occupied)
  await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done))
  await expect(service.configure({ ...original.settings, port: (occupied.address() as AddressInfo).port })).rejects.toThrow('端口已被占用')
  expect(service.getStatus()).toMatchObject(original)
  expect(await readFile(join(directory, 'mcp-settings.json'), 'utf8')).toBe(stored)
  expect((await call(await connect(), 'invoice_list')).total).toBe(5)
  await service.configure({ ...original.settings, enabled: false })
  await expect(fetch(original.url)).rejects.toThrow()
})

it('损坏的配置以关闭状态启动，可重新保存修复', async () => {
  await service.stop(); await writeFile(join(directory, 'mcp-settings.json'), 'invalid')
  service = new McpService(directory, dependencies()); await service.initialize()
  expect(service.getStatus()).toMatchObject({ state: 'stopped', warning: expect.any(String) })
  await start(); expect(service.getStatus().warning).toBeUndefined()
})

it('界面字段版本允许自身标签和状态调整，拦截外部字段覆盖', () => {
  const id = fixture.invoices[0].id, initial = invoices.detail(id)
  db.setInvoiceTags(id, ['新标签']); db.batchSetStatus([id], 'reimbursed')
  const saved = invoices.save(id, { ...initial.invoice, remark: '界面编辑' }, false, undefined, initial.fieldRevision)
  expect(saved.invoice).toMatchObject({ tags: ['新标签'], status: 'reimbursed', remark: '界面编辑' })
  invoices.save(id, { ...saved.invoice, sellerName: '外部修改' }, false, saved.revision)
  expect(() => invoices.save(id, { ...saved.invoice, remark: '过期编辑' }, false, undefined, saved.fieldRevision)).toThrow('已在其他位置更新')
  expect(db.get(id)?.sellerName).toBe('外部修改')
})

it('OCR 详情截断并明确标记，原始响应不对外暴露', async () => {
  const id = fixture.invoices[0].id
  db.recordOcrSuccess(id, { rawResponse: { privateRaw: true }, normalizedText: '文'.repeat(9000), parsedFields: {}, evidence: {}, warnings: ['人工核对'] })
  await start(); const client = await connect()
  const detail = await call(client, 'invoice_get', { id })
  expect(detail.ocr).toMatchObject({ truncated: true, warnings: ['人工核对'] }); expect(detail.ocr.text).toHaveLength(8000)
  expect(JSON.stringify(detail)).not.toContain('privateRaw')
  expect((await call(client, 'invoice_get', { id, includeOcrText: false })).ocr).toBeNull()
})

it('十条只读评估答案由真实 MCP 工具返回值计算', async () => {
  await start(); const client = await connect()
  const projects = await call(client, 'invoice_list_projects'), equipment = projects.items.find((p: any) => p.description.includes('电脑'))
  const all = await call(client, 'invoice_list', { pageSize: 100 }), info = await call(client, 'invoice_get_app_info')
  const stats = await call(client, 'invoice_get_stats'), projectStats = await call(client, 'invoice_get_stats', { projectId: equipment.id })
  const november = await call(client, 'invoice_get_stats', { dateFrom: '2026-11-01', dateTo: '2026-11-30' })
  const submitted = await call(client, 'invoice_list', { status: 'booked', reviewStatus: 'confirmed' })
  const orphan = await call(client, 'invoice_list', { projectId: null }), orphanStats = await call(client, 'invoice_get_stats', { projectId: null })
  const trips = await call(client, 'invoice_list', { tag: '差旅' })
  const largest = all.items.reduce((a: any, b: any) => a.totalAmount > b.totalAmount ? a : b)
  const detail = await call(client, 'invoice_get', { id: largest.id })
  const answers = [String(stats.totalAmount), String(info.invoiceCount - stats.invoiceCount), String(projectStats.totalAmount), String(november.totalAmount), String(submitted.items.reduce((sum: number, i: any) => sum + i.totalAmount, 0)), String(orphanStats.totalAmount), String(trips.items.filter((i: any) => i.invoiceDate.startsWith('2026-11')).reduce((sum: number, i: any) => sum + i.totalAmount, 0)), detail.invoice.invoiceNumber, String(equipment.invoiceCount), String(info.trashCount)]
  expect(orphan.total).toBe(2)
  const xml = await readFile(resolve('docs/mcp-evaluation.xml'), 'utf8')
  expect(answers).toEqual([...xml.matchAll(/<answer>(.*?)<\/answer>/g)].map((match) => match[1]))
  expect(changed).not.toHaveBeenCalled()
})
