import { beforeEach, afterEach, describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DataLocationService } from '../../src/main/services/data-location-service'
import { InvoiceDatabase } from '../../src/main/db/database'
import { AdvanceService } from '../../src/main/services/advance-service'
import { ImportService } from '../../src/main/services/import-service'
import { BackupService } from '../../src/main/services/backup-service'
let root: string, config: string, defaults: string, application: string, db: InvoiceDatabase | undefined
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const expense = { title: '迁移验证垫付', amount: 12345, date: '2026-11-01', projectId: null, invoiceId: null, payee: '测试商户', remark: '' }
const service = () => new DataLocationService(config, defaults, application)
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'data-location-test-')); config = join(root, 'Roaming', 'invoice-management'); defaults = join(root, 'Local', 'invoice-management', 'Data'); application = join(root, 'Program'); await mkdir(config, { recursive: true }); await mkdir(application) })
afterEach(async () => { db?.close(); db = undefined; await rm(root, { recursive: true, force: true }) })
describe('数据目录管理', () => {
  it('新安装使用默认业务目录，指针和偏好仍留在配置目录', async () => {
    const storage = service()
    expect(await storage.initialize()).toBe(defaults)
    db = new InvoiceDatabase(storage.directory)
    await storage.persist()
    expect(JSON.parse(await readFile(join(config, 'storage-location.json'), 'utf8')).directory).toBe(defaults)
    expect(await service().initialize()).toBe(defaults)
    await writeFile(join(config, 'preferences.json'), '{"colorMode":"dark"}')
    await expect(stat(join(defaults, 'preferences.json'))).rejects.toThrow()
  })
  it('识别旧版数据，不擅自迁移；配置损坏、磁盘丢失和数据库缺失不创建空库', async () => {
    db = new InvoiceDatabase(config)
    const storage = service()
    expect(await storage.initialize()).toBe(config)
    await storage.persist()
    db.close(); db = undefined
    await rm(join(config, 'invoice.db'))
    await expect(service().initialize()).rejects.toThrow('未创建新的空数据库')
    await expect(stat(defaults)).rejects.toThrow()
    await writeFile(join(config, 'storage-location.json'), '{broken')
    await expect(service().initialize()).rejects.toThrow('配置无法读取')
  })
  it('迁移所有数据库记录和原件/垫付凭证，保留原数据和设置，重启从新位置加载', async () => {
    db = new InvoiceDatabase(config)
    const storage = service(); await storage.initialize(); await storage.persist()
    const source = join(root, '凭证.png'); await writeFile(source, png)
    const invoices = await new ImportService(db, config, () => {}).import([source])
    db.setInvoiceTags(invoices.imported[0].id, ['标签'])
    const advances = new AdvanceService(db, config)
    let record = advances.save(expense)
    record = advances.addReturn({ id: record.id, revision: record.revision, date: '2026-11-02', amount: 2345, remark: '部分收回' })
    record = await advances.addAttachments(record.id, record.revision, [source])
    await writeFile(join(config, 'preferences.json'), '{"colorMode":"dark"}')
    const target = join(root, 'CustomData'); await mkdir(target)
    expect(await storage.migrate(target, new BackupService(db, config))).toBe(await import('node:fs/promises').then(fs => fs.realpath(target)))
    expect(storage.directory).toBe(config) // Running process stays on old DB until restart.
    expect(await readFile(join(config, 'preferences.json'), 'utf8')).toContain('dark')
    expect(await readFile(join(config, db.getStoragePath(invoices.imported[0].id)!))).toEqual(png)
    db.close(); db = undefined
    const restarted = service(); expect(await restarted.initialize()).toBe(target)
    db = new InvoiceDatabase(restarted.directory)
    expect(db.get(invoices.imported[0].id)?.tags).toEqual(['标签'])
    const moved = new AdvanceService(db, target).get(record.id)
    expect(moved).toMatchObject({ amount: 12345, recovered: 2345, remaining: 10000 })
    expect(await readFile(new AdvanceService(db, target).attachmentPath(record.id, moved.attachments[0].id))).toEqual(png)
    await expect(stat(join(target, 'preferences.json'))).rejects.toThrow()
  })
  it('恢复默认目录保留其中旧副本，使用自定义位置的最新数据', async () => {
    let storage = service(); await storage.initialize(); db = new InvoiceDatabase(storage.directory); await storage.persist()
    new AdvanceService(db, defaults).save(expense)
    const custom = join(root, 'CustomData')
    await storage.migrate(custom, new BackupService(db, defaults))
    db.close(); db = undefined
    storage = service(); await storage.initialize(); db = new InvoiceDatabase(storage.directory)
    new AdvanceService(db, custom).save({ ...expense, title: '自定义目录新增' })
    await expect(storage.destination(defaults)).rejects.toThrow('空文件夹')
    await storage.migrate(defaults, new BackupService(db, custom), true)
    db.close(); db = undefined
    const restarted = service(); expect(await restarted.initialize()).toBe(defaults)
    db = new InvoiceDatabase(defaults)
    expect(new AdvanceService(db, defaults).list({}).total).toBe(2)
    expect((await readdir(join(root, 'Local', 'invoice-management'))).some(name => name.startsWith('Data.previous-'))).toBe(true)
    expect(await stat(join(custom, 'invoice.db'))).toBeTruthy()
  })
  it('拒绝非空目录、嵌套目录和安装目录，校验失败时不切换指针', async () => {
    const storage = service(); await storage.initialize(); db = new InvoiceDatabase(storage.directory); await storage.persist()
    const nonempty = join(root, 'Existing'); await mkdir(nonempty); await writeFile(join(nonempty, 'keep.txt'), 'keep')
    await expect(storage.destination(nonempty)).rejects.toThrow('空文件夹')
    await expect(storage.destination(join(defaults, 'child'))).rejects.toThrow('不能选择')
    await expect(storage.destination(resolve(defaults, '..'))).rejects.toThrow('不能选择')
    await expect(storage.destination(join(application, 'child'))).rejects.toThrow('程序安装目录')
    const target = join(root, 'Target')
    db.create({ fileName: 'missing.png', mimeType: 'image/png', storagePath: 'invoice-files/missing.png', fileSize: 100, sha256: 'a'.repeat(64) })
    await expect(storage.migrate(target, new BackupService(db, defaults))).rejects.toThrow()
    expect(await service().initialize()).toBe(defaults)
    expect(await readdir(target)).toHaveLength(0)
    expect(await readFile(join(nonempty, 'keep.txt'), 'utf8')).toBe('keep')
  })
})
