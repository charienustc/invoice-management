import { PDFDocument, PDFName, PDFString } from 'pdf-lib'

// A common Chinese PDF layout: non-embedded CID font with an external Adobe CMap.
export async function cjkPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const descriptor = pdf.context.register(pdf.context.obj({ Type: 'FontDescriptor', FontName: 'STSong-Light',
    Flags: 4, FontBBox: [-250, -250, 1200, 1000], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 80 }))
  const cid = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'CIDFontType0', BaseFont: 'STSong-Light',
    CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('GB1'), Supplement: 4 }, FontDescriptor: descriptor, DW: 1000 }))
  const font = pdf.context.register(pdf.context.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light',
    Encoding: 'UniGB-UCS2-H', DescendantFonts: [cid] }))
  for (const [width, height] of [[800, 400], [400, 800]]) {
    const page = pdf.addPage([width, height])
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ Font: { Chinese: font } }))
    const hex = (text: string) => [...text].map(char => char.charCodeAt(0).toString(16).padStart(4, '0')).join('')
    const content = `BT /Chinese 24 Tf 30 ${height - 50} Td <${hex('电子发票铁路电子客票')}> Tj 0 -90 Td <${hex('票价人民币陆拾玖元')}> Tj 0 -${height - 200} Td <${hex('购买方名称测试大学')}> Tj ET`
    page.node.set(PDFName.of('Contents'), pdf.context.register(pdf.context.flateStream(content)))
  }
  return pdf.save()
}
