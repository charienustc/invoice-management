import { createInterface } from 'node:readline'

// Byte-level transport bridge: protocol validation and tools stay in the running app's SDK server.
const endpoint = new URL(process.env.INVOICE_MCP_URL ?? 'http://127.0.0.1:17862/mcp')
const token = process.env.INVOICE_MCP_TOKEN
if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/mcp' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !token) {
  process.stderr.write('Invalid invoice MCP URL or missing token. Copy the connection configuration from the running app.\n')
  process.exit(1)
}
let protocolVersion: string | undefined, active = 0
const controllers = new Set<AbortController>()
function write(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`) }
const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
reader.on('line', (line) => {
  if (!line.trim()) return
  void (async () => {
    let message: { id?: string | number | null; method?: string; jsonrpc?: string }
    try { if (Buffer.byteLength(line) > 1024 * 1024) throw new Error(); message = JSON.parse(line); if (!message || Array.isArray(message) || message.jsonrpc !== '2.0') throw new Error() }
    catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON-RPC message' } }); return }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id')
    if (active >= 16) { if (hasId) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Too many active requests' } }); return }
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30000)
    active++; controllers.add(controller)
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
      if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion
      const response = await fetch(endpoint, { method: 'POST', headers, body: line, signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw new Error(response.status === 401 ? '令牌已失效，请从发票软件重新复制配置' : '请保持发票软件打开，并启用 MCP 服务')
      if (response.status === 204) return
      const result = await response.json() as { result?: { protocolVersion?: string } }
      if (message.method === 'initialize' && result.result?.protocolVersion) protocolVersion = result.result.protocolVersion
      if (hasId) write(result)
    } catch (error) { if (hasId) write({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: error instanceof Error && !error.message.includes('fetch') ? error.message : '无法连接发票软件，请确认应用已打开、MCP 已启用且令牌正确' } }) }
    finally { clearTimeout(timer); active--; controllers.delete(controller) }
  })()
})
reader.on('close', () => { for (const controller of controllers) controller.abort() })
