import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { InvoiceStatus } from '@shared/contracts'

export const useStatisticsViewStore = defineStore('statistics-view', () => ({
  projectId: ref('all'), dates: ref<string[]>([]),
  reviewScope: ref<'confirmed' | 'all'>('confirmed'),
  statusScope: ref<'valid' | 'all' | InvoiceStatus>('valid'),
}))
