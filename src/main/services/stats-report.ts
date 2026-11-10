import ExcelJS from 'exceljs'
import type { Invoice, InvoiceStats, StatsFilter } from '@shared/contracts'
import { INVOICE_STATUS_LABELS, REVIEW_STATUS_LABELS } from '@shared/labels'

export function buildStatsWorkbook(stats: InvoiceStats, filter: StatsFilter, projectName: string, invoices: Invoice[]): ExcelJS.Workbook {
  const book = new ExcelJS.Workbook()
  function sheet(name: string, headers: string[], rows: Array<Array<string | number | null>>, moneyColumns: number[] = []): void {
    const target = book.addWorksheet(name)
    target.columns = headers.map((header, index) => ({ header, width: index === 0 ? 26 : 21 }))
    for (const values of rows) target.addRow(values)
    target.views = [{ state: 'frozen', ySplit: 1 }]
    target.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: headers.length } }
    target.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } }
    target.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF425A72' } }
    target.getRow(1).height = 24
    for (const column of moneyColumns) target.getColumn(column).numFmt = '#,##0.00'
  }
  sheet('统计口径', ['项目', '内容'], [
    ['生成时间', new Date().toLocaleString('zh-CN')],
    ['项目范围', projectName], ['开票日期从', filter.dateFrom || '不限'], ['开票日期至', filter.dateTo || '不限'],
    ['核对口径', filter.reviewScope === 'all' ? '全部发票，含待核对' : '仅已确认'],
    ['发票状态', filter.status ? INVOICE_STATUS_LABELS[filter.status] : filter.statuses?.map(status => INVOICE_STATUS_LABELS[status]).join('、') || '全部（含作废）'],
    ['金额口径', '金额单位为元；缺失金额不按零元认定，合计仅含已填写金额。'],
    ['月度口径', '月度明细列出有票月份；未填日期的发票不进入月度分组。'],
    ['票据数量', stats.invoiceCount], ['已确认数量', stats.confirmedCount],
    ['未填日期数量', stats.missing.invoiceDate], ['未填合计数量', stats.missing.totalAmount],
    ['未填不含税金额数量', stats.missing.amountExcludingTax], ['未填税额数量', stats.missing.taxAmount],
  ])
  const amount = (field: 'totalAmount' | 'amountExcludingTax' | 'taxAmount') => stats.invoiceCount > 0 && stats.missing[field] === stats.invoiceCount ? null : stats[field] / 100
  sheet('金额汇总', ['发票张数', '价税合计', '不含税金额', '税额', '平均票额（按已填合计）'], [[stats.invoiceCount, amount('totalAmount'), amount('amountExcludingTax'), amount('taxAmount'), stats.invoiceCount > stats.missing.totalAmount ? stats.averageAmount / 100 : null]], [2, 3, 4, 5])
  sheet('月度明细', ['月份', '张数', '价税合计', '税额'], stats.monthly.map(row => [row.month, row.invoiceCount, row.totalAmount / 100, row.taxAmount / 100]), [3, 4])
  sheet('项目对比', ['项目', '张数', '价税合计'], stats.byProject.map(row => [row.name, row.invoiceCount, row.totalAmount / 100]), [3])
  sheet('状态分布', ['发票状态', '张数', '价税合计'], stats.byStatus.map(row => [INVOICE_STATUS_LABELS[row.status], row.invoiceCount, row.totalAmount / 100]), [3])
  sheet('发票类型', ['类型', '张数', '价税合计'], stats.byType.map(row => [row.invoiceType, row.invoiceCount, row.totalAmount / 100]), [3])
  sheet('销售方排行', ['销售方', '张数', '价税合计'], stats.bySeller.map(row => [row.name || '未填销售方', row.invoiceCount, row.totalAmount / 100]), [3])
  sheet('发票明细', ['发票号码', '开票日期', '项目', '销售方', '购买方', '不含税金额', '税额', '价税合计', '核对状态', '发票状态', '原文件名'], invoices.map(invoice => [invoice.invoiceNumber, invoice.invoiceDate, invoice.projects.map(project => project.name).join('、') || '未分配', invoice.sellerName, invoice.buyerName, invoice.amountExcludingTax === null ? null : invoice.amountExcludingTax / 100, invoice.taxAmount === null ? null : invoice.taxAmount / 100, invoice.totalAmount === null ? null : invoice.totalAmount / 100, REVIEW_STATUS_LABELS[invoice.reviewStatus], INVOICE_STATUS_LABELS[invoice.status], invoice.fileName]), [6, 7, 8])
  return book
}
