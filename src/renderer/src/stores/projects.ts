import { ref } from 'vue'
import { defineStore } from 'pinia'
import { api } from '@/api'
import type { InvoiceProject } from '@shared/contracts'

export const useProjectStore = defineStore('projects', () => {
  const items = ref<InvoiceProject[]>([])
  const unassignedCount = ref(0)
  let request = 0
  async function fetch(): Promise<void> {
    const version = ++request
    const [projects, unassigned] = await Promise.all([api.listProjects(), api.listInvoices({ page: 1, pageSize: 1, projectId: null })])
    if (version === request) { items.value = projects; unassignedCount.value = unassigned.total }
  }
  return { items, unassignedCount, fetch }
})
