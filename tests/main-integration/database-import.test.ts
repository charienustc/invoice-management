import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { InvoiceService } from '../../src/main/services/invoice-service'
import type { Invoice, InvoiceFields } from '@shared/contracts'

let directory: string
let db: InvoiceDatabase
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function fields(invoice: Invoice): InvoiceFields {
  return { invoiceType: invoice.invoiceType, invoiceCode: invoice.invoiceCode, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, buyerName: invoice.buyerName, buyerTaxId: invoice.buyerTaxId, sellerName: invoice.sellerName, sellerTaxId: invoice.sellerTaxId, amountExcludingTax: invoice.amountExcludingTax, taxAmount: invoice.taxAmount, totalAmount: invoice.totalAmount, remark: invoice.remark }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-db-test-'))
  db = new InvoiceDatabase(directory)
})
afterEach(async () => {
  db?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('SQLite 与文件导入', () => {
  it('原子导入并阻止相同文件重复建档', async () => {
    const source = join(directory, 'source.png')
    await writeFile(source, png)
    const enqueue = vi.fn()
    const service = new ImportService(db, directory, enqueue)
    const first = await service.import([source])
    const second = await service.import([source])
    expect(first.imported).toHaveLength(1)
    expect(second.duplicates).toEqual([{ fileName: 'source.png', invoiceId: first.imported[0].id, deleted: false }])
    expect(db.list({ page: 1, pageSize: 20 }).total).toBe(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect((await readFile(join(directory, db.getStoragePath(first.imported[0].id)!))).equals(png)).toBe(true)
  })

  it('拒绝扩展名与文件签名不符的输入', async () => {
    const source = join(directory, 'fake.png')
    await writeFile(source, 'not a real png content')
    const service = new ImportService(db, directory, vi.fn())
    const result = await service.import([source])
    expect(result.failures[0].message).toContain('扩展名')
  })

  it('重新 OCR 不覆盖人工字段，应用结果时仍保留人工字段', () => {
    const invoice = db.create({ fileName: 'a.png', storagePath: 'invoice-files/a.png', mimeType: 'image/png', fileSize: 10, sha256: 'a'.repeat(64) })
    db.recordOcrSuccess(invoice.id, { rawResponse: {}, normalizedText: '', parsedFields: { invoiceNumber: '12345678', buyerName: '原购买方' }, evidence: {}, warnings: [] })
    db.updateFields(invoice.id, { ...fields(db.get(invoice.id)!), buyerName: '人工购买方', invoiceDate: '2026-11-04', totalAmount: 100 }, false)
    db.recordOcrSuccess(invoice.id, { rawResponse: {}, normalizedText: '', parsedFields: { invoiceNumber: '87654321', buyerName: '新购买方', sellerName: '销售方' }, evidence: {}, warnings: [] })
    expect(db.get(invoice.id)).toMatchObject({ invoiceNumber: '87654321', buyerName: '人工购买方', sellerName: '销售方', reviewStatus: 'needs_review' })
    const result = db.getOcrResults(invoice.id)[0]
    db.applyOcrResult(invoice.id, result.id)
    expect(db.get(invoice.id)).toMatchObject({ invoiceNumber: '87654321', buyerName: '人工购买方', sellerName: '销售方' })
  })

  it('应用旧结果时用当前规则重解析原始 OCR', () => {
    const invoice = db.create({ fileName: 'old.png', storagePath: 'old', mimeType: 'image/png', fileSize: 1, sha256: 'e'.repeat(64) })
    const rawResponse = { lines: [
      { text: '电子发统(普通发票)' },
      { text: '购买方信息', bbox: [[2, 155], [30, 155], [30, 165], [2, 165]] },
      { text: '名称：示例购买方大学', bbox: [[41, 165], [250, 165], [250, 175], [41, 175]] },
      { text: '销售方信息', bbox: [[601, 157], [626, 157], [626, 167], [601, 167]] },
      { text: '名称：示例销售方科技有限公司', bbox: [[635, 170], [876, 170], [876, 180], [635, 180]] },
      { text: '纳税人识别号：TESTBUYER0000000001', bbox: [[41, 236], [556, 236], [556, 246], [41, 246]] },
      { text: '纳税人识别号：TESTSELLER000000001', bbox: [[631, 239], [1157, 239], [1157, 249], [631, 249]] },
      { text: '合' }, { text: '计' }, { text: '¥47.38' }, { text: '¥1.42' }, { text: '（小写）¥48.80' },
    ] }
    db.recordOcrSuccess(invoice.id, { rawResponse, normalizedText: '', parsedFields: { sellerTaxId: 'TESTBUYER0000000001' }, evidence: {}, warnings: [] })
    const resultId = db.getOcrResults(invoice.id)[0].id
    new InvoiceService(db, new ImportService(db, directory, vi.fn())).applyOcr(invoice.id, resultId)
    expect(db.get(invoice.id)).toMatchObject({
      invoiceType: '电子发票（普通发票）',
      buyerName: '示例购买方大学',
      buyerTaxId: 'TESTBUYER0000000001',
      sellerName: '示例销售方科技有限公司',
      sellerTaxId: 'TESTSELLER000000001',
      amountExcludingTax: 4738,
      taxAmount: 142,
      totalAmount: 4880,
    })
  })

  it('业务重复提示且统计仅包含已确认发票', () => {
    const first = db.create({ fileName: 'a.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: 'b'.repeat(64) })
    const second = db.create({ fileName: 'b.png', storagePath: 'b', mimeType: 'image/png', fileSize: 1, sha256: 'c'.repeat(64) })
    const base = { ...fields(first), invoiceNumber: '12345678901234567890', invoiceDate: '2026-11-04', totalAmount: 10600, taxAmount: 600 }
    db.updateFields(first.id, base, true)
    db.updateFields(second.id, { ...base }, false)
    expect(db.getDuplicates(second.id).map((item) => item.id)).toEqual([first.id])
    expect(db.getStats({}).invoiceCount).toBe(1)
    expect(db.getStats({}).totalAmount).toBe(10600)
  })
})
