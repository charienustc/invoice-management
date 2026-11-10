import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { InvoiceService } from '../../src/main/services/invoice-service'
import type { Invoice } from '@shared/contracts'

let directory: string
let db: InvoiceDatabase
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

async function importOne(name: string): Promise<Invoice> {
  const source = join(directory, name)
  await writeFile(source, Buffer.concat([png, Buffer.from(name)]))
  const service = new ImportService(db, directory, vi.fn())
  const result = await service.import([source])
  return result.imported[0]
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-mgmt-test-'))
  db = new InvoiceDatabase(directory)
})
afterEach(async () => {
  db?.close()
  await rm(directory, { recursive: true, force: true })
})

describe('回收站', () => {
  it('移入回收站后从列表、统计、去重中消失，恢复后回归', async () => {
    const first = await importOne('a.png')
    const second = await importOne('b.png')
    const base = { invoiceType: '', invoiceCode: '', invoiceNumber: '12345678901234567890', invoiceDate: '2026-11-01', buyerName: '', buyerTaxId: '', sellerName: '', sellerTaxId: '', amountExcludingTax: null, taxAmount: null, totalAmount: 500, remark: '' }
    db.updateFields(first.id, base, true)
    db.updateFields(second.id, base, true)
    expect(db.getDuplicates(second.id)).toHaveLength(1)
    expect(db.softDelete([first.id])).toBe(1)
    expect(db.get(first.id)!.deletedAt).toBeTruthy()
    expect(db.list({ page: 1, pageSize: 20 }).total).toBe(1)
    expect(db.list({ page: 1, pageSize: 20, deleted: true }).total).toBe(1)
    expect(db.getStats({}).invoiceCount).toBe(1)
    expect(db.getDuplicates(second.id)).toHaveLength(0)
    expect(db.restore([first.id])).toBe(1)
    expect(db.list({ page: 1, pageSize: 20 }).total).toBe(2)
    expect(db.get(first.id)!.deletedAt).toBeNull()
  })

  it('彻底删除移除记录与原始文件，重复导入同文件会重新建档', async () => {
    const id = (await importOne('c.png')).id
    const storagePath = db.getStoragePath(id)!
    const service = new InvoiceService(db, new ImportService(db, directory, vi.fn()))
    db.softDelete([id])
    const purged = await service.purgeInvoices([id])
    expect(purged).toBe(1)
    expect(db.get(id)).toBeNull()
    expect(existsSync(join(directory, storagePath))).toBe(false)
    const reimported = await importOne('c.png')
    expect(reimported.id).not.toBe(id)
    expect(db.get(reimported.id)!.deletedAt).toBeNull()
  })

  it('已删除发票不会进入 OCR 队列', () => {
    const invoice = db.create({ fileName: 'x.png', storagePath: 'x', mimeType: 'image/png', fileSize: 1, sha256: 'f'.repeat(64) })
    db.setOcrStatus(invoice.id, 'queued')
    db.softDelete([invoice.id])
    expect(db.nextQueued(10)).toHaveLength(0)
  })
})

describe('发票状态与标签', () => {
  it('添加标签保留已有内容，超过上限或发票已删除时拒绝写入', () => {
    const item = db.create({ fileName: 'tags.png', storagePath: 'tags', mimeType: 'image/png', fileSize: 1, sha256: '7'.repeat(64) })
    const invoices = new InvoiceService(db, new ImportService(db, directory, vi.fn()))
    db.setInvoiceTags(item.id, Array.from({ length: 20 }, (_, index) => `标签${index}`))
    expect(() => invoices.addInvoicesTags([item.id], ['新标签'])).toThrow('最多保留 20')
    expect(db.get(item.id)!.tags).toHaveLength(20)
    db.softDelete([item.id])
    expect(() => invoices.addInvoicesTags([item.id], ['新标签'])).toThrow('已移入回收站')
  })
  it('金额边界、多状态筛选与导出使用相同范围', () => {
    const item = db.create({ fileName: 'amount.png', storagePath: 'amount', mimeType: 'image/png', fileSize: 1, sha256: '8'.repeat(64) })
    db.updateFields(item.id, { ...item, totalAmount: 50000 }, false)
    const filter = { amountMin: 50001, amountMax: 100000, statuses: ['unprocessed', 'reimbursed'] as const }
    expect(db.list({ ...filter, statuses: [...filter.statuses], page: 1, pageSize: 20 }).total).toBe(0)
    db.updateFields(item.id, { ...item, totalAmount: 60000 }, false)
    expect(db.listForExport({ ...filter, statuses: [...filter.statuses] })).toHaveLength(1)
    db.batchSetStatus([item.id], 'booked')
    expect(db.list({ ...filter, statuses: [...filter.statuses], page: 1, pageSize: 20 }).total).toBe(0)
  })
  it('批量设置发票状态', () => {
    const a = db.create({ fileName: 'a.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: '1'.repeat(64) })
    const b = db.create({ fileName: 'b.png', storagePath: 'b', mimeType: 'image/png', fileSize: 1, sha256: '2'.repeat(64) })
    expect(db.batchSetStatus([a.id, b.id], 'reimbursed')).toBe(2)
    expect(db.list({ page: 1, pageSize: 20, status: 'reimbursed' }).total).toBe(2)
    expect(db.list({ page: 1, pageSize: 20, status: 'unprocessed' }).total).toBe(0)
    db.batchSetStatus([a.id], 'booked')
    expect(db.get(a.id)!.status).toBe('booked')
    expect(db.get(b.id)!.status).toBe('reimbursed')
  })

  it('设置、追加、移除标签并按标签筛选', () => {
    const a = db.create({ fileName: 'a.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: '3'.repeat(64) })
    const b = db.create({ fileName: 'b.png', storagePath: 'b', mimeType: 'image/png', fileSize: 1, sha256: '4'.repeat(64) })
    db.setInvoiceTags(a.id, ['差旅', '打车'])
    db.addInvoicesTags([a.id, b.id], ['差旅'])
    expect(db.get(a.id)!.tags).toEqual(['差旅', '打车'])
    expect(db.get(b.id)!.tags).toEqual(['差旅'])
    expect(db.getTags()).toEqual(['差旅', '打车'])
    expect(db.list({ page: 1, pageSize: 20, tag: '打车' }).items.map((item) => item.id)).toEqual([a.id])
    db.removeInvoicesTags([a.id], ['打车'])
    expect(db.get(a.id)!.tags).toEqual(['差旅'])
    db.setInvoiceTags(a.id, [])
    expect(db.get(a.id)!.tags).toEqual([])
  })

  it('批量确认不影响回收站中的发票', () => {
    const a = db.create({ fileName: 'a.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: '5'.repeat(64) })
    const b = db.create({ fileName: 'b.png', storagePath: 'b', mimeType: 'image/png', fileSize: 1, sha256: '6'.repeat(64) })
    db.softDelete([b.id])
    db.updateFields(a.id, { ...a, invoiceNumber: '12345678', invoiceDate: '2026-11-05', totalAmount: 100 }, false)
    expect(db.batchConfirm([a.id, b.id])).toMatchObject({ confirmed: 1, skipped: [{ id: b.id, reason: '发票在回收站中' }] })
    expect(db.get(a.id)!.reviewStatus).toBe('confirmed')
    expect(db.get(b.id)!.reviewStatus).toBe('unreviewed')
  })

  it('单张与批量共用必填校验，零金额允许确认，非法日期被拦截', () => {
    const a = db.create({ fileName: 'blank.png', storagePath: 'a', mimeType: 'image/png', fileSize: 1, sha256: '7'.repeat(64) })
    expect(() => db.updateFields(a.id, a, true)).toThrow('确认前请填写')
    expect(db.batchConfirm([a.id])).toMatchObject({ confirmed: 0, skipped: [{ id: a.id, reason: expect.stringContaining('确认前请填写') }] })
    db.updateFields(a.id, { ...a, invoiceNumber: '12345678', invoiceDate: '2026-02-30', totalAmount: 0 }, false)
    expect(db.batchConfirm([a.id]).confirmed).toBe(0)
    db.updateFields(a.id, { ...a, invoiceNumber: '12345678', invoiceDate: '2026-11-05', totalAmount: 0 }, false)
    expect(db.batchConfirm([a.id, a.id]).confirmed).toBe(1)
    expect(db.getStats({}).invoiceCount).toBe(1)
  })
})
