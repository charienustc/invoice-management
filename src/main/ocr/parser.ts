import type { InvoiceFields, OcrFieldEvidence } from '@shared/contracts'
import { parseMoneyToCents } from '@shared/money'
import type { OcrLine } from './response-adapter'
import { normalizeLines } from './normalize'
import { measureLayout, sameRow } from './layout'

export interface ParsedInvoice {
  normalizedText: string
  fields: Partial<InvoiceFields>
  evidence: Partial<Record<keyof InvoiceFields, OcrFieldEvidence>>
  warnings: string[]
}

function normalizeDate(value: string): string | null {
  const match = value.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})日?/)
  if (!match) return null
  const [, year, month, day] = match
  const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  const parsed = new Date(`${date}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date
}

function amountsIn(line: string): number[] {
  return [...line.matchAll(/[¥￥]?\s*[+-]?\d[\d,]*\.\d{1,2}/g)]
    .map((match) => parseMoneyToCents(match[0]))
    .filter((value): value is number => value !== null)
}

export function parseInvoiceLines(inputLines: OcrLine[]): ParsedInvoice {
  const lines = normalizeLines(inputLines)
  const layout = measureLayout(lines)
  const fields: Partial<InvoiceFields> = {}
  const evidence: ParsedInvoice['evidence'] = {}
  const warnings: string[] = []
  const set = <K extends keyof InvoiceFields>(key: K, value: InvoiceFields[K], line: OcrLine, rule: string) => {
    if (fields[key] !== undefined) return
    fields[key] = value
    evidence[key] = { lineId: line.id, rule, confidence: line.confidence,
      region: line.bbox ? { page: line.page ?? 1, bbox: line.bbox, imageWidth: line.imageWidth, imageHeight: line.imageHeight } : undefined }
  }

  const fullText = lines.map((line) => line.text).join('\n')
  const railway = /铁路电子客票/.test(fullText.replace(/\s/g, ''))
  const aviation = /航空运输电子客票行程单|航空运输电子客票|航空电子行程单/.test(fullText.replace(/\s/g, ''))
  if (railway) fields.invoiceType = '电子发票（铁路电子客票）'
  else if (aviation) fields.invoiceType = /电子发票/.test(fullText) ? '电子发票（航空运输电子客票行程单）' : '航空运输电子客票行程单'
  else if (/增值税专用发票/.test(fullText)) fields.invoiceType = '增值税专用发票'
  else if (/增值税普通发票/.test(fullText)) fields.invoiceType = '增值税普通发票'
  else if (/电子发[票统]/.test(fullText) && /普通发票/.test(fullText)) fields.invoiceType = '电子发票（普通发票）'
  else if (/电子发票/.test(fullText)) fields.invoiceType = '电子发票'

  // Travel documents use fare/total labels rather than the VAT invoice totals row.
  // Keep the printed gross amount; never infer a tax rate or use the journey date.
  if (railway || aviation) {
    const readLabel = (label: RegExp, value: RegExp): { text: string; line: OcrLine } | undefined => {
      for (const line of lines) {
        const match = label.exec(line.text)
        if (!match) continue
        const tail = line.text.slice(match.index + match[0].length).replace(/^\s*[:：]?\s*/, '')
        const inline = tail.match(value)?.[0]
        if (inline) return { text: inline, line }
        if (tail) continue
        const bounds = layout.get(line)
        const candidates = bounds ? lines.filter(candidate => candidate !== line && (candidate.page ?? 0) === (line.page ?? 0)
          && layout.has(candidate) && sameRow(bounds, layout.get(candidate)!) && layout.get(candidate)!.left > bounds.left)
          .sort((a, b) => layout.get(a)!.left - layout.get(b)!.left)
          : [lines[lines.indexOf(line) + 1]].filter(Boolean)
        const candidate = candidates[0]
        if (candidate && value.test(candidate.text)) return { text: candidate.text.match(value)![0], line: candidate }
      }
    }
    const gross = readLabel(railway ? /票\s*价/ : /价\s*税\s*合\s*计(?:\s*\(小写\))?|合\s*计(?:\s*TOTAL)?/i,
      /^[¥￥]?\s*(?:CNY\s*)?[+-]?\d[\d,]*(?:\.\d{1,2})?(?![\d.])/i)
    if (gross) {
      const amount = parseMoneyToCents(gross.text.replace(/CNY\s*/i, ''))
      if (amount !== null) set('totalAmount', amount, gross.line, railway ? 'railway-fare' : 'aviation-total')
    }
    if (aviation) {
      const ticket = readLabel(/电子客票号码|电子客票号|票号|客票号码|客票号/, /^\d{3}[- ]?\d{10}(?!\d)/)
      // Older itineraries have a 13-digit ticket number, newer e-invoices have a separate invoice number.
      if (ticket && !/发票号码/.test(fullText)) set('invoiceNumber', ticket.text.replace(/[- ]/g, ''), ticket.line, 'aviation-ticket-number')
      const issued = readLabel(/填开日期|出票日期/, /^\d{4}[年/-]\d{1,2}[月/-]\d{1,2}日?/)
      if (issued && !/开票日期/.test(fullText)) {
        const date = normalizeDate(issued.text)
        if (date) set('invoiceDate', date, issued.line, 'aviation-issue-date')
      }
      const seller = readLabel(/销售单位(?:名称)?/, /^[^:：\s]+/)
      if (seller) set('sellerName', seller.text, seller.line, 'aviation-sales-unit')
      const buyer = readLabel(/购买方名称|购票单位(?:名称)?/, /^[^:：\s]+/)
      if (buyer) set('buyerName', buyer.text, buyer.line, 'aviation-buyer')
    }
  }

  let party: 'buyer' | 'seller' | null = null
  const minX = (line: OcrLine) => layout.get(line)?.left
  // Find both column headers first: skew can put the right header before the left name.
  let buyerColumnX = lines.filter((line) => /购买方/.test(line.text) && !/销售方/.test(line.text)).map(minX).find((x) => x !== undefined)
  let sellerColumnX = lines.filter((line) => /销售方/.test(line.text) && !/购买方/.test(line.text)).map(minX).find((x) => x !== undefined)
  const parseParty = (line: OcrLine, segment: string, target: 'buyer' | 'seller') => {
    const name = segment.match(/名称\s*[:：]?\s*([^\s]+)/)?.[1]
      ?.split(/(?:统一社会信用代码|纳税人识别号|税号)/)[0]
    if (name) set(target === 'buyer' ? 'buyerName' : 'sellerName', name, line, `${target}-name-label`)
    const taxId = segment.match(/(?:统一社会信用代码|纳税人识别号|税号)\s*[:：]?\s*([0-9A-Z]{15,20})/i)?.[1]?.toUpperCase()
    if (taxId) set(target === 'buyer' ? 'buyerTaxId' : 'sellerTaxId', taxId, line, `${target}-tax-label`)
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const text = line.text
    const next = lines[index + 1]?.text ?? ''

    const code = text.match(/发票代码\s*[:：]?\s*(\d{8,12})/)?.[1]
      ?? (/发票代码\s*[:：]?\s*$/.test(text) ? next.match(/^\d{8,12}$/)?.[0] : undefined)
    if (code) set('invoiceCode', code, line, 'invoice-code-label')
    const number = text.match(/发票号码\s*[:：]?\s*(\d{8,20})/)?.[1]
      ?? (/发票号码\s*[:：]?\s*$/.test(text) ? next.match(/^\d{8,20}$/)?.[0] : undefined)
    if (number) set('invoiceNumber', number, line, 'invoice-number-label')
    const dateText = text.match(/开票日期\s*[:：]?\s*([0-9年月日/-]+)/)?.[1]
      ?? (/开票日期\s*[:：]?\s*$/.test(text) ? next.match(/^[0-9年月日/-]+/)?.[0] : undefined)
    const date = dateText ? normalizeDate(dateText) : null
    if (date) set('invoiceDate', date, line, 'invoice-date-label')

    const buyerPosition = text.indexOf('购买方')
    const sellerPosition = text.indexOf('销售方')
    if (buyerPosition >= 0) buyerColumnX ??= minX(line)
    if (sellerPosition >= 0) sellerColumnX ??= minX(line)
    if (buyerPosition >= 0 && sellerPosition >= 0) {
      const firstBuyer = buyerPosition < sellerPosition
      const buyerSegment = firstBuyer ? text.slice(buyerPosition, sellerPosition) : text.slice(buyerPosition)
      const sellerSegment = firstBuyer ? text.slice(sellerPosition) : text.slice(sellerPosition, buyerPosition)
      parseParty(line, buyerSegment, 'buyer')
      parseParty(line, sellerSegment, 'seller')
      party = null
    } else {
      if (buyerPosition >= 0) party = 'buyer'
      if (sellerPosition >= 0) party = 'seller'
      const isTaxLine = /(?:统一社会信用代码|纳税人识别号|税号)/.test(text)
      const isNameLine = /名称\s*[:：]/.test(text)
      if (buyerPosition < 0 && sellerPosition < 0 && (isTaxLine || isNameLine)) {
        const lineX = minX(line)
        if (lineX !== undefined && buyerColumnX !== undefined && sellerColumnX !== undefined) {
          party = lineX < (buyerColumnX + sellerColumnX) / 2 ? 'buyer' : 'seller'
        } else if (isTaxLine && !fields.buyerTaxId) party = 'buyer'
        else if (isTaxLine && !fields.sellerTaxId) party = 'seller'
        else if (isNameLine && !fields.buyerName) party = 'buyer'
        else if (isNameLine && !fields.sellerName) party = 'seller'
      }
      if (party) parseParty(line, text, party)
    }

    if (/小写/.test(text)) {
      const amounts = amountsIn(text)
      if (amounts.length) set('totalAmount', amounts[amounts.length - 1], line, 'total-lowercase-label')
    }
    const tax = text.match(/(?:^|\s)税额\s*[:：]?\s*[¥￥]?\s*(\d[\d,]*\.\d{1,2})/)?.[1]
    const taxAmount = tax ? parseMoneyToCents(tax) : null
    if (taxAmount !== null) set('taxAmount', taxAmount, line, 'tax-label')
    const excludingTax = text.match(/不含税金额\s*[:：]?\s*[¥￥]?\s*(\d[\d,]*\.\d{1,2})/)?.[1]
    const amount = excludingTax ? parseMoneyToCents(excludingTax) : null
    if (amount !== null) set('amountExcludingTax', amount, line, 'amount-excluding-tax-label')
    const totalRow = /^合$/.test(text) && /^计$/.test(next)
      ? `${text}${next} ${lines[index + 2]?.text ?? ''} ${lines[index + 3]?.text ?? ''}`
      : text
    if (!railway && !aviation && /合\s*计/.test(totalRow) && !/价\s*税\s*合\s*计/.test(totalRow)) {
      const amounts = amountsIn(totalRow)
      if (amounts.length >= 2) {
        set('amountExcludingTax', amounts[amounts.length - 2], line, 'total-row-amounts')
        set('taxAmount', amounts[amounts.length - 1], line, 'total-row-amounts')
      }
    }
  }

  // Detectors may split a totals row into label, net amount and tax amount.
  // Pair only aligned currency cells; a partial label also needs arithmetic validation.
  if (!railway && !aviation && (fields.amountExcludingTax === undefined || fields.taxAmount === undefined)) {
    for (const label of lines.filter((line) => /^(合\s*计|合|计)$/.test(line.text))) {
      const bounds = layout.get(label)
      if (!bounds) continue
      const row = lines.filter((line) => line !== label && (line.page ?? 0) === (label.page ?? 0)
        && layout.has(line) && sameRow(bounds, layout.get(line)!))
        .sort((a, b) => minX(a)! - minX(b)!)
      const cells = row.filter((line) => /^[¥￥]\s*[+-]?\d[\d,]*\.\d{1,2}$/.test(line.text) && minX(line)! > bounds.left)
      if (cells.length !== 2) continue
      const net = amountsIn(cells[0].text)[0], tax = amountsIn(cells[1].text)[0]
      if (net === undefined || tax === undefined) continue
      const fullLabel = /合\s*计/.test(label.text) || row.some((line) => (label.text === '合' && line.text === '计') || (label.text === '计' && line.text === '合'))
      if (!fullLabel && (typeof fields.totalAmount !== 'number' || Math.abs(net + tax - fields.totalAmount) > 1)) continue
      set('amountExcludingTax', net, cells[0], 'aligned-total-row')
      set('taxAmount', tax, cells[1], 'aligned-total-row')
      break
    }
  }

  const netAmount = fields.amountExcludingTax
  const taxAmount = fields.taxAmount
  const totalAmount = fields.totalAmount
  if (totalAmount === undefined && typeof netAmount === 'number' && typeof taxAmount === 'number') {
    fields.totalAmount = netAmount + taxAmount
    const lineId = evidence.amountExcludingTax?.lineId
    evidence.totalAmount = { lineId, rule: 'amount-arithmetic' }
    warnings.push('价税合计由不含税金额与税额计算，请与原票核对')
  }
  if (typeof netAmount === 'number' && typeof taxAmount === 'number' && typeof totalAmount === 'number') {
    if (Math.abs(netAmount + taxAmount - totalAmount) > 1) {
      warnings.push('不含税金额加税额与价税合计不一致，请人工核对')
    }
  }
  for (const [key, label] of [['invoiceNumber', '发票号码'], ['invoiceDate', '开票日期'], ['totalAmount', '价税合计']] as const) {
    if (fields[key] === undefined) warnings.push(`未识别到${label}`)
  }
  return { normalizedText: fullText, fields, evidence, warnings }
}
