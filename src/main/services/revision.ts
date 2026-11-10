import { createHash } from 'node:crypto'
import { invoiceFieldsSchema, type InvoiceFields } from '@shared/contracts'
export function dataRevision(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
export function fieldRevision(value: InvoiceFields | null): string { return dataRevision(value && Object.fromEntries((Object.keys(invoiceFieldsSchema.shape) as Array<keyof InvoiceFields>).map((key) => [key, value[key]]))) }
