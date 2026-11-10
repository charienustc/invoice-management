import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCanvas } from '@napi-rs/canvas'
import { PDFDocument } from 'pdf-lib'
import ExcelJS from 'exceljs'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { createReimbursementBundle } from '../../src/main/services/reimbursement-bundle'

let directory: string, db: InvoiceDatabase, files: ImportService
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'invoice-bundle-')); db = new InvoiceDatabase(directory); files = new ImportService(db, directory, vi.fn()) })
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })

it('按选中范围生成清单、原件与多页 PDF，序号和页码一一对应且保留原件字节', async () => {
  const image = createCanvas(800, 400); image.getContext('2d').fillRect(0, 0, 800, 400)
  const png = image.toBuffer('image/png')
  const pdf = await PDFDocument.create(); pdf.addPage(); pdf.addPage()
  const pdfBytes = Buffer.from(await pdf.save())
  await writeFile(join(directory, 'sample.png'), png); await writeFile(join(directory, 'sample.pdf'), pdfBytes)
  const imported = (await files.import([join(directory, 'sample.png'), join(directory, 'sample.pdf')])).imported
  const excluded = db.create({ fileName: 'excluded.png', storagePath: 'missing', mimeType: 'image/png', fileSize: 1, sha256: 'e'.repeat(64) })
  const result = await createReimbursementBundle(db, files, directory, { invoiceIds: imported.map(i => i.id) })
  expect(result.count).toBe(2)
  const book = new ExcelJS.Workbook(); await book.xlsx.readFile(join(result.filePath!, '费用清单.xlsx'))
  const sheet = book.getWorksheet('费用清单')!
  const merged = await PDFDocument.load(await readFile(join(result.filePath!, '合并打印.pdf')))
  expect(merged.getPageCount()).toBe(3)
  for (const rowIndex of [2, 3]) {
    const relative = String(sheet.getCell(rowIndex, 12).value)
    const original = await readFile(join(result.filePath!, relative))
    const isPdf = relative.endsWith('.pdf')
    expect(original).toEqual(isPdf ? pdfBytes : png)
    const pageRange = String(sheet.getCell(rowIndex, 13).value).split('-').map(Number)
    expect((pageRange[1] ?? pageRange[0]) - pageRange[0] + 1).toBe(isPdf ? 2 : 1)
    expect(relative).toContain(String(rowIndex - 1).padStart(3, '0'))
  }
  expect(db.get(excluded.id)?.ocrStatus).toBe('pending')
  expect((await readdir(directory)).filter(name => name.startsWith('.invoice-bundle-'))).toEqual([])
})

it('损坏原件时清理未完成包，不改动已有导出目录和发票', async () => {
  await writeFile(join(directory, 'broken.pdf'), '%PDF-1.7\nbroken')
  const id = (await files.import([join(directory, 'broken.pdf')])).imported[0].id
  const before = await readdir(directory)
  await expect(createReimbursementBundle(db, files, directory, { invoiceIds: [id] })).rejects.toMatchObject({ code: 'BUNDLE_FILE_INVALID' })
  expect(await readdir(directory)).toEqual(before)
  expect(db.get(id)?.fileName).toBe('broken.pdf')
})
