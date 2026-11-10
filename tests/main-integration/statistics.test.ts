import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { InvoiceDatabase } from '../../src/main/db/database'
import { buildStatsWorkbook } from '../../src/main/services/stats-report'
import { statsFilterSchema, type InvoiceStatus, type StatsFilter } from '@shared/contracts'
import { monthDates, monthSeries } from '@shared/stats'

let directory: string, db: InvoiceDatabase, sequence: number
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'invoice-statistics-')); db = new InvoiceDatabase(directory); sequence = 0 })
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const valid: StatsFilter = { statuses: ['unprocessed', 'booked', 'reimbursed'] }
function invoice(date: string, total: number | null, status: InvoiceStatus = 'unprocessed', confirmed = true, seller = '商户A') {
  const index = ++sequence
  const item = db.create({ fileName: `${index}.png`, storagePath: String(index), mimeType: 'image/png', fileSize: 1, sha256: String(index).padStart(64, '0') })
  db.updateFields(item.id, { ...item, invoiceNumber: String(index).padStart(8, '0'), invoiceDate: date, invoiceType: '电子发票', sellerName: seller,
    totalAmount: total, amountExcludingTax: total === null ? null : total / 106 * 100, taxAmount: total === null ? null : total / 106 * 6 }, confirmed)
  db.batchSetStatus([item.id], status)
  return item.id
}
function seed() {
  const a = invoice('2026-10-31', 10600), b = invoice('2026-11-10', 21200, 'booked'), c = invoice('2026-11-20', 31800, 'reimbursed', true, '商户B')
  const d = invoice('2026-11-26', 42400, 'void'), e = invoice('', null, 'unprocessed', false, '商户A分部'), f = invoice('2026-11-12', 53000)
  const first = db.createProject({ name: '设备', description: '' }), second = db.createProject({ name: '差旅', description: '' })
  db.setInvoiceProjects([a, b], [first.id]); db.setInvoiceProjects([d, e, f], [second.id]); db.softDelete([f]); db.setInvoiceTags(a, ['办公'])
  return { a, b, c, d, e, f, first, second }
}

it('确认口径、作废状态与回收站分别处理，项目分组不会重复累计', () => {
  seed()
  expect(db.getStats({})).toMatchObject({ invoiceCount: 4, totalAmount: 106000, confirmedCount: 4 })
  const stats = db.getStats(valid)
  expect(stats).toMatchObject({ invoiceCount: 3, totalAmount: 63600, amountExcludingTax: 60000, taxAmount: 3600, averageAmount: 21200 })
  expect(stats.byProject.reduce((sum, row) => sum + row.totalAmount, 0)).toBe(stats.totalAmount)
  expect(stats.byProject.reduce((sum, row) => sum + row.invoiceCount, 0)).toBe(stats.invoiceCount)
  expect(stats.byProject.find(row => row.projectId === null)).toMatchObject({ invoiceCount: 1, totalAmount: 31800 })
  expect(db.getStats({ status: 'void' })).toMatchObject({ invoiceCount: 1, totalAmount: 42400 })
  expect(db.getStats({ reviewStatus: 'unreviewed' }).invoiceCount).toBe(0)
  expect(db.getStats({ reviewScope: 'all', reviewStatus: 'unreviewed' }).invoiceCount).toBe(1)
})

it('含待核对口径统计缺失字段，平均值按已填金额计算，补充数据筛选可下钻', () => {
  seed()
  const filter: StatsFilter = { ...valid, reviewScope: 'all' }
  const stats = db.getStats(filter)
  expect(stats).toMatchObject({ invoiceCount: 4, confirmedCount: 3, totalAmount: 63600, averageAmount: 21200,
    missing: { invoiceDate: 1, totalAmount: 1, amountExcludingTax: 1, taxAmount: 1 } })
  expect(stats.monthly.reduce((sum, row) => sum + row.invoiceCount, 0) + stats.missing.invoiceDate).toBe(stats.invoiceCount)
  expect(db.list({ ...filter, missingField: 'totalAmount', page: 1, pageSize: 20 }).total).toBe(1)
  expect(db.getStats({ ...filter, missingField: 'totalAmount' })).toMatchObject({ invoiceCount: 1, totalAmount: 0, averageAmount: 0 })
  const incomplete = db.getStats({ ...filter, missingField: 'totalAmount' })
  const report = buildStatsWorkbook(incomplete, filter, '全部项目', [])
  expect(report.getWorksheet('金额汇总')!.getCell('B2').value).toBeNull()
  expect(report.getWorksheet('金额汇总')!.getCell('E2').value).toBeNull()
})

it('项目、日期、销售方和标签组合与明细一致，销售方按完整名称匹配', () => {
  const data = seed()
  const filter: StatsFilter = { ...valid, projectId: data.first.id, dateFrom: '2026-11-01', dateTo: '2026-11-15' }
  expect(db.getStats(filter)).toMatchObject({ invoiceCount: 1, totalAmount: 21200 })
  expect(db.listForExport({ ...filter, reviewStatus: 'confirmed' }).map(row => row.id)).toEqual([data.b])
  expect(db.getStats({ ...valid, sellerName: '商户A', reviewScope: 'all' })).toMatchObject({ invoiceCount: 2, totalAmount: 31800 })
  expect(db.getStats({ ...valid, tag: '办公' })).toMatchObject({ invoiceCount: 1, totalAmount: 10600 })
  expect(db.getStats({ ...valid, projectId: null })).toMatchObject({ invoiceCount: 1, totalAmount: 31800 })
  expect(db.getStats({ ...valid, dateFrom: '2030-01-01' })).toMatchObject({ invoiceCount: 0, totalAmount: 0, averageAmount: 0, byProject: [] })
})

it('超过十二个月的历史保留完整，近期趋势补零且限定日期边界', () => {
  for (let month = 0; month < 15; month++) invoice(`${2024 + Math.floor(month / 12)}-${String(month % 12 + 1).padStart(2, '0')}-01`, 10600)
  const stats = db.getStats({})
  expect(stats.monthly).toHaveLength(15)
  const rows = monthSeries([{ month: '2026-09', invoiceCount: 1, totalAmount: 10600, taxAmount: 600 }, { month: '2026-11', invoiceCount: 1, totalAmount: 21200, taxAmount: 1200 }], 'recent', '2026-09-15', '2026-11-20')
  expect(rows.map(row => row.month)).toEqual(['2026-09', '2026-10', '2026-11'])
  expect(rows[1].invoiceCount).toBe(0)
  expect(monthDates('2024-02')).toEqual(['2024-02-01', '2024-02-29'])
  expect(monthDates('2026-12')).toEqual(['2026-12-01', '2026-12-31'])
})

it('导出八个工作表，金额为数值、号码为文本，汇总与明细一致', async () => {
  seed()
  const filter = { ...valid, reviewScope: 'all' as const }, stats = db.getStats(filter)
  const invoices = db.listForExport(filter)
  const book = buildStatsWorkbook(stats, filter, '全部项目', invoices)
  const path = join(directory, '统计报表.xlsx'); await book.xlsx.writeFile(path)
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.readFile(path)
  expect(loaded.worksheets).toHaveLength(8)
  expect(loaded.getWorksheet('金额汇总')!.getCell('B2').value).toBe(636)
  const detail = loaded.getWorksheet('发票明细')!
  expect(detail.rowCount - 1).toBe(4)
  expect(detail.getColumn(8).values.slice(2).filter(value => typeof value === 'number').reduce((sum: number, value) => sum + Number(value), 0)).toBe(636)
  expect(detail.getColumn(1).values.slice(2).every(value => typeof value === 'string' && value.startsWith('000000'))).toBe(true)
})

it('统计日期拒绝不存在日期和倒置范围', () => {
  expect(statsFilterSchema.safeParse({ dateFrom: '2026-02-30' }).success).toBe(false)
  expect(statsFilterSchema.safeParse({ dateFrom: '2026-11-20', dateTo: '2026-11-01' }).success).toBe(false)
  expect(statsFilterSchema.safeParse({ dateFrom: '2024-02-29', dateTo: '2024-02-29' }).success).toBe(true)
})
