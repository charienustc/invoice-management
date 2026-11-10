import { randomUUID, createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, unlink, stat } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import ExcelJS from 'exceljs'
import type { InvoiceDatabase } from '../db/database'
import { AppError } from '@shared/errors'
import { advanceSaveSchema, advanceFilterSchema, advanceReturnSchema, type Advance, type AdvanceSave, type AdvanceFilter, type AdvanceResult } from '@shared/advances'
import { hasValidSignature } from './import-service'

interface Row { id: string; title: string; amount: number; date: string; project_id: string | null; payee: string; remark: string; invoice_id: string | null; deleted: number; revision: number }
export class AdvanceService {
  constructor(private readonly db: InvoiceDatabase, private readonly directory = '') {}
  private get sql() { return this.db.connection }
  private row(id: string): Row {
    const row = this.sql.prepare('SELECT * FROM advances WHERE id = ?').get(id) as Row | undefined
    if (!row) throw new AppError('ADVANCE_NOT_FOUND', '垫付记录不存在')
    return row
  }
  private check(id: string, revision: number, allowDeleted = false): Row {
    const row = this.row(id)
    if (row.revision !== revision) throw new AppError('DATA_CONFLICT', '记录已更新，请关闭后重新打开')
    if (row.deleted && !allowDeleted) throw new AppError('ADVANCE_DELETED', '请先恢复这条记录')
    return row
  }
  private touch(id: string) { this.sql.prepare('UPDATE advances SET revision = revision + 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), id) }
  get(id: string): Advance {
    const row = this.row(id)
    const returns = this.sql.prepare('SELECT id, date, amount, remark FROM advance_returns WHERE advance_id = ? ORDER BY date DESC, rowid DESC').all(id) as Advance['returns']
    const attachments = this.sql.prepare('SELECT id, name, size FROM advance_attachments WHERE advance_id = ? ORDER BY rowid').all(id) as Advance['attachments']
    const invoice = row.invoice_id ? this.db.get(row.invoice_id) : null
    const linked = !!invoice && !invoice.deletedAt && invoice.status !== 'void' && (invoice.projects[0]?.id ?? null) === row.project_id && invoice.totalAmount === row.amount
    const recovered = returns.reduce((sum, item) => sum + item.amount, 0)
    return { id, title: row.title, amount: row.amount, date: row.date, projectId: row.project_id, payee: row.payee, remark: row.remark,
      invoiceId: row.invoice_id, invoiceNumber: invoice?.invoiceNumber || invoice?.fileName || '', linked,
      deleted: !!row.deleted, revision: row.revision, projectName: row.project_id ? this.db.listProjects().find(p => p.id === row.project_id)?.name ?? '未分配' : '未分配',
      recovered, remaining: row.amount - recovered, returns, attachments }
  }
  list(input: AdvanceFilter): AdvanceResult {
    const filter = advanceFilterSchema.parse(input)
    const clauses = ['deleted = ?'], values: unknown[] = [filter.deleted ? 1 : 0]
    if (filter.projectId === null) clauses.push('project_id IS NULL')
    else if (filter.projectId) { clauses.push('project_id = ?'); values.push(filter.projectId) }
    if (filter.dateFrom) { clauses.push('date >= ?'); values.push(filter.dateFrom) }
    if (filter.dateTo) { clauses.push('date <= ?'); values.push(filter.dateTo) }
    let items = (this.sql.prepare(`SELECT id FROM advances WHERE ${clauses.join(' AND ')} ORDER BY date DESC, created_at DESC`).all(...values) as {id: string}[]).map(row => this.get(row.id))
    if (filter.keyword) { const keyword = filter.keyword.toLocaleLowerCase(); items = items.filter(item => [item.title, item.payee, item.remark, item.invoiceNumber].some(text => text.toLocaleLowerCase().includes(keyword))) }
    if (filter.status) items = items.filter(item => filter.status === 'paid' ? !item.remaining : filter.status === 'partial' ? item.recovered > 0 && item.remaining > 0 : item.recovered === 0)
    if (filter.billing) items = items.filter(item => filter.billing === 'linked' ? item.linked : !item.linked)
    return { items, total: items.length, amount: items.reduce((sum, row) => sum + row.amount, 0), recovered: items.reduce((sum, row) => sum + row.recovered, 0),
      remaining: items.reduce((sum, row) => sum + row.remaining, 0), unbilledAmount: items.filter(row => !row.linked).reduce((sum, row) => sum + row.amount, 0) }
  }
  save(input: AdvanceSave): Advance {
    const value = advanceSaveSchema.parse(input)
    return this.sql.transaction(() => {
      if (value.projectId && !this.db.listProjects().some(p => p.id === value.projectId)) throw new AppError('PROJECT_NOT_FOUND', '项目不存在')
      if (value.id) {
        if (!value.revision) throw new AppError('DATA_CONFLICT', '请重新打开记录')
        this.check(value.id, value.revision)
        if (this.get(value.id).recovered > value.amount) throw new AppError('ADVANCE_AMOUNT', '垫付金额不能小于已收回金额')
        if (this.sql.prepare('SELECT id FROM advance_returns WHERE advance_id = ? AND date < ? LIMIT 1').get(value.id, value.date)) throw new AppError('RETURN_DATE', '垫付日期不能晚于已有收回日期')
      }
      if (value.invoiceId) {
        const invoice = this.db.get(value.invoiceId)
        if (!invoice || invoice.deletedAt || invoice.status === 'void') throw new AppError('INVOICE_NOT_FOUND', '请选择有效发票')
        if ((invoice.projects[0]?.id ?? null) !== value.projectId) throw new AppError('PROJECT_MISMATCH', '补票发票与垫付记录必须属于同一项目')
        if (invoice.totalAmount !== value.amount) throw new AppError('AMOUNT_MISMATCH', '补票发票的价税合计须与本笔垫付金额一致')
        const existing = this.sql.prepare('SELECT id FROM advances WHERE invoice_id = ? AND id != ?').get(value.invoiceId, value.id ?? '')
        if (existing) throw new AppError('INVOICE_LINKED', '这张发票已关联其他垫付记录（含回收站），请先解除原关联')
      }
      const id = value.id ?? randomUUID(), now = new Date().toISOString()
      if (value.id) {
        this.sql.prepare('UPDATE advances SET title=?, amount=?, date=?, project_id=?, payee=?, remark=?, invoice_id=? WHERE id=?')
          .run(value.title, value.amount, value.date, value.projectId, value.payee, value.remark, value.invoiceId, id)
        this.touch(id)
      } else this.sql.prepare('INSERT INTO advances (id,title,amount,date,project_id,payee,remark,invoice_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(id, value.title, value.amount, value.date, value.projectId, value.payee, value.remark, value.invoiceId, now, now)
      return this.get(id)
    })()
  }
  setDeleted(id: string, revision: number, deleted: boolean): void {
    this.check(id, revision, true)
    this.sql.prepare('UPDATE advances SET deleted = ? WHERE id = ?').run(deleted ? 1 : 0, id)
    this.touch(id)
  }
  addReturn(input: Parameters<import('@shared/advances').AdvanceApi['addAdvanceReturn']>[0]): Advance {
    const value = advanceReturnSchema.parse(input)
    return this.sql.transaction(() => {
      const row = this.check(value.id, value.revision)
      if (value.date < row.date) throw new AppError('RETURN_DATE', '收回日期不能早于垫付日期')
      if (value.amount > this.get(value.id).remaining) throw new AppError('RETURN_AMOUNT', '收回金额不能超过剩余垫付款')
      this.sql.prepare('INSERT INTO advance_returns (id,advance_id,date,amount,remark) VALUES (?,?,?,?,?)').run(randomUUID(), value.id, value.date, value.amount, value.remark)
      this.touch(value.id)
      return this.get(value.id)
    })()
  }
  removeReturn(id: string, revision: number, returnId: string): Advance {
    this.check(id, revision)
    const result = this.sql.prepare('DELETE FROM advance_returns WHERE id = ? AND advance_id = ?').run(returnId, id)
    if (!result.changes) throw new AppError('RETURN_NOT_FOUND', '收回记录不存在')
    this.touch(id)
    return this.get(id)
  }
  private path(relative: string): string {
    if (!this.directory) throw new AppError('FILE_INVALID', '附件目录未配置')
    const path = resolve(this.directory, relative), root = resolve(this.directory, 'invoice-files', 'advances')
    if (!path.startsWith(root + sep)) throw new AppError('FILE_INVALID', '附件路径无效')
    return path
  }
  async addAttachments(id: string, revision: number, sources: string[]): Promise<Advance> {
    this.check(id, revision)
    if (this.get(id).attachments.length + sources.length > 20) throw new AppError('ATTACHMENT_LIMIT', '每笔记录最多 20 个附件')
    const prepared: Array<{id: string; name: string; path: string; sha256: string; size: number}> = []
    try {
      await mkdir(join(this.directory, 'invoice-files', 'advances'), { recursive: true })
      for (const source of sources) {
        const info = await stat(source), ext = extname(source).toLowerCase()
        if (!info.isFile() || info.size > 25 * 1024 * 1024 || info.size < 12) throw new AppError('FILE_INVALID', '附件须为不超过 25 MB 的图片或 PDF')
        const data = await readFile(source)
        if (data.length > 25 * 1024 * 1024 || !hasValidSignature(data, ext)) throw new AppError('FILE_INVALID', '附件须为 JPG、PNG、BMP、WebP 或 PDF，且文件内容有效')
        const attachmentId = randomUUID(), relative = `invoice-files/advances/${attachmentId}${ext}`
        prepared.push({ id: attachmentId, name: basename(source), path: relative, sha256: createHash('sha256').update(data).digest('hex'), size: data.length })
        await writeFile(this.path(relative), data, { flag: 'wx' })
      }
      this.sql.transaction(() => {
        this.check(id, revision)
        for (const file of prepared) this.sql.prepare('INSERT INTO advance_attachments (id,advance_id,name,storage_path,sha256,size) VALUES (?,?,?,?,?,?)')
          .run(file.id, id, file.name, file.path, file.sha256, file.size)
        if (prepared.length) this.touch(id)
      })()
    } catch (error) { await Promise.all(prepared.map(file => unlink(this.path(file.path)).catch(() => {}))); throw error }
    return this.get(id)
  }
  attachmentPath(id: string, attachmentId: string): string {
    this.row(id)
    const row = this.sql.prepare('SELECT storage_path FROM advance_attachments WHERE id = ? AND advance_id = ?').get(attachmentId, id) as { storage_path: string } | undefined
    if (!row) throw new AppError('ATTACHMENT_NOT_FOUND', '附件不存在')
    return this.path(row.storage_path)
  }
  async removeAttachment(id: string, revision: number, attachmentId: string): Promise<Advance> {
    this.check(id, revision)
    const path = this.attachmentPath(id, attachmentId)
    this.sql.prepare('DELETE FROM advance_attachments WHERE id = ? AND advance_id = ?').run(attachmentId, id)
    this.touch(id)
    await unlink(path).catch(() => {})
    return this.get(id)
  }
  workbook(filter: AdvanceFilter): ExcelJS.Workbook {
    const data = this.list(filter), workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('垫付记录')
    sheet.addRow(['事项', '垫付日期', '项目', '收款方', '垫付金额', '已收回', '待收回', '收回状态', '补票状态', '关联发票', '备注', '附件'])
    for (const item of data.items) sheet.addRow([item.title, item.date, item.projectName, item.payee, item.amount / 100, item.recovered / 100, item.remaining / 100,
      item.remaining === 0 ? '已收回' : item.recovered ? '部分收回' : '未收回', item.linked ? '已补票' : item.invoiceId ? '关联已失效' : '无票', item.invoiceNumber, item.remark, item.attachments.map(file => file.name).join('；')])
    const returns = workbook.addWorksheet('收回明细')
    returns.addRow(['事项', '垫付日期', '收回日期', '收回金额', '备注'])
    for (const item of data.items) for (const payment of item.returns) returns.addRow([item.title, item.date, payment.date, payment.amount / 100, payment.remark])
    const totals = workbook.addWorksheet('汇总与口径')
    totals.addRow(['指标', '数值']); totals.addRow(['垫付笔数', data.total]); totals.addRow(['垫付金额（元）', data.amount / 100]); totals.addRow(['已收回（元）', data.recovered / 100]); totals.addRow(['待收回（元）', data.remaining / 100]); totals.addRow(['无票支出（元）', data.unbilledAmount / 100])
    totals.addRow(['口径', '收回不抵减支出；有效补票关联不计入无票支出；附件列仅列出文件名。'])
    totals.addRow(['筛选', JSON.stringify(filter)])
    for (const tab of workbook.worksheets) {
      tab.views = [{ state: 'frozen', ySplit: 1 }]
      tab.getRow(1).font = { bold: true, color: { argb: 'FF334155' } }
      tab.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EDF4' } }
      tab.columns.forEach(column => { column.width = 24 })
    }
    for (const col of [5, 6, 7]) sheet.getColumn(col).numFmt = '#,##0.00'
    returns.getColumn(4).numFmt = '#,##0.00'
    return workbook
  }
}
