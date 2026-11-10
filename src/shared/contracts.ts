import { z } from 'zod'
import type { McpApi } from './mcp'
import type { AdvanceApi } from './advances'

export const OCR_STATUSES = ['pending', 'queued', 'running', 'succeeded', 'failed'] as const
export const REVIEW_STATUSES = ['unreviewed', 'needs_review', 'confirmed'] as const
export const INVOICE_STATUSES = ['unprocessed', 'reimbursed', 'booked', 'void'] as const
export type OcrStatus = (typeof OCR_STATUSES)[number]
export type ReviewStatus = (typeof REVIEW_STATUSES)[number]
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

export interface InvoiceFields {
  invoiceType: string
  invoiceCode: string
  invoiceNumber: string
  invoiceDate: string
  buyerName: string
  buyerTaxId: string
  sellerName: string
  sellerTaxId: string
  amountExcludingTax: number | null
  taxAmount: number | null
  totalAmount: number | null
  remark: string
}

export const invoiceFieldsSchema = z.object({
  invoiceType: z.string().max(80),
  invoiceCode: z.string().max(32),
  invoiceNumber: z.string().max(32),
  invoiceDate: z.string().max(10).refine((value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value), '日期格式应为 YYYY-MM-DD'),
  buyerName: z.string().max(200),
  buyerTaxId: z.string().max(32),
  sellerName: z.string().max(200),
  sellerTaxId: z.string().max(32),
  amountExcludingTax: z.number().int().nonnegative().nullable(),
  taxAmount: z.number().int().nonnegative().nullable(),
  totalAmount: z.number().int().nonnegative().nullable(),
  remark: z.string().max(2000),
})

export interface Invoice extends InvoiceFields {
  id: string
  fileName: string
  mimeType: string
  fileSize: number
  sha256: string
  ocrStatus: OcrStatus
  reviewStatus: ReviewStatus
  status: InvoiceStatus
  tags: string[]
  projects: ProjectRef[]
  deletedAt: string | null
  ocrError: string | null
  ocrAttempts: number
  manualFields: Array<keyof InvoiceFields>
  businessKey: string | null
  createdAt: string
  updatedAt: string
}

export interface ProjectRef { id: string; name: string }
export interface InvoiceProject extends ProjectRef {
  description: string
  invoiceCount: number
  confirmedCount: number
  confirmedAmount: number
  createdAt: string
  updatedAt: string
}
export const projectInputSchema = z.object({ name: z.string().trim().min(1, '请输入项目名称').max(80), description: z.string().trim().max(1000).default('') })
export const updateProjectInputSchema = projectInputSchema.extend({ id: z.string().uuid() })

export interface OcrFieldEvidence {
  lineId?: number
  rule: string
  confidence?: number
  region?: { page: number; bbox: number[][]; imageWidth?: number; imageHeight?: number }
}

export interface OcrResultInfo {
  id: string
  rawResponse: unknown
  normalizedText: string
  parsedFields: Partial<InvoiceFields>
  evidence: Partial<Record<keyof InvoiceFields, OcrFieldEvidence>>
  warnings: string[]
  createdAt: string
}

export interface InvoiceDetail {
  revision: string
  fieldRevision: string
  invoice: Invoice
  ocrResults: OcrResultInfo[]
  duplicates: Invoice[]
}

export const invoiceFilterSchema = z.object({
  sellerName: z.string().max(500).optional(),
  missingField: z.enum(['invoiceDate', 'totalAmount', 'amountExcludingTax', 'taxAmount', 'invoiceType']).optional(),
  keyword: z.string().max(200).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  invoiceType: z.string().max(80).optional(),
  ocrStatus: z.enum(OCR_STATUSES).optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  statuses: z.array(z.enum(INVOICE_STATUSES)).min(1).max(4).optional(),
  tag: z.string().max(50).optional(),
  amountMin: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  amountMax: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  deleted: z.boolean().optional(),
  projectId: z.string().uuid().nullable().optional(),
})

export const invoiceQuerySchema = invoiceFilterSchema.extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(100).default(20),
})

export type InvoiceFilter = z.infer<typeof invoiceFilterSchema>
export const statsFilterSchema = invoiceFilterSchema.extend({ reviewScope: z.enum(['confirmed', 'all']).optional() }).superRefine((value, context) => {
  for (const key of ['dateFrom', 'dateTo'] as const) {
    const date = value[key]
    if (date) {
      const parsed = new Date(`${date}T00:00:00Z`)
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) context.addIssue({ code: 'custom', path: [key], message: '请选择有效日期' })
    }
  }
  if (value.dateFrom && value.dateTo && value.dateFrom > value.dateTo) context.addIssue({ code: 'custom', path: ['dateTo'], message: '结束日期不能早于开始日期' })
})
export type StatsFilter = z.infer<typeof statsFilterSchema>
export type InvoiceQuery = z.infer<typeof invoiceQuerySchema>

export interface InvoiceListResult {
  items: Invoice[]
  total: number
  page: number
  pageSize: number
}

export interface ImportDuplicate {
  fileName: string
  invoiceId: string
  deleted: boolean
}

export interface ImportFailure {
  fileName: string
  message: string
}

export interface ImportSummary {
  imported: Invoice[]
  duplicates: ImportDuplicate[]
  failures: ImportFailure[]
  warnings?: string[]
}

export const appSettingsSchema = z.object({
  openAtLogin: z.boolean().default(false),
  startupPage: z.enum(['invoices', 'stats']).default('invoices'),
  rememberWindowState: z.boolean().default(true),
  sidebarExpanded: z.boolean().default(true),
  pageSize: z.union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)]).default(20),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  uiScale: z.union([z.literal(90), z.literal(100), z.literal(110), z.literal(125)]).default(100),
  motion: z.enum(['system', 'reduce']).default('system'),
  colorMode: z.enum(['system', 'light', 'dark']).default('system'),
  autoRecognize: z.boolean().default(true),
  defaultProjectId: z.string().uuid().nullable().default(null),
})
export type AppSettings = z.infer<typeof appSettingsSchema>
export const DEFAULT_APP_SETTINGS: AppSettings = appSettingsSchema.parse({})
export interface ApplicationInfo {
  version: string
  electronVersion: string
  platform: string
  arch: string
  dataDirectory: string
  defaultDataDirectory?: string
  configDirectory?: string
  invoiceCount: number
  trashCount: number
  originalBytes: number
  loginStartupSupported: boolean
  preferencesWarning?: string
}

export interface SaveInvoiceInput {
  id: string
  fields: InvoiceFields
  confirm: boolean
  expectedRevision?: string
  expectedFieldRevision?: string
}

export const saveInvoiceInputSchema = z.object({
  id: z.string().uuid(),
  fields: invoiceFieldsSchema,
  confirm: z.boolean(),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedFieldRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
})

export const ocrSettingsSchema = z.object({
  engineMode: z.enum(['builtin', 'external']).default('builtin'),
  endpoint: z.string().max(2048).refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }, 'OCR 地址必须是有效的 HTTP/HTTPS URL'),
  requestProtocol: z.enum(['paddlex-json', 'multipart']),
  fileField: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  timeoutMs: z.number().int().min(1000).max(120_000),
  concurrency: z.number().int().min(1).max(3),
  maxRetries: z.number().int().min(0).max(5),
  adapter: z.enum(['auto', 'paddle', 'lines']),
  autoStart: z.boolean(),
  startupExecutable: z.string().max(32_767),
  startupArgs: z.array(z.string().max(4096)).max(64),
  startupWorkingDirectory: z.string().max(32_767),
  startupTimeoutMs: z.number().int().min(10_000).max(600_000),
})

export type OcrSettings = z.infer<typeof ocrSettingsSchema>

export const DEFAULT_OCR_SETTINGS: OcrSettings = {
  engineMode: 'builtin',
  endpoint: 'http://127.0.0.1:8080/ocr',
  requestProtocol: 'paddlex-json',
  fileField: 'file',
  timeoutMs: 60_000,
  concurrency: 2,
  maxRetries: 2,
  adapter: 'auto',
  autoStart: true,
  startupExecutable: '',
  startupArgs: ['--pipeline', 'OCR', '--serve', '--host', '127.0.0.1', '--port', '8080'],
  startupWorkingDirectory: '',
  startupTimeoutMs: 180_000,
}

export type OcrServiceState = 'unconfigured' | 'checking' | 'starting' | 'online' | 'offline' | 'error'

export interface OcrServiceStatus {
  state: OcrServiceState
  message: string
  pid?: number
  managedByApp: boolean
  lastCheckedAt?: string
}

export interface OcrProgress {
  invoiceId: string
  status: OcrStatus
  attempt: number
  error?: string
}

export interface OcrConnectionResult {
  lineCount: number
  durationMs: number
}

export interface InvoiceStats {
  invoiceCount: number
  totalAmount: number
  taxAmount: number
  amountExcludingTax: number
  averageAmount: number
  confirmedCount: number
  missing: { invoiceDate: number; totalAmount: number; amountExcludingTax: number; taxAmount: number }
  byStatus: Array<{ status: InvoiceStatus; invoiceCount: number; totalAmount: number }>
  byProject: Array<{ projectId: string | null; name: string; invoiceCount: number; totalAmount: number }>
  bySeller: Array<{ name: string; invoiceCount: number; totalAmount: number }>
  monthly: Array<{
    month: string
    invoiceCount: number
    totalAmount: number
    taxAmount: number
  }>
  byType: Array<{
    invoiceType: string
    typeKey: string
    invoiceCount: number
    totalAmount: number
  }>
}

export const EXPORT_COLUMNS = [
  'invoiceType', 'invoiceCode', 'invoiceNumber', 'invoiceDate',
  'buyerName', 'buyerTaxId', 'sellerName', 'sellerTaxId',
  'amountExcludingTax', 'taxAmount', 'totalAmount',
  'reviewStatus', 'status', 'tags', 'fileName', 'remark', 'createdAt',
  'projectNames',
] as const
export type ExportColumn = (typeof EXPORT_COLUMNS)[number]

export const EXPORT_COLUMN_LABELS: Record<ExportColumn, string> = {
  invoiceType: '发票类型', invoiceCode: '发票代码', invoiceNumber: '发票号码', invoiceDate: '开票日期',
  buyerName: '购买方名称', buyerTaxId: '购买方税号', sellerName: '销售方名称', sellerTaxId: '销售方税号',
  amountExcludingTax: '不含税金额', taxAmount: '税额', totalAmount: '价税合计',
  reviewStatus: '审核状态', status: '发票状态', tags: '标签', fileName: '原文件名', remark: '备注', createdAt: '导入时间',
  projectNames: '所属项目',
}

export const DEFAULT_EXPORT_COLUMNS: ExportColumn[] = [
  'invoiceType', 'invoiceCode', 'invoiceNumber', 'invoiceDate',
  'buyerName', 'buyerTaxId', 'sellerName', 'sellerTaxId',
  'amountExcludingTax', 'taxAmount', 'totalAmount',
  'reviewStatus', 'fileName', 'remark',
  'projectNames',
]

export const exportInputSchema = z.object({
  format: z.enum(['xlsx', 'csv']),
  invoiceIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
  filter: invoiceFilterSchema.optional(),
  columns: z.array(z.enum(EXPORT_COLUMNS)).max(EXPORT_COLUMNS.length).optional(),
})

export type ExportInput = z.infer<typeof exportInputSchema>

export const exportFilesInputSchema = z.object({
  invoiceIds: z.array(z.string().uuid()).min(1).max(5000).optional(),
  filter: invoiceFilterSchema.optional(),
})

export type ExportFilesInput = z.infer<typeof exportFilesInputSchema>

export interface ExportResult {
  canceled: boolean
  filePath?: string
  count: number
}

export interface BatchConfirmResult {
  confirmed: number
  skipped: Array<{ id: string; fileName: string; reason: string }>
}

export interface BackupResult {
  canceled: boolean
  path?: string
  safetyBackupPath?: string
}

export const idsInputSchema = z.array(z.string().uuid()).min(1).max(5000)
export const setInvoiceProjectsSchema = z.object({ ids: idsInputSchema, projectIds: z.array(z.string().uuid()).max(1, '一张发票只能关联一个项目') })
export const setStatusInputSchema = z.object({ ids: idsInputSchema, status: z.enum(INVOICE_STATUSES) })
export const setTagsInputSchema = z.object({ id: z.string().uuid(), tags: z.array(z.string().trim().min(1).max(50)).max(20) })
export const batchTagsInputSchema = z.object({ ids: idsInputSchema, tags: z.array(z.string().trim().min(1).max(50)).min(1).max(20) })

export interface AppErrorPayload {
  code: string
  message: string
}

export type IpcResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: AppErrorPayload }

export interface InvoiceApi extends McpApi, AdvanceApi {
  listProjects: () => Promise<InvoiceProject[]>
  createProject: (input: z.infer<typeof projectInputSchema>) => Promise<InvoiceProject>
  updateProject: (input: z.infer<typeof updateProjectInputSchema>) => Promise<InvoiceProject>
  deleteProject: (id: string) => Promise<void>
  setInvoiceProjects: (ids: string[], projectIds: string[]) => Promise<number>
  importFiles: (projectId?: string | null) => Promise<ImportSummary>
  getAppSettings: () => Promise<AppSettings>
  saveAppSettings: (settings: AppSettings) => Promise<AppSettings>
  getApplicationInfo: () => Promise<ApplicationInfo>
  openDataDirectory: () => Promise<void>
  changeDataDirectory: (mode: 'select' | 'default') => Promise<{ canceled: boolean; directory?: string }>
  selectOcrPath: (kind: 'executable' | 'directory') => Promise<string | null>
  getInvoiceFileData: (id: string) => Promise<Uint8Array>
  listInvoices: (query: InvoiceQuery) => Promise<InvoiceListResult>
  getInvoice: (id: string) => Promise<InvoiceDetail>
  saveInvoice: (input: SaveInvoiceInput) => Promise<InvoiceDetail>
  applyOcrResult: (invoiceId: string, resultId: string) => Promise<InvoiceDetail>
  retryOcr: (id: string) => Promise<void>
  getSettings: () => Promise<OcrSettings>
  saveSettings: (settings: OcrSettings) => Promise<OcrSettings>
  testOcrConnection: (settings: OcrSettings) => Promise<OcrConnectionResult>
  getOcrServiceStatus: () => Promise<OcrServiceStatus>
  startOcrService: (settings: OcrSettings) => Promise<OcrServiceStatus>
  getStats: (filter: StatsFilter) => Promise<InvoiceStats>
  exportStats: (filter: StatsFilter) => Promise<ExportResult>
  exportInvoices: (input: ExportInput) => Promise<ExportResult>
  exportInvoiceFiles: (input: ExportFilesInput) => Promise<ExportResult>
  exportReimbursementBundle: (input: ExportFilesInput) => Promise<ExportResult>
  deleteInvoices: (ids: string[]) => Promise<number>
  restoreInvoices: (ids: string[]) => Promise<number>
  purgeInvoices: (ids: string[]) => Promise<number>
  confirmInvoices: (ids: string[]) => Promise<BatchConfirmResult>
  createBackup: () => Promise<BackupResult>
  restoreBackup: () => Promise<BackupResult>
  retryOcrInvoices: (ids: string[]) => Promise<number>
  setInvoicesStatus: (ids: string[], status: InvoiceStatus) => Promise<number>
  setInvoiceTags: (id: string, tags: string[]) => Promise<void>
  addInvoicesTags: (ids: string[], tags: string[]) => Promise<number>
  removeInvoicesTags: (ids: string[], tags: string[]) => Promise<number>
  getTags: () => Promise<string[]>
  onOcrProgress: (callback: (progress: OcrProgress) => void) => () => void
  importPaths?: (paths: string[]) => Promise<ImportSummary>
}
