import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  OCR_STATUSES,
  REVIEW_STATUSES,
  type Invoice,
  type InvoiceFields,
  type InvoiceFilter,
  type InvoiceListResult,
  type InvoiceQuery,
  type InvoiceStats,
  type StatsFilter,
  type InvoiceStatus,
  type OcrFieldEvidence,
  type OcrResultInfo,
  type OcrStatus,
  type ReviewStatus,
} from '@shared/contracts'
import { AppError } from '@shared/errors'
import { buildBusinessKey } from '@shared/business-key'
import { confirmationError } from '@shared/confirmation'
import type { BatchConfirmResult, InvoiceProject, ProjectRef } from '@shared/contracts'

interface InvoiceRow {
  id: string
  file_name: string
  storage_path: string
  mime_type: string
  file_size: number
  sha256: string
  invoice_type: string
  invoice_code: string
  invoice_number: string
  invoice_date: string
  buyer_name: string
  buyer_tax_id: string
  seller_name: string
  seller_tax_id: string
  amount_excluding_tax: number | null
  tax_amount: number | null
  total_amount: number | null
  remark: string
  ocr_status: OcrStatus
  review_status: ReviewStatus
  status: InvoiceStatus
  deleted_at: string | null
  ocr_error: string | null
  ocr_attempts: number
  manual_fields: string
  business_key: string | null
  created_at: string
  updated_at: string
}

interface TagRow {
  id: string
  name: string
}

interface OcrResultRow {
  id: string
  raw_response: string
  normalized_text: string
  parsed_fields: string
  evidence: string
  warnings: string
  created_at: string
}

export interface NewInvoiceRecord {
  fileName: string
  storagePath: string
  mimeType: string
  fileSize: number
  sha256: string
}

export interface OcrSuccessRecord {
  rawResponse: unknown
  normalizedText: string
  parsedFields: Partial<InvoiceFields>
  evidence: Partial<Record<keyof InvoiceFields, OcrFieldEvidence>>
  warnings: string[]
}

const FIELD_COLUMNS: Record<keyof InvoiceFields, string> = {
  invoiceType: 'invoice_type',
  invoiceCode: 'invoice_code',
  invoiceNumber: 'invoice_number',
  invoiceDate: 'invoice_date',
  buyerName: 'buyer_name',
  buyerTaxId: 'buyer_tax_id',
  sellerName: 'seller_name',
  sellerTaxId: 'seller_tax_id',
  amountExcludingTax: 'amount_excluding_tax',
  taxAmount: 'tax_amount',
  totalAmount: 'total_amount',
  remark: 'remark',
}

const FIELD_KEYS = Object.keys(FIELD_COLUMNS) as Array<keyof InvoiceFields>

function emptyFields(): InvoiceFields {
  return {
    invoiceType: '', invoiceCode: '', invoiceNumber: '', invoiceDate: '',
    buyerName: '', buyerTaxId: '', sellerName: '', sellerTaxId: '',
    amountExcludingTax: null, taxAmount: null, totalAmount: null, remark: '',
  }
}

function rowToFields(row: InvoiceRow): InvoiceFields {
  return {
    invoiceType: row.invoice_type,
    invoiceCode: row.invoice_code,
    invoiceNumber: row.invoice_number,
    invoiceDate: row.invoice_date,
    buyerName: row.buyer_name,
    buyerTaxId: row.buyer_tax_id,
    sellerName: row.seller_name,
    sellerTaxId: row.seller_tax_id,
    amountExcludingTax: row.amount_excluding_tax,
    taxAmount: row.tax_amount,
    totalAmount: row.total_amount,
    remark: row.remark,
  }
}

function rowToInvoice(row: InvoiceRow, tags: string[] = [], projects: ProjectRef[] = []): Invoice {
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    sha256: row.sha256,
    ...rowToFields(row),
    ocrStatus: row.ocr_status,
    reviewStatus: row.review_status,
    status: row.status,
    tags,
    projects,
    deletedAt: row.deleted_at,
    ocrError: row.ocr_error,
    ocrAttempts: row.ocr_attempts,
    manualFields: JSON.parse(row.manual_fields) as Array<keyof InvoiceFields>,
    businessKey: row.business_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

function filterWhere(filter: InvoiceFilter, alias = ''): { sql: string; params: string[] } {
  const prefix = alias ? `${alias}.` : ''
  const clauses: string[] = []
  const params: string[] = []
  if (filter.sellerName !== undefined) { clauses.push(`${prefix}seller_name = ?`); params.push(filter.sellerName) }
  if (filter.missingField) {
    const column = FIELD_COLUMNS[filter.missingField]
    clauses.push(['invoiceDate', 'invoiceType'].includes(filter.missingField) ? `${prefix}${column} = ''` : `${prefix}${column} IS NULL`)
  }
  if (filter.keyword) {
    clauses.push(`(${prefix}invoice_number LIKE ? ESCAPE '\\' OR ${prefix}invoice_code LIKE ? ESCAPE '\\' OR ${prefix}buyer_name LIKE ? ESCAPE '\\' OR ${prefix}seller_name LIKE ? ESCAPE '\\' OR ${prefix}file_name LIKE ? ESCAPE '\\')`)
    const pattern = likePattern(filter.keyword)
    params.push(pattern, pattern, pattern, pattern, pattern)
  }
  if (filter.dateFrom) {
    clauses.push(`${prefix}invoice_date >= ?`)
    params.push(filter.dateFrom)
  }
  if (filter.amountMin !== undefined) {
    clauses.push(`${prefix}total_amount >= ?`)
    params.push(String(filter.amountMin))
  }
  if (filter.amountMax !== undefined) {
    clauses.push(`${prefix}total_amount <= ?`)
    params.push(String(filter.amountMax))
  }
  if (filter.dateTo) {
    clauses.push(`${prefix}invoice_date <= ?`)
    params.push(filter.dateTo)
  }
  if (filter.invoiceType) {
    clauses.push(`${prefix}invoice_type = ?`)
    params.push(filter.invoiceType)
  }
  if (filter.ocrStatus) {
    clauses.push(`${prefix}ocr_status = ?`)
    params.push(filter.ocrStatus)
  }
  if (filter.reviewStatus) {
    clauses.push(`${prefix}review_status = ?`)
    params.push(filter.reviewStatus)
  }
  if (filter.status) {
    clauses.push(`${prefix}status = ?`)
    params.push(filter.status)
  }
  if (filter.statuses?.length) {
    clauses.push(`${prefix}status IN (${filter.statuses.map(() => '?').join(',')})`)
    params.push(...filter.statuses)
  }
  if (filter.tag) {
    const outerId = alias ? `${alias}.id` : 'invoices.id'
    clauses.push(`EXISTS (SELECT 1 FROM invoice_tags it JOIN tags t ON t.id = it.tag_id WHERE it.invoice_id = ${outerId} AND t.name = ?)`)
    params.push(filter.tag)
  }
  if (filter.projectId !== undefined) {
    const outerId = alias ? `${alias}.id` : 'invoices.id'
    if (filter.projectId === null) clauses.push(`NOT EXISTS (SELECT 1 FROM invoice_projects ip WHERE ip.invoice_id = ${outerId})`)
    else {
      clauses.push(`EXISTS (SELECT 1 FROM invoice_projects ip WHERE ip.invoice_id = ${outerId} AND ip.project_id = ?)`)
      params.push(filter.projectId)
    }
  }
  if (filter.deleted) {
    clauses.push(`${prefix}deleted_at IS NOT NULL`)
  } else {
    clauses.push(`${prefix}deleted_at IS NULL`)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

function idListSql(ids: string[]): string {
  return ids.map(() => '?').join(',')
}

export class InvoiceDatabase {
  private readonly db: Database.Database
  get connection(): Database.Database { return this.db }

  constructor(dataDirectory: string) {
    mkdirSync(dataDirectory, { recursive: true })
    this.db = new Database(join(dataDirectory, 'invoice.db'))
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 5) { this.db.close(); throw new AppError('DATABASE_NEWER_VERSION', '数据由更高版本的应用创建，请升级应用后打开，当前数据未修改') }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    try { this.db.transaction(() => this.migrate())() } catch (error) { this.db.close(); throw error }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        invoice_type TEXT NOT NULL DEFAULT '',
        invoice_code TEXT NOT NULL DEFAULT '',
        invoice_number TEXT NOT NULL DEFAULT '',
        invoice_date TEXT NOT NULL DEFAULT '',
        buyer_name TEXT NOT NULL DEFAULT '',
        buyer_tax_id TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        seller_tax_id TEXT NOT NULL DEFAULT '',
        amount_excluding_tax INTEGER,
        tax_amount INTEGER,
        total_amount INTEGER,
        remark TEXT NOT NULL DEFAULT '',
        ocr_status TEXT NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending', 'queued', 'running', 'succeeded', 'failed')),
        review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'needs_review', 'confirmed')),
        status TEXT NOT NULL DEFAULT 'unprocessed' CHECK (status IN ('unprocessed', 'reimbursed', 'booked', 'void')),
        deleted_at TEXT,
        ocr_error TEXT,
        ocr_attempts INTEGER NOT NULL DEFAULT 0,
        manual_fields TEXT NOT NULL DEFAULT '[]',
        business_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ocr_results (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        raw_response TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        parsed_fields TEXT NOT NULL,
        evidence TEXT NOT NULL,
        warnings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invoice_tags (
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (invoice_id, tag_id)
      );
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invoice_projects (
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        PRIMARY KEY (invoice_id, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_invoice_projects_project ON invoice_projects(project_id, invoice_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_projects_invoice ON invoice_projects(invoice_id);
    `)
    const existingColumns = this.db.prepare('PRAGMA table_info(invoices)').all() as Array<{ name: string }>
    if (!existingColumns.some((column) => column.name === 'status')) {
      this.db.exec("ALTER TABLE invoices ADD COLUMN status TEXT NOT NULL DEFAULT 'unprocessed'")
    }
    if (!existingColumns.some((column) => column.name === 'deleted_at')) {
      this.db.exec('ALTER TABLE invoices ADD COLUMN deleted_at TEXT')
    }
    if (!existingColumns.some((column) => column.name === 'ocr_round_attempts')) {
      this.db.exec('ALTER TABLE invoices ADD COLUMN ocr_round_attempts INTEGER NOT NULL DEFAULT 0')
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
      CREATE INDEX IF NOT EXISTS idx_invoices_business_key ON invoices(business_key);
      CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date);
      CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(ocr_status, review_status);
      CREATE INDEX IF NOT EXISTS idx_invoices_sort ON invoices(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_invoices_deleted ON invoices(deleted_at);
      CREATE INDEX IF NOT EXISTS idx_ocr_results_invoice ON ocr_results(invoice_id, created_at DESC);
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS advances (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), date TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, payee TEXT NOT NULL, remark TEXT NOT NULL,
        invoice_id TEXT UNIQUE REFERENCES invoices(id) ON DELETE SET NULL, deleted INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS advance_returns (
        id TEXT PRIMARY KEY, advance_id TEXT NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
        date TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount > 0), remark TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS advance_attachments (
        id TEXT PRIMARY KEY, advance_id TEXT NOT NULL REFERENCES advances(id) ON DELETE CASCADE,
        name TEXT NOT NULL, storage_path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_advances_project_date ON advances(project_id, date);
      CREATE INDEX IF NOT EXISTS idx_returns_advance ON advance_returns(advance_id);
      CREATE INDEX IF NOT EXISTS idx_attachments_advance ON advance_attachments(advance_id);
    `)
    this.db.pragma('user_version = 5')
  }

  private getTagsFor(ids: string[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    if (!ids.length) return map
    const rows = this.db.prepare(`
      SELECT it.invoice_id AS id, t.name AS name
      FROM invoice_tags it JOIN tags t ON t.id = it.tag_id
      WHERE it.invoice_id IN (${idListSql(ids)})
      ORDER BY t.name
    `).all(...ids) as Array<{ id: string; name: string }>
    for (const row of rows) {
      const list = map.get(row.id) ?? []
      list.push(row.name)
      map.set(row.id, list)
    }
    return map
  }

  private attachTags(rows: InvoiceRow[]): Invoice[] {
    const tagMap = this.getTagsFor(rows.map((row) => row.id))
    const projectMap = new Map<string, ProjectRef[]>()
    if (rows.length) {
      const projects = this.db.prepare(`SELECT ip.invoice_id, p.id, p.name FROM invoice_projects ip JOIN projects p ON p.id = ip.project_id WHERE ip.invoice_id IN (${idListSql(rows.map((row) => row.id))}) ORDER BY p.name`).all(...rows.map((row) => row.id)) as Array<ProjectRef & { invoice_id: string }>
      for (const project of projects) {
        const values = projectMap.get(project.invoice_id) ?? []
        values.push({ id: project.id, name: project.name })
        projectMap.set(project.invoice_id, values)
      }
    }
    return rows.map((row) => rowToInvoice(row, tagMap.get(row.id) ?? [], projectMap.get(row.id) ?? []))
  }

  listProjects(): InvoiceProject[] {
    return this.db.prepare(`SELECT p.id, p.name, p.description, p.created_at AS createdAt, p.updated_at AS updatedAt,
      COUNT(i.id) AS invoiceCount,
      COALESCE(SUM(CASE WHEN i.review_status = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmedCount,
      COALESCE(SUM(CASE WHEN i.review_status = 'confirmed' THEN i.total_amount ELSE 0 END), 0) AS confirmedAmount
      FROM projects p LEFT JOIN invoice_projects ip ON ip.project_id = p.id
      LEFT JOIN invoices i ON i.id = ip.invoice_id AND i.deleted_at IS NULL
      GROUP BY p.id ORDER BY p.created_at, p.id`).all() as InvoiceProject[]
  }

  createProject(input: { name: string; description: string }): InvoiceProject {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new AppError('PROJECT_NAME_INVALID', '项目名称需为 1–80 个字符')
    if (this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE').get(name)) throw new AppError('PROJECT_EXISTS', '已存在同名项目')
    const id = randomUUID(), now = new Date().toISOString()
    this.db.prepare('INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, name, input.description, now, now)
    return this.listProjects().find((project) => project.id === id)!
  }

  updateProject(input: { id: string; name: string; description: string }): InvoiceProject {
    const name = input.name.trim()
    if (!name || name.length > 80) throw new AppError('PROJECT_NAME_INVALID', '项目名称需为 1–80 个字符')
    if (this.db.prepare('SELECT 1 FROM projects WHERE name = ? COLLATE NOCASE AND id != ?').get(name, input.id)) throw new AppError('PROJECT_EXISTS', '已存在同名项目')
    const changed = this.db.prepare('UPDATE projects SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(name, input.description, new Date().toISOString(), input.id).changes
    if (!changed) throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
    return this.listProjects().find((project) => project.id === input.id)!
  }

  deleteProject(id: string): void {
    if (!this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes) throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
  }

  setInvoiceProjects(invoiceIds: string[], projectIds: string[]): number {
    const ids = [...new Set(invoiceIds)]
    if (!ids.length) throw new AppError('BATCH_EMPTY', '请先选择发票')
    if (projectIds.length > 1) throw new AppError('PROJECT_LIMIT', '一张发票只能关联一个项目')
    const projectId = projectIds[0]
    if (projectId && !this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
    let changed = 0
    this.db.transaction(() => {
      const valid = this.db.prepare(`SELECT id FROM invoices WHERE id IN (${idListSql(ids)}) AND deleted_at IS NULL`).all(...ids)
      if (valid.length !== ids.length) throw new AppError('INVOICE_NOT_FOUND', '部分发票不存在或已移入回收站，请刷新后重试')
      const current = this.db.prepare('SELECT project_id FROM invoice_projects WHERE invoice_id = ?')
      const remove = this.db.prepare('DELETE FROM invoice_projects WHERE invoice_id = ?')
      const insert = this.db.prepare('INSERT INTO invoice_projects (invoice_id, project_id) VALUES (?, ?)')
      const touch = this.db.prepare('UPDATE invoices SET updated_at = ? WHERE id = ?')
      const now = new Date().toISOString()
      for (const id of ids) {
        const previous = current.get(id) as { project_id: string } | undefined
        if (previous?.project_id === projectId) continue
        remove.run(id)
        if (projectId) insert.run(id, projectId)
        touch.run(now, id)
        changed++
      }
    })()
    return changed
  }

  create(record: NewInvoiceRecord): Invoice {
    const id = randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO invoices (id, file_name, storage_path, mime_type, file_size, sha256, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, record.fileName, record.storagePath, record.mimeType, record.fileSize, record.sha256, now, now)
    return this.get(id)!
  }

  get(id: string): Invoice | null {
    const row = this.db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceRow | undefined
    return row ? this.attachTags([row])[0] : null
  }

  getByHash(sha256: string): Invoice | null {
    const row = this.db.prepare('SELECT * FROM invoices WHERE sha256 = ?').get(sha256) as InvoiceRow | undefined
    return row ? this.attachTags([row])[0] : null
  }

  getStoragePath(id: string): string | null {
    const row = this.db.prepare('SELECT storage_path FROM invoices WHERE id = ?').get(id) as { storage_path: string } | undefined
    return row?.storage_path ?? null
  }

  list(query: InvoiceQuery): InvoiceListResult {
    const where = filterWhere(query)
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM invoices ${where.sql}`).get(...where.params) as { count: number }
    const rows = this.db.prepare(`
      SELECT * FROM invoices ${where.sql}
      ORDER BY CASE WHEN invoice_date = '' THEN 1 ELSE 0 END, invoice_date DESC, created_at DESC
      LIMIT ? OFFSET ?
    `).all(...where.params, query.pageSize, (query.page - 1) * query.pageSize) as InvoiceRow[]
    return { items: this.attachTags(rows), total: total.count, page: query.page, pageSize: query.pageSize }
  }

  listForExport(filter: InvoiceFilter, invoiceIds?: string[]): Invoice[] {
    const where = filterWhere(filter)
    const clauses = where.sql ? [where.sql.slice(6)] : []
    const params: string[] = [...where.params]
    if (invoiceIds?.length) {
      clauses.push(`id IN (${invoiceIds.map(() => '?').join(',')})`)
      params.push(...invoiceIds)
    }
    const sql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.db.prepare(`SELECT * FROM invoices ${sql} ORDER BY invoice_date DESC, created_at DESC`).all(...params) as InvoiceRow[]
    return this.attachTags(rows)
  }

  updateFields(id: string, fields: InvoiceFields, confirm: boolean): Invoice {
    const current = this.get(id)
    if (!current) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
    if (current.deletedAt) throw new AppError('INVOICE_DELETED', '请先从回收站恢复发票')
    const validation = confirm ? confirmationError(fields) : null
    if (validation) throw new AppError('CONFIRM_VALIDATION', validation)
    const changed = FIELD_KEYS.filter((key) => current[key] !== fields[key])
    const manualFields = [...new Set([...current.manualFields, ...changed])]
    const reviewStatus = confirm ? 'confirmed' : current.reviewStatus === 'confirmed' && changed.length ? 'needs_review' : current.reviewStatus
    const assignments = FIELD_KEYS.map((key) => `${FIELD_COLUMNS[key]} = ?`).join(', ')
    const values = FIELD_KEYS.map((key) => fields[key])
    this.db.prepare(`
      UPDATE invoices SET ${assignments}, manual_fields = ?, business_key = ?, review_status = ?, updated_at = ?
      WHERE id = ?
    `).run(...values, JSON.stringify(manualFields), buildBusinessKey(fields), reviewStatus, new Date().toISOString(), id)
    return this.get(id)!
  }

  setOcrStatus(id: string, status: OcrStatus, error: string | null = null): void {
    const increment = status === 'running' ? 1 : 0
    this.db.prepare(`
      UPDATE invoices SET ocr_status = ?, ocr_error = ?, ocr_attempts = ocr_attempts + ?, ocr_round_attempts = ocr_round_attempts + ?, updated_at = ? WHERE id = ?
    `).run(status, error, increment, increment, new Date().toISOString(), id)
  }

  resetOcrRound(id: string): void {
    this.db.prepare('UPDATE invoices SET ocr_round_attempts = 0 WHERE id = ?').run(id)
  }

  getOcrRound(id: string): number {
    return (this.db.prepare('SELECT ocr_round_attempts AS attempts FROM invoices WHERE id = ?').get(id) as { attempts: number } | undefined)?.attempts ?? 0
  }

  nextQueued(limit: number, excluded: string[] = [], includePending = true): Invoice[] {
    const rows = this.db.prepare(`
      SELECT * FROM invoices WHERE ocr_status IN (${includePending ? "'pending', 'queued'" : "'queued'"}) AND deleted_at IS NULL
      ${excluded.length ? `AND id NOT IN (${idListSql(excluded)})` : ''} ORDER BY created_at LIMIT ?
    `).all(...excluded, limit) as InvoiceRow[]
    return this.attachTags(rows)
  }

  recoverQueue(): void {
    this.db.prepare("UPDATE invoices SET ocr_status = 'queued', ocr_error = NULL WHERE ocr_status = 'running'").run()
  }

  recordOcrSuccess(id: string, result: OcrSuccessRecord): void {
    const transaction = this.db.transaction(() => {
      const current = this.get(id)
      if (!current) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
      this.db.prepare(`
        INSERT INTO ocr_results (id, invoice_id, raw_response, normalized_text, parsed_fields, evidence, warnings, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), id, JSON.stringify(result.rawResponse), result.normalizedText, JSON.stringify(result.parsedFields), JSON.stringify(result.evidence), JSON.stringify(result.warnings), new Date().toISOString())
      this.mergeParsedFields(id, current, result.parsedFields, true)
      const reviewStatus = 'needs_review'
      this.db.prepare("UPDATE invoices SET ocr_status = 'succeeded', ocr_error = NULL, review_status = ?, updated_at = ? WHERE id = ?")
        .run(reviewStatus, new Date().toISOString(), id)
    })
    transaction()
  }

  applyOcrResult(invoiceId: string, resultId: string, reparsed?: OcrSuccessRecord): Invoice {
    const current = this.get(invoiceId)
    if (!current) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
    const row = this.db.prepare('SELECT parsed_fields FROM ocr_results WHERE id = ? AND invoice_id = ?').get(resultId, invoiceId) as { parsed_fields: string } | undefined
    if (!row) throw new AppError('OCR_RESULT_NOT_FOUND', '识别结果不存在')
    const parsed = reparsed?.parsedFields ?? JSON.parse(row.parsed_fields) as Partial<InvoiceFields>
    this.db.transaction(() => {
      if (reparsed) {
        this.db.prepare('UPDATE ocr_results SET normalized_text = ?, parsed_fields = ?, evidence = ?, warnings = ? WHERE id = ?')
          .run(reparsed.normalizedText, JSON.stringify(reparsed.parsedFields), JSON.stringify(reparsed.evidence), JSON.stringify(reparsed.warnings), resultId)
      }
      this.mergeParsedFields(invoiceId, current, parsed)
      this.db.prepare("UPDATE invoices SET review_status = 'needs_review', updated_at = ? WHERE id = ?").run(new Date().toISOString(), invoiceId)
    })()
    return this.get(invoiceId)!
  }

  private mergeParsedFields(id: string, current: Invoice, parsed: Partial<InvoiceFields>, replace = false): void {
    const merged: InvoiceFields = {
      invoiceType: current.invoiceType,
      invoiceCode: current.invoiceCode,
      invoiceNumber: current.invoiceNumber,
      invoiceDate: current.invoiceDate,
      buyerName: current.buyerName,
      buyerTaxId: current.buyerTaxId,
      sellerName: current.sellerName,
      sellerTaxId: current.sellerTaxId,
      amountExcludingTax: current.amountExcludingTax,
      taxAmount: current.taxAmount,
      totalAmount: current.totalAmount,
      remark: current.remark,
    }
    for (const key of FIELD_KEYS) {
      if (!current.manualFields.includes(key) && parsed[key] !== undefined) {
        Object.assign(merged, { [key]: parsed[key] })
      } else if (replace && !current.manualFields.includes(key) && key !== 'remark') {
        Object.assign(merged, { [key]: ['amountExcludingTax', 'taxAmount', 'totalAmount'].includes(key) ? null : '' })
      }
    }
    const assignments = FIELD_KEYS.map((key) => `${FIELD_COLUMNS[key]} = ?`).join(', ')
    const values = FIELD_KEYS.map((key) => merged[key])
    this.db.prepare(`UPDATE invoices SET ${assignments}, business_key = ? WHERE id = ?`)
      .run(...values, buildBusinessKey(merged), id)
  }

  getOcrResults(invoiceId: string): OcrResultInfo[] {
    const rows = this.db.prepare('SELECT * FROM ocr_results WHERE invoice_id = ? ORDER BY created_at DESC').all(invoiceId) as OcrResultRow[]
    return rows.map((row) => ({
      id: row.id,
      rawResponse: JSON.parse(row.raw_response) as unknown,
      normalizedText: row.normalized_text,
      parsedFields: JSON.parse(row.parsed_fields) as Partial<InvoiceFields>,
      evidence: JSON.parse(row.evidence) as OcrResultInfo['evidence'],
      warnings: JSON.parse(row.warnings) as string[],
      createdAt: row.created_at,
    }))
  }

  getDuplicates(id: string): Invoice[] {
    const current = this.get(id)
    if (!current?.businessKey) return []
    const rows = this.db.prepare('SELECT * FROM invoices WHERE business_key = ? AND id != ? AND deleted_at IS NULL ORDER BY created_at').all(current.businessKey, id) as InvoiceRow[]
    return this.attachTags(rows)
  }

  softDelete(ids: string[]): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(`
      UPDATE invoices SET deleted_at = ?, updated_at = ?,
        ocr_status = CASE WHEN ocr_status IN ('queued', 'running') THEN 'pending' ELSE ocr_status END
      WHERE id IN (${idListSql(ids)}) AND deleted_at IS NULL
    `).run(now, now, ...ids)
    return result.changes
  }

  restore(ids: string[]): number {
    const now = new Date().toISOString()
    const result = this.db.prepare(`UPDATE invoices SET deleted_at = NULL, updated_at = ? WHERE id IN (${idListSql(ids)}) AND deleted_at IS NOT NULL`).run(now, ...ids)
    return result.changes
  }

  purge(ids: string[]): string[] {
    const rows = this.db.prepare(`SELECT storage_path FROM invoices WHERE id IN (${idListSql(ids)}) AND deleted_at IS NOT NULL`).all(...ids) as Array<{ storage_path: string }>
    this.db.prepare(`DELETE FROM invoices WHERE id IN (${idListSql(ids)}) AND deleted_at IS NOT NULL`).run(...ids)
    return rows.map((row) => row.storage_path)
  }

  batchConfirm(ids: string[]): BatchConfirmResult {
    const result: BatchConfirmResult = { confirmed: 0, skipped: [] }
    this.db.transaction(() => {
      for (const id of new Set(ids)) {
        const invoice = this.get(id)
        const reason = !invoice ? '发票不存在' : invoice.deletedAt ? '发票在回收站中' : invoice.reviewStatus === 'confirmed' ? '已经确认' : confirmationError(invoice)
        if (reason) result.skipped.push({ id, fileName: invoice?.fileName ?? id, reason })
        else { this.updateFields(id, invoice!, true); result.confirmed++ }
      }
    })()
    return result
  }

  batchSetStatus(ids: string[], status: InvoiceStatus): number {
    const result = this.db.prepare(`
      UPDATE invoices SET status = ?, updated_at = ? WHERE id IN (${idListSql(ids)}) AND deleted_at IS NULL
    `).run(status, new Date().toISOString(), ...ids)
    return result.changes
  }

  getTags(): string[] {
    const rows = this.db.prepare('SELECT name FROM tags ORDER BY name').all() as TagRow[]
    return rows.map((row) => row.name)
  }

  private ensureTagIds(names: string[]): Map<string, string> {
    const now = new Date().toISOString()
    const insert = this.db.prepare('INSERT OR IGNORE INTO tags (id, name, created_at) VALUES (?, ?, ?)')
    for (const name of names) insert.run(randomUUID(), name, now)
    const rows = this.db.prepare(`SELECT id, name FROM tags WHERE name IN (${idListSql(names)})`).all(...names) as TagRow[]
    return new Map(rows.map((row) => [row.name, row.id]))
  }

  setInvoiceTags(invoiceId: string, names: string[]): void {
    const current = this.get(invoiceId)
    if (!current) throw new AppError('INVOICE_NOT_FOUND', '发票不存在')
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM invoice_tags WHERE invoice_id = ?').run(invoiceId)
      if (!names.length) return
      const tagIds = this.ensureTagIds(names)
      const insert = this.db.prepare('INSERT OR IGNORE INTO invoice_tags (invoice_id, tag_id) VALUES (?, ?)')
      for (const name of names) insert.run(invoiceId, tagIds.get(name)!)
    })()
  }

  addInvoicesTags(ids: string[], names: string[]): number {
    const tagIds = this.ensureTagIds(names)
    const insert = this.db.prepare('INSERT OR IGNORE INTO invoice_tags (invoice_id, tag_id) VALUES (?, ?)')
    let changed = 0
    this.db.transaction(() => {
      for (const invoiceId of ids) {
        for (const name of names) changed += insert.run(invoiceId, tagIds.get(name)!).changes
      }
    })()
    return changed
  }

  removeInvoicesTags(ids: string[], names: string[]): number {
    const rows = this.db.prepare(`SELECT id, name FROM tags WHERE name IN (${idListSql(names)})`).all(...names) as TagRow[]
    if (!rows.length) return 0
    const deleteStatement = this.db.prepare('DELETE FROM invoice_tags WHERE invoice_id = ? AND tag_id = ?')
    let changed = 0
    this.db.transaction(() => {
      for (const invoiceId of ids) {
        for (const row of rows) changed += deleteStatement.run(invoiceId, row.id).changes
      }
    })()
    return changed
  }

  getStats(filter: StatsFilter): InvoiceStats {
    const where = filterWhere(filter)
    if (filter.reviewScope !== 'all') where.sql += " AND review_status = 'confirmed'"
    const cte = `WITH scoped AS (SELECT * FROM invoices ${where.sql})`
    const summary = this.db.prepare(`${cte} SELECT COUNT(*) AS count,
      COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(tax_amount), 0) AS tax,
      COALESCE(SUM(amount_excluding_tax), 0) AS net, COUNT(total_amount) AS amountCount,
      COALESCE(SUM(review_status = 'confirmed'), 0) AS confirmed,
      COALESCE(SUM(invoice_date = ''), 0) AS missingDate,
      COUNT(*) - COUNT(total_amount) AS missingTotal, COUNT(*) - COUNT(tax_amount) AS missingTax,
      COUNT(*) - COUNT(amount_excluding_tax) AS missingNet FROM scoped`).get(...where.params) as {
        count: number; total: number; tax: number; net: number; amountCount: number; confirmed: number;
        missingDate: number; missingTotal: number; missingTax: number; missingNet: number;
      }
    const monthly = this.db.prepare(`${cte} SELECT substr(invoice_date, 1, 7) AS month,
      COUNT(*) AS invoiceCount, COALESCE(SUM(total_amount), 0) AS totalAmount, COALESCE(SUM(tax_amount), 0) AS taxAmount
      FROM scoped WHERE invoice_date <> '' GROUP BY month ORDER BY month`).all(...where.params) as InvoiceStats['monthly']
    const byType = this.db.prepare(`${cte} SELECT invoice_type AS invoiceType, COUNT(*) AS invoiceCount,
      COALESCE(SUM(total_amount), 0) AS totalAmount FROM scoped GROUP BY invoice_type ORDER BY totalAmount DESC, invoice_type`).all(...where.params) as InvoiceStats['byType']
    const byStatus = this.db.prepare(`${cte} SELECT status, COUNT(*) AS invoiceCount,
      COALESCE(SUM(total_amount), 0) AS totalAmount FROM scoped GROUP BY status ORDER BY totalAmount DESC`).all(...where.params) as InvoiceStats['byStatus']
    const byProject = this.db.prepare(`${cte} SELECT p.id AS projectId, COALESCE(p.name, '未分配') AS name,
      COUNT(*) AS invoiceCount, COALESCE(SUM(i.total_amount), 0) AS totalAmount FROM scoped i
      LEFT JOIN invoice_projects ip ON ip.invoice_id = i.id LEFT JOIN projects p ON p.id = ip.project_id
      GROUP BY p.id ORDER BY totalAmount DESC, name`).all(...where.params) as InvoiceStats['byProject']
    const bySeller = this.db.prepare(`${cte} SELECT seller_name AS name, COUNT(*) AS invoiceCount,
      COALESCE(SUM(total_amount), 0) AS totalAmount FROM scoped GROUP BY seller_name ORDER BY totalAmount DESC, name`).all(...where.params) as InvoiceStats['bySeller']
    return { invoiceCount: summary.count, totalAmount: summary.total, taxAmount: summary.tax,
      amountExcludingTax: summary.net, averageAmount: summary.amountCount ? Math.round(summary.total / summary.amountCount) : 0,
      confirmedCount: summary.confirmed,
      missing: { invoiceDate: summary.missingDate, totalAmount: summary.missingTotal, amountExcludingTax: summary.missingNet, taxAmount: summary.missingTax },
      monthly, byType: byType.map(row => ({ ...row, typeKey: row.invoiceType, invoiceType: row.invoiceType || '未分类' })), byStatus, byProject, bySeller }
  }

  close(): void {
    this.db.close()
  }

  storageSummary(): { invoiceCount: number; trashCount: number; originalBytes: number } {
    return this.db.prepare(`SELECT COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS invoiceCount,
      COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS trashCount,
      COALESCE(SUM(file_size), 0) AS originalBytes FROM invoices`).get() as { invoiceCount: number; trashCount: number; originalBytes: number }
  }

  backup(path: string): Promise<Database.BackupMetadata> { return this.db.backup(path) }
}

export function isOcrStatus(value: string): value is OcrStatus {
  return OCR_STATUSES.includes(value as OcrStatus)
}

export function isReviewStatus(value: string): value is ReviewStatus {
  return REVIEW_STATUSES.includes(value as ReviewStatus)
}
