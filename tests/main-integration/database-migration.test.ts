import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { InvoiceDatabase } from '../../src/main/db/database'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'invoice-migrate-test-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('v1 数据库迁移', () => {
  it('拒绝未来版本数据库且不降级版本标记', () => {
    const path = join(directory, 'invoice.db')
    const future = new Database(path); future.pragma('user_version = 999'); future.exec('CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES (\'keep\')'); future.close()
    expect(() => new InvoiceDatabase(directory)).toThrow('更高版本')
    const untouched = new Database(path, { readonly: true })
    try { expect(untouched.pragma('user_version', { simple: true })).toBe(999); expect(untouched.prepare('SELECT value FROM future_data').get()).toEqual({ value: 'keep' }) } finally { untouched.close() }
  })
  it('旧版无 status/deleted_at 的库可打开并补齐结构', () => {
    const legacy = new Database(join(directory, 'invoice.db'))
    legacy.exec(`
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        invoice_type TEXT NOT NULL DEFAULT '',
        invoice_code TEXT NOT NULL DEFAULT '',
        invoice_number TEXT NOT NULL DEFAULT '',
        invoice_date TEXT NOT NULL DEFAULT '',
        buyer_name TEXT NOT NULL DEFAULT '',
        buyer_tax_id TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        seller_tax_id TEXT NOT NULL DEFAULT '',
        amount_excluding_tax INTEGER,
        tax_amount INTEGER,
        total_amount INTEGER,
        remark TEXT NOT NULL DEFAULT '',
        ocr_status TEXT NOT NULL DEFAULT 'pending' CHECK (ocr_status IN ('pending', 'queued', 'running', 'succeeded', 'failed')),
        review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'needs_review', 'confirmed')),
        ocr_error TEXT,
        ocr_attempts INTEGER NOT NULL DEFAULT 0,
        manual_fields TEXT NOT NULL DEFAULT '[]',
        business_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE ocr_results (
        id TEXT PRIMARY KEY,
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        raw_response TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        parsed_fields TEXT NOT NULL,
        evidence TEXT NOT NULL,
        warnings TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_invoices_number ON invoices(invoice_number);
    `)
    legacy.prepare(`INSERT INTO invoices (id, file_name, storage_path, mime_type, file_size, sha256, created_at, updated_at)
      VALUES ('i1', 'old.png', 'f/old.png', 'image/png', 10, 'hash1', '2026-01-01', '2026-01-01')`).run()
    legacy.close()

    const db = new InvoiceDatabase(directory)
    const invoice = db.get('i1')!
    expect(invoice.status).toBe('unprocessed')
    expect(invoice.deletedAt).toBeNull()
    expect(invoice.tags).toEqual([])
    expect(db.list({ page: 1, pageSize: 20 }).total).toBe(1)
    expect(db.getTags()).toEqual([])
    db.close()
    const migrated = new Database(join(directory, 'invoice.db'), { readonly: true })
    expect(migrated.pragma('user_version', { simple: true })).toBe(5)
    migrated.close()
  })

  it('已迁移到一半的库（有新表无新列）可继续迁移', () => {
    const legacy = new Database(join(directory, 'invoice.db'))
    legacy.exec(`
      CREATE TABLE invoices (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL UNIQUE,
        invoice_type TEXT NOT NULL DEFAULT '',
        invoice_code TEXT NOT NULL DEFAULT '',
        invoice_number TEXT NOT NULL DEFAULT '',
        invoice_date TEXT NOT NULL DEFAULT '',
        buyer_name TEXT NOT NULL DEFAULT '',
        buyer_tax_id TEXT NOT NULL DEFAULT '',
        seller_name TEXT NOT NULL DEFAULT '',
        seller_tax_id TEXT NOT NULL DEFAULT '',
        amount_excluding_tax INTEGER,
        tax_amount INTEGER,
        total_amount INTEGER,
        remark TEXT NOT NULL DEFAULT '',
        ocr_status TEXT NOT NULL DEFAULT 'pending',
        review_status TEXT NOT NULL DEFAULT 'unreviewed',
        ocr_error TEXT,
        ocr_attempts INTEGER NOT NULL DEFAULT 0,
        manual_fields TEXT NOT NULL DEFAULT '[]',
        business_key TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
      CREATE TABLE invoice_tags (
        invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (invoice_id, tag_id)
      );
      CREATE INDEX idx_invoices_number ON invoices(invoice_number);
      CREATE INDEX idx_invoices_sort ON invoices(created_at DESC);
    `)
    legacy.close()

    const db = new InvoiceDatabase(directory)
    expect(db.getTags()).toEqual([])
    expect(db.list({ page: 1, pageSize: 20 }).total).toBe(0)
    db.close()
  })
})
