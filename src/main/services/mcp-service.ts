import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { mcpSettingsSchema, DEFAULT_MCP_SETTINGS, type McpSettings, type McpStatus, type McpConnection } from '@shared/mcp'
import { AppError } from '@shared/errors'
import { createInvoiceMcpServer, MCP_TOOLS, type McpToolContext } from './mcp-tools'

const storedSchema = z.object({ settings: mcpSettingsSchema, token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
type Dependencies = Pick<McpToolContext, 'db' | 'invoices' | 'serviceManager' | 'version' | 'changed'> & { isBusy: () => boolean }
const MAX_BODY = 1024 * 1024

export class McpService {
  private settings: McpSettings = { ...DEFAULT_MCP_SETTINGS }
  private token = randomBytes(32).toString('base64url')
  private http?: Server
  private state: McpStatus['state'] = 'stopped'
  private error?: string
  private warning?: string
  private sequence: Promise<unknown> = Promise.resolve()
  private requestCount = 0
  private lastCall?: McpStatus['lastCall']
  private active = 0
  private disposed = false
  constructor(private readonly directory: string, private readonly dependencies: Dependencies) {}
  getStatus(): McpStatus { return { state: this.state, settings: { ...this.settings }, url: `http://127.0.0.1:${this.settings.port}/mcp`, error: this.error, warning: this.warning, requestCount: this.requestCount, lastCall: this.lastCall ? { ...this.lastCall } : undefined, tools: MCP_TOOLS.filter((tool) => !tool.writable || this.settings.allowWrites).map((tool) => ({ ...tool })) } }
  async initialize(): Promise<void> {
    try { const stored = storedSchema.parse(JSON.parse(await readFile(join(this.directory, 'mcp-settings.json'), 'utf8'))); this.settings = stored.settings; this.token = stored.token }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { this.settings = { ...DEFAULT_MCP_SETTINGS }; this.warning = 'MCP 配置无法读取，服务已关闭。重新保存可修复。' } }
    if (this.settings.enabled) try { this.http = await this.listen(this.settings.port); this.state = 'running' } catch (error) { this.state = 'error'; this.error = this.listenError(error) }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> { const operation = this.sequence.then(action); this.sequence = operation.catch(() => {}); return operation }
  private async persist(settings: McpSettings, token: string): Promise<void> {
    await mkdir(this.directory, { recursive: true })
    const temporary = join(this.directory, `mcp-settings-${randomUUID()}.tmp`)
    try { await writeFile(temporary, JSON.stringify({ settings, token }, null, 2), { mode: 0o600 }); await rename(temporary, join(this.directory, 'mcp-settings.json')) }
    finally { await unlink(temporary).catch(() => {}) }
  }
  configure(input: McpSettings): Promise<McpStatus> {
    const settings = mcpSettingsSchema.parse(input)
    return this.serial(async () => {
      if (this.disposed) throw new AppError('MCP_STOPPED', '应用正在退出')
      let candidate: Server | undefined
      if (settings.enabled && (!this.http || settings.port !== this.settings.port)) {
        try { candidate = await this.listen(settings.port) } catch (error) { throw new AppError('MCP_LISTEN_FAILED', this.listenError(error)) }
      }
      try {
        if (this.disposed) throw new AppError('MCP_STOPPED', '应用正在退出')
        await this.persist(settings, this.token)
        if (this.disposed) throw new AppError('MCP_STOPPED', '应用正在退出')
      } catch (error) { if (candidate) await this.close(candidate); throw error }
      const previous = this.http
      this.settings = settings; this.warning = undefined; this.error = undefined
      if (!settings.enabled) { this.http = undefined; this.state = 'stopped'; if (previous) await this.close(previous) }
      else { this.http = candidate ?? previous; this.state = 'running'; if (candidate && previous) await this.close(previous) }
      return this.getStatus()
    })
  }
  rotateToken(): Promise<McpStatus> {
    return this.serial(async () => { if (this.disposed) throw new AppError('MCP_STOPPED', '应用正在退出'); const token = randomBytes(32).toString('base64url'); await this.persist(this.settings, token); this.token = token; this.http?.closeAllConnections(); this.warning = undefined; return this.getStatus() })
  }
  connection(executable: string, bridge: string): McpConnection {
    const url = this.getStatus().url
    const authorization = `Bearer ${this.token}`
    const http = { type: 'http', url, headers: { Authorization: authorization } }
    const stdio = { command: executable, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1', INVOICE_MCP_URL: url, INVOICE_MCP_TOKEN: this.token } }
    const json = (value: unknown) => JSON.stringify(value, null, 2)
    return {
      http: json(http), stdio: json(stdio), url, authorization,
      command: executable, args: json(stdio.args), env: json(stdio.env),
      desktop: json({ mcpServers: { 'invoice-management': stdio } }),
      code: json({ mcpServers: { 'invoice-management': http } }),
      token: this.token,
    }
  }
  async stop(): Promise<void> { this.disposed = true; const previous = this.http; this.http = undefined; this.state = 'stopped'; if (previous) await this.close(previous) }
  private close(server: Server): Promise<void> { server.closeAllConnections(); return new Promise((resolve) => server.close(() => resolve())) }
  private listenError(error: unknown): string { return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE' ? '端口已被占用，请更换 MCP 端口后重试' : '本机 MCP 服务无法启动，请检查端口和系统网络权限' }
  private async listen(port: number): Promise<Server> {
    const server = createServer((request, response) => { void this.handle(request, response, port) })
    server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 40
    server.on('error', (error) => { if (this.http === server) { this.state = 'error'; this.error = this.listenError(error) } })
    await new Promise<void>((resolve, reject) => { const fail = (error: Error) => reject(error); server.once('error', fail); server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); resolve() }) })
    return server
  }
  private authenticated(request: IncomingMessage): boolean { const value = Buffer.from(request.headers.authorization ?? ''); const expected = Buffer.from(`Bearer ${this.token}`); return value.length === expected.length && timingSafeEqual(value, expected) }
  private reply(response: ServerResponse, status: number, message: string): void { if (response.headersSent || response.destroyed) return; response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Connection: 'close' }); response.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } })) }
  private body(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let length = 0
      const chunks: Buffer[] = []
      const cleanup = () => { request.removeListener('data', data); request.removeListener('end', end); request.removeListener('error', fail); request.removeListener('aborted', aborted) }
      const fail = (error: Error) => { cleanup(); reject(error) }
      const aborted = () => fail(new AppError('REQUEST_ABORTED', '请求已中断'))
      const data = (chunk: Buffer) => { length += chunk.length; if (length > MAX_BODY) { cleanup(); request.resume(); reject(new AppError('REQUEST_TOO_LARGE', '请求不能超过 1 MB')) } else chunks.push(chunk) }
      const end = () => { cleanup(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new AppError('INVALID_JSON', '请求不是有效 JSON')) } }
      request.on('data', data); request.on('end', end); request.on('error', fail); request.on('aborted', aborted)
    })
  }
  private async handle(request: IncomingMessage, response: ServerResponse, port: number): Promise<void> {
    const host = request.headers.host?.toLowerCase()
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host ?? '')) { this.reply(response, 403, 'Host not allowed'); return }
    const origin = request.headers.origin
    if (origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin)) { this.reply(response, 403, 'Origin not allowed'); return }
    if (request.url !== '/mcp') { this.reply(response, 404, 'Not found'); return }
    if (!this.authenticated(request)) { this.reply(response, 401, 'Invalid MCP bearer token'); return }
    if (this.disposed || !this.settings.enabled) { this.reply(response, 503, 'MCP service is stopped'); return }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST'); this.reply(response, 405, 'Use POST for stateless Streamable HTTP'); return }
    if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { this.reply(response, 415, 'Use application/json'); return }
    if (Number(request.headers['content-length']) > MAX_BODY) { this.reply(response, 413, 'Request too large'); return }
    if (this.active >= 16) { this.reply(response, 429, 'Too many active MCP requests'); return }
    this.active++
    let mcp: ReturnType<typeof createInvoiceMcpServer> | undefined
    try {
      const body = await this.body(request)
      if (!this.authenticated(request)) { this.reply(response, 401, 'MCP token changed'); return }
      if (this.disposed || !this.settings.enabled) { this.reply(response, 503, 'MCP service is stopped'); return }
      mcp = createInvoiceMcpServer({ ...this.dependencies, allowWrites: this.settings.allowWrites, check: (write) => {
        if (this.disposed || !this.settings.enabled) throw new AppError('MCP_STOPPED', 'MCP 服务已关闭')
        if (write && !this.settings.allowWrites) throw new AppError('MCP_READ_ONLY', 'MCP 目前为只读，请在应用的连接设置中开启写入权限')
        if (write && this.dependencies.isBusy()) throw new AppError('DATA_BUSY', '数据正在备份或恢复，请稍后重试')
      }, record: (tool, success) => { this.requestCount++; this.lastCall = { tool, success, time: new Date().toISOString() } } })
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(transport)
      await transport.handleRequest(request, response, body)
    } catch (error) {
      this.reply(response, error instanceof AppError && error.code === 'REQUEST_TOO_LARGE' ? 413 : error instanceof AppError && error.code === 'INVALID_JSON' ? 400 : 500, error instanceof AppError ? error.message : 'MCP request failed')
    } finally { this.active--; await mcp?.close().catch(() => {}) }
  }
}
