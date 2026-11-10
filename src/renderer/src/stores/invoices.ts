import { onScopeDispose } from 'vue'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Invoice, InvoiceQuery, OcrProgress } from '@shared/contracts'
import { api } from '@/api'

export const useInvoiceStore = defineStore('invoices', () => {
  const items = ref<Invoice[]>([])
  const total = ref(0)
  const loading = ref(false)
  const query = ref<InvoiceQuery>({ page: 1, pageSize: 20 })

  let requestVersion = 0
  let progressTimer: ReturnType<typeof setTimeout> | undefined
  async function fetchList(): Promise<void> {
    const version = ++requestVersion
    loading.value = true
    try {
      let result = await api.listInvoices({ ...query.value })
      if (version !== requestVersion) return
      const lastPage = Math.max(1, Math.ceil(result.total / query.value.pageSize))
      if (query.value.page > lastPage) {
        query.value = { ...query.value, page: lastPage }
        result = await api.listInvoices({ ...query.value })
        if (version !== requestVersion) return
      }
      items.value = result.items
      total.value = result.total
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }

  function updateQuery(patch: Partial<InvoiceQuery>): Promise<void> {
    query.value = { ...query.value, ...patch }
    return fetchList()
  }

  function applyProgress(progress: OcrProgress): void {
    // Invalidate in-flight snapshots; a bounded refresh keeps fields, counts and filters aligned.
    requestVersion++
    if (!progressTimer) progressTimer = setTimeout(() => {
      progressTimer = undefined
      void fetchList().catch((error) => console.error('识别结果刷新失败', error))
    }, 250)
    const item = items.value.find((invoice) => invoice.id === progress.invoiceId)
    if (item) {
      item.ocrStatus = progress.status
      item.ocrError = progress.error ?? null
      item.ocrAttempts = progress.attempt
    }
  }

  onScopeDispose(() => { if (progressTimer) clearTimeout(progressTimer) })

  return { items, total, loading, query, fetchList, updateQuery, applyProgress }
})
