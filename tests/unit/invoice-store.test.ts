import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { InvoiceListResult } from '@shared/contracts'
const { listInvoices } = vi.hoisted(() => ({ listInvoices: vi.fn() }))
vi.mock('@/api', () => ({ api: { listInvoices } }))
import { useInvoiceStore } from '../../src/renderer/src/stores/invoices'

beforeEach(() => { setActivePinia(createPinia()); listInvoices.mockReset() })
afterEach(() => vi.useRealTimers())
const result = (total: number): InvoiceListResult => ({ items: [], total, page: 1, pageSize: 20 })

it('晚返回的旧查询不能覆盖新筛选结果', async () => {
  let resolveOld!: (result: InvoiceListResult) => void
  listInvoices.mockImplementationOnce(() => new Promise<InvoiceListResult>((resolve) => { resolveOld = resolve })).mockResolvedValueOnce(result(2))
  const store = useInvoiceStore()
  const oldRequest = store.fetchList()
  await store.updateQuery({ keyword: '新筛选' })
  resolveOld(result(10))
  await oldRequest
  expect(store.total).toBe(2)
  expect(store.query.keyword).toBe('新筛选')
  expect(store.loading).toBe(false)
})

it('OCR 事件合并刷新当前筛选，并在删除后自动回退空页', async () => {
  vi.useFakeTimers()
  listInvoices.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(result(1))
  const store = useInvoiceStore()
  store.query = { page: 2, pageSize: 20, ocrStatus: 'failed' }
  store.applyProgress({ invoiceId: 'a', status: 'succeeded', attempt: 1 })
  store.applyProgress({ invoiceId: 'b', status: 'succeeded', attempt: 1 })
  await vi.advanceTimersByTimeAsync(250)
  expect(listInvoices).toHaveBeenCalledTimes(2)
  expect(listInvoices).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, ocrStatus: 'failed' })
  expect(store.query.page).toBe(1)
})
