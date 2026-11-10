import type { InvoiceDatabase } from '../../src/main/db/database'

// Synthetic data only. Shared by protocol tests and docs/mcp-evaluation.xml.
export function seedMcpFixture(db: InvoiceDatabase) {
  const equipment = db.createProject({ name: '设备采购', description: '实验室电脑与配件' })
  const travel = db.createProject({ name: '会议出差', description: '学术交流' })
  const rows = [
    ['设备一', '10000001', '2026-11-01', 10600, 600, true, equipment.id, '办公', 'booked'],
    ['设备二', '10000002', '2026-11-03', 21200, 1200, true, equipment.id, '设备', 'unprocessed'],
    ['交通一', '10000003', '2026-10-20', 5000, 0, true, travel.id, '差旅', 'reimbursed'],
    ['待核对', '10000004', '2026-11-04', 80000, 0, false, null, '待核对', 'unprocessed'],
    ['已删除', '10000005', '2026-11-02', 99900, 0, true, equipment.id, '设备', 'booked'],
    ['交通二', '10000006', '2026-11-05', 3000, 0, true, null, '差旅', 'booked'],
  ] as const
  const invoices = rows.map(([name, number, date, total, tax, confirmed, project, tag, status], index) => {
    const invoice = db.create({ fileName: `${name}.png`, storagePath: `fixture/${index}`, mimeType: 'image/png', fileSize: 100, sha256: String(index).repeat(64) })
    db.updateFields(invoice.id, { ...invoice, invoiceType: name.startsWith('设备') ? '增值税专用发票' : '电子普通发票', invoiceNumber: number, invoiceDate: date, totalAmount: total, taxAmount: tax, amountExcludingTax: total - tax, sellerName: name.startsWith('设备') ? '科仪商贸' : '城市交通', buyerName: '测试研究所' }, confirmed)
    if (project) db.setInvoiceProjects([invoice.id], [project])
    db.setInvoiceTags(invoice.id, [tag])
    db.batchSetStatus([invoice.id], status)
    if (name === '已删除') db.softDelete([invoice.id])
    return db.get(invoice.id)!
  })
  return { invoices, equipment, travel }
}
