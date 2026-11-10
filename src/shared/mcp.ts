import { z } from 'zod'

export const mcpSettingsSchema = z.object({ enabled: z.boolean().default(false), allowWrites: z.boolean().default(false), port: z.number().int().min(1024).max(65535).default(17862) }).strict()
export type McpSettings = z.infer<typeof mcpSettingsSchema>
export const DEFAULT_MCP_SETTINGS = mcpSettingsSchema.parse({})
export const MCP_CONNECTION_FORMATS = ['http', 'stdio', 'desktop', 'code', 'url', 'authorization', 'token', 'command', 'args', 'env'] as const
export type McpConnectionFormat = typeof MCP_CONNECTION_FORMATS[number]
export type McpConnection = Record<McpConnectionFormat, string>
export interface McpToolInfo { name: string; title: string; writable: boolean }
export interface McpStatus { state: 'stopped' | 'running' | 'error'; url: string; settings: McpSettings; error?: string; warning?: string; requestCount: number; lastCall?: { tool: string; time: string; success: boolean }; tools: McpToolInfo[] }
export interface McpApi {
  getMcpStatus: () => Promise<McpStatus>
  saveMcpSettings: (settings: McpSettings) => Promise<McpStatus>
  rotateMcpToken: () => Promise<McpStatus>
  getMcpConnection: () => Promise<McpConnection>
  copyMcpConnection: (format: McpConnectionFormat) => Promise<void>
  onDataChanged: (callback: () => void) => () => void
}
