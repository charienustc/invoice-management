/// <reference types="vite/client" />

import type { InvoiceApi } from '@shared/contracts'

declare global {
  interface Window {
    invoiceApi: InvoiceApi
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}
