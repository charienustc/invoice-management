import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { InvoiceDatabase } from '../../src/main/db/database'
import { ImportService } from '../../src/main/services/import-service'
import { buildExportRows } from '../../src/main/services/export-service'
import { setInvoiceProjectsSchema } from '@shared/contracts'

let directory: string
let db: InvoiceDatabase
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'invoice-project-')); db = new InvoiceDatabase(directory) })
afterEach(async () => { db.close(); await rm(directory, { recursive: true, force: true }) })
const createInvoice = (suffix: string) => db.create({ fileName: `${suffix}.png`, storagePath: suffix, mimeType: 'image/png', fileSize: 1, sha256: suffix.repeat(64) })

it('创建、重命名项目，规范空白并拒绝同名或空项目名称', () => {
  const project = db.createProject({ name: '  项目A  ', description: '采购' })
  expect(project).toMatchObject({ name: '项目A', invoiceCount: 0, confirmedAmount: 0 })
  expect(() => db.createProject({ name: '项目a', description: '' })).toThrow('同名')
  expect(() => db.createProject({ name: '  ', description: '' })).toThrow('名称')
  const other = db.createProject({ name: '项目B', description: '' })
  expect(() => db.updateProject({ ...other, name: '项目A' })).toThrow('同名')
  expect(db.updateProject({ ...project, name: '新名称' }).name).toBe('新名称')
})

it('每张发票只属于一个项目，可移动和移出，原文件不重复建档', () => {
  const a = createInvoice('a'), b = createInvoice('b')
  const first = db.createProject({ name: '项目一', description: '' }), second = db.createProject({ name: '项目二', description: '' })
  expect(db.setInvoiceProjects([a.id, b.id], [first.id])).toBe(2)
  expect(db.setInvoiceProjects([a.id], [first.id])).toBe(0)
  expect(db.setInvoiceProjects([a.id], [second.id])).toBe(1)
  expect(db.get(a.id)?.projects).toEqual([{ id: second.id, name: '项目二' }])
  expect(db.listProjects().map((project) => project.invoiceCount)).toEqual([1, 1])
  expect(db.list({ page: 1, pageSize: 20, projectId: first.id }).items.map((item) => item.id)).toEqual([b.id])
  expect(() => db.setInvoiceProjects([a.id], [first.id, second.id])).toThrow('只能关联一个')
  expect(() => setInvoiceProjectsSchema.parse({ ids: [a.id], projectIds: [first.id, second.id] })).toThrow()
  db.setInvoiceProjects([a.id], [])
  expect(db.list({ page: 1, pageSize: 20, projectId: null }).items.map((item) => item.id)).toEqual([a.id])
  expect(db.list({ page: 1, pageSize: 20 }).total).toBe(2)
})

it('批量关联事务：无效或回收站记录不造成部分移动', () => {
  const a = createInvoice('c'), b = createInvoice('d')
  const project = db.createProject({ name: '项目', description: '' })
  db.softDelete([b.id])
  expect(() => db.setInvoiceProjects([a.id, b.id], [project.id])).toThrow('回收站')
  expect(db.get(a.id)?.projects).toEqual([])
  expect(() => db.setInvoiceProjects([a.id], ['missing'])).toThrow('项目不存在')
})

it('项目统计、筛选与导出一致，回收站保留关联但不计入汇总', () => {
  const a = createInvoice('e'), b = createInvoice('f')
  const project = db.createProject({ name: '设备采购', description: '' })
  db.updateFields(a.id, { ...a, invoiceNumber: '12345678', invoiceDate: '2026-11-05', totalAmount: 10600, taxAmount: 600 }, true)
  db.setInvoiceProjects([a.id, b.id], [project.id])
  db.setInvoiceTags(a.id, ['办公'])
  expect(db.listProjects()[0]).toMatchObject({ invoiceCount: 2, confirmedCount: 1, confirmedAmount: 10600 })
  expect(db.getStats({ projectId: project.id, tag: '办公' })).toMatchObject({ invoiceCount: 1, totalAmount: 10600 })
  expect(buildExportRows(db.listForExport({ projectId: project.id, reviewStatus: 'confirmed' }), ['invoiceNumber', 'projectNames'])).toEqual([['12345678', '设备采购']])
  expect(db.getStats({ projectId: null }).invoiceCount).toBe(0)
  db.softDelete([a.id])
  expect(db.listProjects()[0]).toMatchObject({ invoiceCount: 1, confirmedCount: 0, confirmedAmount: 0 })
  expect(db.listForExport({ projectId: project.id, deleted: true })).toHaveLength(1)
  db.restore([a.id])
  expect(db.get(a.id)?.projects[0].id).toBe(project.id)
  expect(db.listProjects()[0].invoiceCount).toBe(2)
})

it('删除项目只解除关联，发票及原件仍然存在', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const source = join(directory, 'source.png')
  await writeFile(source, png)
  const invoice = (await new ImportService(db, directory, vi.fn()).import([source])).imported[0]
  const project = db.createProject({ name: '项目', description: '' })
  db.setInvoiceProjects([invoice.id], [project.id])
  db.deleteProject(project.id)
  expect(db.get(invoice.id)?.projects).toEqual([])
  expect(db.list({ page: 1, pageSize: 20, projectId: null }).total).toBe(1)
  expect(await readFile(join(directory, db.getStoragePath(invoice.id)!))).toEqual(png)
})
