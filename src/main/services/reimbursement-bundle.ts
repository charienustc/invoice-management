import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import { PDFDocument } from 'pdf-lib'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import type { ExportFilesInput, ExportResult } from '@shared/contracts'
import { REVIEW_STATUS_LABELS, INVOICE_STATUS_LABELS } from '@shared/labels'
import { AppError } from '@shared/errors'
import type { InvoiceDatabase } from '../db/database'
import type { ImportService } from './import-service'

const safeName = (text: string) => text.replace(/[\x00-\x1f\\/:*?"<>|]/g, '_').replace(/[. ]+$/g, '').slice(0, 110) || '未命名'

export async function createReimbursementBundle(db: InvoiceDatabase, files: ImportService, parent: string, input: ExportFilesInput): Promise<ExportResult> {
  const invoices = db.listForExport(input.filter ?? {}, input.invoiceIds)
  if (!invoices.length) throw new AppError('EXPORT_EMPTY', '没有可导出的发票')
  if (invoices.length > 100) throw new AppError('BUNDLE_LIMIT', '一次最多生成 100 张发票的材料包，请缩小范围')
  const staging = await mkdtemp(join(parent, '.invoice-bundle-'))
  try {
    const originals = join(staging, '原始发票')
    await mkdir(originals)
    const merged = await PDFDocument.create()
    const book = new ExcelJS.Workbook()
    const sheet = book.addWorksheet('费用清单')
    sheet.columns = [
      ['序号', 8], ['项目', 20], ['开票日期', 15], ['发票号码', 26], ['销售方', 30], ['购买方', 30],
      ['不含税金额', 16], ['税额', 14], ['价税合计', 16], ['核对状态', 14], ['发票状态', 14], ['原件路径', 60], ['合并页码', 14], ['备注', 30],
    ].map(([header, width]) => ({ header: String(header), width: Number(width) }))
    sheet.views = [{ state: 'frozen', ySplit: 1 }]
    sheet.autoFilter = `A1:N${invoices.length + 1}`
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF425A72' } }
    let bytes = 0, totalCents = 0, missingAmounts = 0
    for (const [index, invoice] of invoices.entries()) {
      const file = await files.readInvoiceFile(invoice.id)
      bytes += file.data.byteLength
      if (bytes > 150 * 1024 * 1024) throw new AppError('BUNDLE_LIMIT', '原件合计超过 150 MB，请分批生成材料包')
      const number = String(index + 1).padStart(3, '0')
      const name = `${number}_${safeName(`${invoice.invoiceDate || '未填日期'}_${invoice.invoiceNumber || '未填号码'}_${invoice.sellerName || '未填销售方'}`)}${extname(file.fileName).toLowerCase()}`
      const firstPage = merged.getPageCount() + 1
      try {
        if (file.mimeType === 'application/pdf') {
          const original = await PDFDocument.load(file.data)
          if (!original.getPageCount()) throw new AppError('BUNDLE_FILE_INVALID', `“${invoice.fileName}”没有可合并的页面`)
          if (merged.getPageCount() + original.getPageCount() > 200) throw new AppError('BUNDLE_LIMIT', '合并 PDF 最多 200 页，请分批生成')
          const pages = await merged.copyPages(original, original.getPageIndices())
          for (const page of pages) merged.addPage(page)
        } else {
          const image = await loadImage(file.data)
          if (image.width * image.height > 30_000_000) throw new AppError('BUNDLE_IMAGE_SIZE', '图片尺寸过大，请缩小后再生成')
          const canvas = createCanvas(image.width, image.height)
          const context = canvas.getContext('2d')
          context.fillStyle = '#fff'; context.fillRect(0, 0, image.width, image.height); context.drawImage(image, 0, 0)
          const embedded = await merged.embedPng(canvas.toBuffer('image/png'))
          const dimensions: [number, number] = image.width > image.height ? [841.89, 595.28] : [595.28, 841.89]
          const page = merged.addPage(dimensions)
          const scale = Math.min((dimensions[0] - 48) / image.width, (dimensions[1] - 48) / image.height)
          const width = image.width * scale, height = image.height * scale
          page.drawImage(embedded, { x: (dimensions[0] - width) / 2, y: (dimensions[1] - height) / 2, width, height })
        }
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('BUNDLE_FILE_INVALID', `无法合并“${invoice.fileName}”，请检查文件是否损坏或加密`)
      }
      if (merged.getPageCount() > 200) throw new AppError('BUNDLE_LIMIT', '合并 PDF 最多 200 页，请分批生成')
      await writeFile(join(originals, name), file.data, { flag: 'wx' })
      const lastPage = merged.getPageCount()
      const row = sheet.addRow([index + 1, invoice.projects.map(p => p.name).join('、'), invoice.invoiceDate, invoice.invoiceNumber,
        invoice.sellerName, invoice.buyerName, invoice.amountExcludingTax === null ? null : invoice.amountExcludingTax / 100,
        invoice.taxAmount === null ? null : invoice.taxAmount / 100, invoice.totalAmount === null ? null : invoice.totalAmount / 100,
        REVIEW_STATUS_LABELS[invoice.reviewStatus], INVOICE_STATUS_LABELS[invoice.status], `原始发票/${name}`,
        firstPage === lastPage ? String(firstPage) : `${firstPage}-${lastPage}`, invoice.remark])
      for (const column of [7, 8, 9]) row.getCell(column).numFmt = '#,##0.00'
      row.alignment = { vertical: 'middle', wrapText: true }; row.height = 48
      if (invoice.totalAmount === null) missingAmounts++; else totalCents += invoice.totalAmount
    }
    sheet.addRow([])
    const summary = sheet.addRow(['', missingAmounts ? `已填写金额合计（${missingAmounts} 张未填）` : '合计', '', '', '', '', '', '', totalCents / 100])
    summary.font = { bold: true }; summary.getCell(9).numFmt = '#,##0.00'
    await book.xlsx.writeFile(join(staging, '费用清单.xlsx'))
    await writeFile(join(staging, '合并打印.pdf'), await merged.save())
    const pending = invoices.filter(invoice => invoice.reviewStatus !== 'confirmed').length
    await writeFile(join(staging, '材料说明.txt'), `共 ${invoices.length} 张发票，合并 ${merged.getPageCount()} 页。\r\n清单序号对应原件文件名前缀，合并页码见费用清单。\r\n未确认 ${pending} 张，未填写价税合计 ${missingAmounts} 张，请在提交前核对。\r\n`, 'utf8')
    const project = new Set(invoices.flatMap(i => i.projects.map(p => p.name)))
    const label = project.size === 1 ? [...project][0] : '发票'
    const destination = join(parent, `报销材料-${safeName(label)}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`)
    await rename(staging, destination)
    return { canceled: false, filePath: destination, count: invoices.length }
  } catch (error) {
    if (dirname(resolve(staging)) !== resolve(parent)) throw new Error('Unexpected bundle staging path')
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}
