import { dialog, type BrowserWindow } from 'electron'
import { access, copyFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import ExcelJS from 'exceljs'
import {
  DEFAULT_EXPORT_COLUMNS,
  EXPORT_COLUMN_LABELS,
  type ExportColumn,
  type ExportFilesInput,
  type ExportInput,
  type ExportResult,
  type Invoice,
  type StatsFilter,
} from '@shared/contracts'
import { centsToDecimal } from '@shared/money'
import { INVOICE_STATUS_LABELS, REVIEW_STATUS_LABELS } from '@shared/labels'
import { AppError } from '@shared/errors'
import { InvoiceDatabase } from '../db/database'
import { ImportService } from './import-service'
import { createReimbursementBundle } from './reimbursement-bundle'
import { buildStatsWorkbook } from './stats-report'
import { AdvanceService } from './advance-service'

function columnValue(invoice: Invoice, column: ExportColumn): string | number {
  switch (column) {
    case 'amountExcludingTax': return centsToDecimal(invoice.amountExcludingTax)
    case 'taxAmount': return centsToDecimal(invoice.taxAmount)
    case 'totalAmount': return centsToDecimal(invoice.totalAmount)
    case 'reviewStatus': return REVIEW_STATUS_LABELS[invoice.reviewStatus]
    case 'status': return INVOICE_STATUS_LABELS[invoice.status]
    case 'tags': return invoice.tags.join('、')
    case 'projectNames': return invoice.projects.map((project) => project.name).join('、')
    case 'createdAt': return invoice.createdAt.slice(0, 19).replace('T', ' ')
    default: return invoice[column]
  }
}

export function buildExportRows(invoices: Invoice[], columns: ExportColumn[]): Array<Array<string | number>> {
  return invoices.map((invoice) => columns.map((column) => columnValue(invoice, column)))
}

function csvCell(value: string | number): string {
  let text = String(value)
  if (/^\s*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replace(/"/g, '""')}"`
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || '未命名'
}

function exportFileName(invoice: Invoice): string {
  const date = invoice.invoiceDate || '未填日期'
  const number = invoice.invoiceNumber || invoice.id.slice(0, 8)
  return sanitizeFileName(`${date}_${number}_${invoice.fileName}`)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export class ExportService {
  private bundling = false
  constructor(
    private readonly db: InvoiceDatabase,
    private readonly files: ImportService,
    private readonly documentsDirectory: string,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  async exportStats(filter: StatsFilter): Promise<ExportResult> {
    const options = { title: '导出统计报表', defaultPath: join(this.documentsDirectory, '发票统计报表.xlsx'), filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }] }
    const window = this.getWindow()
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    const stats = this.db.getStats(filter)
    const incompatible = filter.reviewScope !== 'all' && filter.reviewStatus && filter.reviewStatus !== 'confirmed'
    const invoices = incompatible ? [] : this.db.listForExport({ ...filter, reviewStatus: filter.reviewScope === 'all' ? filter.reviewStatus : 'confirmed' })
    const project = filter.projectId === null ? '未分配' : filter.projectId ? this.db.listProjects().find(project => project.id === filter.projectId)?.name || '项目已删除' : '全部项目'
    const workbook = buildStatsWorkbook(stats, filter, project, invoices)
    const advanceBook = new AdvanceService(this.db).workbook({ projectId: filter.projectId, dateFrom: filter.dateFrom, dateTo: filter.dateTo })
    for (const source of advanceBook.worksheets) {
      const sheet = workbook.addWorksheet(source.name === '垫付记录' ? source.name : `垫付${source.name}`)
      source.eachRow(row => { const target = sheet.addRow(row.values); target.font = row.font; target.fill = row.fill })
      sheet.columns.forEach((column, index) => { column.width = source.getColumn(index + 1).width; column.numFmt = source.getColumn(index + 1).numFmt })
      sheet.views = [{ state: 'frozen', ySplit: 1 }]
    }
    await workbook.xlsx.writeFile(result.filePath)
    return { canceled: false, filePath: result.filePath, count: stats.invoiceCount }
  }

  async exportBundle(input: ExportFilesInput): Promise<ExportResult> {
    if (this.bundling) throw new AppError('EXPORT_BUSY', '材料包正在生成，请稍候')
    this.bundling = true
    try {
      const options = { title: '选择报销材料包保存位置', defaultPath: this.documentsDirectory, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
      const window = this.getWindow()
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (result.canceled || !result.filePaths.length) return { canceled: true, count: 0 }
      return await createReimbursementBundle(this.db, this.files, result.filePaths[0], input)
    } finally { this.bundling = false }
  }

  async export(input: ExportInput): Promise<ExportResult> {
    const invoices = this.db.listForExport(input.filter ?? {}, input.invoiceIds)
    if (!invoices.length) throw new AppError('EXPORT_EMPTY', '没有可导出的发票')
    const columns = input.columns?.length ? input.columns : DEFAULT_EXPORT_COLUMNS
    const headers = columns.map((column) => EXPORT_COLUMN_LABELS[column])
    const rows = buildExportRows(invoices, columns)
    const date = new Date().toISOString().slice(0, 10)
    const dialogOptions = {
      title: '导出发票',
      defaultPath: join(this.documentsDirectory, `发票导出-${date}.${input.format}`),
      filters: [{ name: input.format === 'xlsx' ? 'Excel 工作簿' : 'CSV 文件', extensions: [input.format] }],
    }
    const window = this.getWindow()
    const result = window ? await dialog.showSaveDialog(window, dialogOptions) : await dialog.showSaveDialog(dialogOptions)
    if (result.canceled || !result.filePath) return { canceled: true, count: 0 }
    if (input.format === 'xlsx') {
      const workbook = new ExcelJS.Workbook()
      const sheet = workbook.addWorksheet('发票')
      sheet.columns = headers.map((header, index) => ({ header, key: String(index), width: index < 4 ? 20 : 18 }))
      for (const row of rows) sheet.addRow(row)
      sheet.getRow(1).font = { bold: true }
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } }
      await workbook.xlsx.writeFile(result.filePath)
    } else {
      const lines = [headers, ...rows].map((cells) => cells.map(csvCell).join(','))
      await writeFile(result.filePath, `﻿${lines.join('\r\n')}`, 'utf8')
    }
    return { canceled: false, filePath: result.filePath, count: invoices.length }
  }

  async exportFiles(input: ExportFilesInput): Promise<ExportResult> {
    const invoices = this.db.listForExport(input.filter ?? {}, input.invoiceIds)
    if (!invoices.length) throw new AppError('EXPORT_EMPTY', '没有可导出的发票')
    const window = this.getWindow()
    const options = { title: '选择原始文件导出目录', defaultPath: this.documentsDirectory, properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> }
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return { canceled: true, count: 0 }
    const targetDirectory = result.filePaths[0]
    let copied = 0
    for (const invoice of invoices) {
      const storagePath = this.db.getStoragePath(invoice.id)
      if (!storagePath) continue
      const extension = extname(invoice.fileName)
      const baseName = exportFileName(invoice).slice(0, 180 - extension.length)
      let target = join(targetDirectory, `${baseName}${extension}`)
      let suffix = 2
      while (await pathExists(target)) {
        target = join(targetDirectory, `${baseName} (${suffix})${extension}`)
        suffix += 1
      }
      try {
        await copyFile(this.files.resolveStoragePath(storagePath), target)
        copied += 1
      } catch {
        // 单个文件失败不阻断整批导出
      }
    }
    return { canceled: false, filePath: targetDirectory, count: copied }
  }
}
