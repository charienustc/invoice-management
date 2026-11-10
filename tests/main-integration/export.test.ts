import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ExcelJS from 'exceljs'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { ExportService, buildExportRows } from '../../src/main/services/export-service'

const { showSaveDialog } = vi.hoisted(() => ({ showSaveDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showSaveDialog } }))

let directory: string
let db: InvoiceDatabase

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-export-test-'))
  db = new InvoiceDatabase(directory)
  const invoice = db.create({ fileName: 'a.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: 'd'.repeat(64) })
  db.updateFields(invoice.id, { invoiceType: '电子发票', invoiceCode: '001234', invoiceNumber: '12345678901234567890', invoiceDate: '2026-11-04', buyerName: '购买方', buyerTaxId: '00123', sellerName: '=1+1', sellerTaxId: '00456', amountExcludingTax: 10000, taxAmount: 600, totalAmount: 10600, remark: '测试' }, true)
})
afterEach(async () => {
  db.close()
  vi.resetAllMocks()
  await rm(directory, { recursive: true, force: true })
})

describe('发票导出', () => {
  it('CSV 保留文本并防止公式注入', async () => {
    const filePath = join(directory, 'out.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    const result = await new ExportService(db, new ImportService(db, directory, vi.fn()), directory, () => null).export({ format: 'csv' })
    const content = await readFile(filePath, 'utf8')
    expect(result.count).toBe(1)
    expect(content.charCodeAt(0)).toBe(0xfeff)
    expect(content).toContain('"001234"')
    expect(content).toContain('"\'=1+1"')
    expect(content).toContain('"106.00"')
  })

  it('Excel 可按文本读取发票号码', async () => {
    const filePath = join(directory, 'out.xlsx')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    await new ExportService(db, new ImportService(db, directory, vi.fn()), directory, () => null).export({ format: 'xlsx' })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const sheet = workbook.getWorksheet('发票')!
    expect(sheet.getCell('C2').value).toBe('12345678901234567890')
    expect(sheet.getCell('K2').value).toBe('106.00')
  })

  it('按指定列导出并带状态与标签', async () => {
    const invoice = db.list({ page: 1, pageSize: 1 }).items[0]
    db.setInvoiceTags(invoice.id, ['差旅'])
    db.batchSetStatus([invoice.id], 'reimbursed')
    const filePath = join(directory, 'cols.csv')
    showSaveDialog.mockResolvedValue({ canceled: false, filePath })
    const result = await new ExportService(db, new ImportService(db, directory, vi.fn()), directory, () => null)
      .export({ format: 'csv', columns: ['invoiceNumber', 'totalAmount', 'status', 'tags'] })
    const content = await readFile(filePath, 'utf8')
    expect(result.count).toBe(1)
    const [header, row] = content.trim().split('\r\n')
    expect(header).toBe('"发票号码","价税合计","发票状态","标签"')
    expect(row).toContain('"已报销"')
    expect(row).toContain('"差旅"')
  })

  it('buildExportRows 输出金额与状态文本', () => {
    const invoice = db.list({ page: 1, pageSize: 1 }).items[0]
    const [row] = buildExportRows([invoice], ['invoiceNumber', 'totalAmount', 'status', 'reviewStatus'])
    expect(row).toEqual(['12345678901234567890', '106.00', '未处理', '已确认'])
  })
})
