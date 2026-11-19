import { describe, expect, it } from 'vitest'
import { PDFDocument, StandardFonts, pushGraphicsState, popGraphicsState, rectangle, clip, endPath, rgb } from 'pdf-lib'
import { convertPdfToPng } from '../../src/main/ocr/pdf-converter'
import { cjkPdf } from '../fixtures/cjk-pdf'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'

describe('PDF 转图', () => {
  it('渲染矢量路径与裁剪区域，区域外保持空白', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([200, 160])
    page.pushOperators(pushGraphicsState(), rectangle(30, 40, 80, 70), clip(), endPath())
    page.drawRectangle({ x: 0, y: 0, width: 200, height: 160, color: rgb(1, 0, 0) })
    page.pushOperators(popGraphicsState())
    page.drawSvgPath('M 130 20 C 160 0 180 20 175 40 L 130 40 Z', { x: 0, y: 100, color: rgb(0, 0, 1) })
    const images = await convertPdfToPng(Buffer.from(await pdf.save()))
    const image = await loadImage(images[0])
    const ctx = createCanvas(image.width, image.height).getContext('2d'); ctx.drawImage(image, 0, 0)
    expect(Array.from(ctx.getImageData(100, 160, 1, 1).data)).toEqual([255, 0, 0, 255])
    expect(Array.from(ctx.getImageData(20, 160, 1, 1).data)).toEqual([255, 255, 255, 255])
  })
  it('拒绝极端长页和过多页面，超时会终止独立解析进程', async () => {
    const huge = await PDFDocument.create(); huge.addPage([1000, 1_000_000])
    await expect(convertPdfToPng(Buffer.from(await huge.save()))).rejects.toMatchObject({ code: 'PDF_TOO_LARGE' })
    const many = await PDFDocument.create(); for (let i = 0; i < 21; i++) many.addPage([100, 100])
    await expect(convertPdfToPng(Buffer.from(await many.save()))).rejects.toMatchObject({ code: 'PDF_TOO_MANY_PAGES' })
    const normal = await PDFDocument.create(); normal.addPage([100, 100])
    await expect(convertPdfToPng(Buffer.from(await normal.save()), 1)).rejects.toMatchObject({ code: 'PDF_TIMEOUT' })
  })
  it('离线渲染依赖 Adobe CMap 的非嵌入中文字体及页面底部', async () => {
    const images = await convertPdfToPng(Buffer.from(await cjkPdf()))
    expect(images).toHaveLength(2)
    for (const [index, data] of images.entries()) {
      if (process.env.CI) {
        await mkdir('.tmp/pdf-regression', { recursive: true })
        await writeFile(`.tmp/pdf-regression/page-${index + 1}.png`, data)
      }
      const image = await loadImage(data)
      const ctx = createCanvas(image.width, image.height).getContext('2d')
      ctx.drawImage(image, 0, 0)
      for (const [top, height] of [[0, 120], [image.height - 140, 140]]) {
        const pixels = ctx.getImageData(0, top, image.width, height).data
        let dark = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 100 && pixels[i+1] < 100 && pixels[i+2] < 100) dark++
        expect(dark, `page=${index + 1}, regionTop=${top}, size=${image.width}x${image.height}`).toBeGreaterThan(150)
      }
    }
  })
  it('将每页 PDF 转为有效 PNG', async () => {
    const pdf = await PDFDocument.create()
    const font = await pdf.embedFont(StandardFonts.Helvetica)
    for (const text of ['Invoice page 1', 'Invoice page 2']) {
      const page = pdf.addPage([400, 300])
      page.drawText(text, { x: 40, y: 220, size: 24, font })
    }
    const images = await convertPdfToPng(Buffer.from(await pdf.save()))
    expect(images).toHaveLength(2)
    for (const image of images) {
      expect(image.length).toBeGreaterThan(1000)
      expect(image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
    }
  }, 30_000)
})
