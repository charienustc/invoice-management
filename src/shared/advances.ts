import { z } from 'zod'
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}, '请输入有效日期')
const money = z.number().int().positive().max(1_000_000_000_000)
export const advanceFieldsSchema = z.object({ title: z.string().trim().min(1, '请输入事项').max(200), amount: money,
  date: day, projectId: z.string().uuid().nullable(), payee: z.string().trim().max(200), remark: z.string().max(2000), invoiceId: z.string().uuid().nullable() })
export const advanceSaveSchema = advanceFieldsSchema.extend({ id: z.string().uuid().optional(), revision: z.number().int().positive().optional() })
export const advanceFilterSchema = z.object({ keyword: z.string().max(200).optional(), projectId: z.string().uuid().nullable().optional(),
  dateFrom: day.optional(), dateTo: day.optional(), status: z.enum(['unpaid', 'partial', 'paid']).optional(),
  billing: z.enum(['unbilled', 'linked']).optional(), deleted: z.boolean().optional() }).refine(value => !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo, '结束日期不能早于开始日期')
export type AdvanceFields = z.infer<typeof advanceFieldsSchema>
export type AdvanceSave = z.infer<typeof advanceSaveSchema>
export type AdvanceFilter = z.infer<typeof advanceFilterSchema>
export interface AdvanceReturn { id: string; date: string; amount: number; remark: string }
export interface AdvanceAttachment { id: string; name: string; size: number }
export interface Advance extends AdvanceFields {
  id: string; revision: number; projectName: string; invoiceNumber: string; linked: boolean; deleted: boolean;
  recovered: number; remaining: number; returns: AdvanceReturn[]; attachments: AdvanceAttachment[]
}
export interface AdvanceResult { items: Advance[]; total: number; amount: number; recovered: number; remaining: number; unbilledAmount: number }
export const advanceMutationSchema = z.object({ id: z.string().uuid(), revision: z.number().int().positive() })
export const advanceReturnSchema = advanceMutationSchema.extend({ date: day, amount: money, remark: z.string().max(1000) })
export interface AdvanceApi {
  listAdvances: (filter: AdvanceFilter) => Promise<AdvanceResult>
  saveAdvance: (input: AdvanceSave) => Promise<Advance>
  setAdvanceDeleted: (input: { id: string; revision: number; deleted: boolean }) => Promise<void>
  addAdvanceReturn: (input: z.infer<typeof advanceReturnSchema>) => Promise<Advance>
  removeAdvanceReturn: (input: { id: string; revision: number; returnId: string }) => Promise<Advance>
  addAdvanceAttachments: (input: { id: string; revision: number }) => Promise<Advance>
  openAdvanceAttachment: (input: { id: string; attachmentId: string }) => Promise<void>
  removeAdvanceAttachment: (input: { id: string; revision: number; attachmentId: string }) => Promise<Advance>
  exportAdvances: (filter: AdvanceFilter) => Promise<{ canceled: boolean; filePath?: string; count: number }>
}
