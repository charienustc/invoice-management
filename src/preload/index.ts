import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResponse, InvoiceApi, OcrProgress } from '@shared/contracts'

async function invoke<T>(channel: string, input?: unknown): Promise<T> {
  const response = await ipcRenderer.invoke(channel, input) as IpcResponse<T>
  if (!response.ok) {
    const error = new Error(response.error.message)
    error.name = response.error.code
    throw error
  }
  return response.data
}

const api: InvoiceApi = {
  listAdvances: filter => invoke('advances:list', filter),
  saveAdvance: input => invoke('advances:save', input),
  setAdvanceDeleted: input => invoke('advances:delete', input),
  addAdvanceReturn: input => invoke('advances:return-add', input),
  removeAdvanceReturn: input => invoke('advances:return-remove', input),
  addAdvanceAttachments: input => invoke('advances:attachments-add', input),
  openAdvanceAttachment: input => invoke('advances:attachment-open', input),
  removeAdvanceAttachment: input => invoke('advances:attachment-remove', input),
  exportAdvances: filter => invoke('advances:export', filter),
  getMcpStatus: () => invoke('mcp:status'),
  saveMcpSettings: (settings) => invoke('mcp:settings-save', settings),
  rotateMcpToken: () => invoke('mcp:rotate-token'),
  getMcpConnection: () => invoke('mcp:connection'),
  copyMcpConnection: (format) => invoke('mcp:copy-connection', format),
  onDataChanged: (callback) => { const listener = () => callback(); ipcRenderer.on('data:changed', listener); return () => ipcRenderer.removeListener('data:changed', listener) },
  listProjects: () => invoke('projects:list'),
  createProject: (input) => invoke('projects:create', input),
  updateProject: (input) => invoke('projects:update', input),
  deleteProject: (id) => invoke('projects:delete', id),
  setInvoiceProjects: (ids, projectIds) => invoke('invoices:projects-set', { ids, projectIds }),
  importFiles: (projectId) => invoke('files:import', projectId),
  getAppSettings: () => invoke('preferences:get'),
  saveAppSettings: (settings) => invoke('preferences:save', settings),
  getApplicationInfo: () => invoke('application:info'),
  openDataDirectory: () => invoke('application:open-data'),
  changeDataDirectory: mode => invoke('data:change-location', mode),
  selectOcrPath: (kind) => invoke('settings:select-path', kind),
  getInvoiceFileData: (id) => invoke('files:get-data', id),
  listInvoices: (query) => invoke('invoices:list', query),
  getInvoice: (id) => invoke('invoices:get', id),
  saveInvoice: (input) => invoke('invoices:save', input),
  applyOcrResult: (invoiceId, resultId) => invoke('invoices:apply-ocr', { invoiceId, resultId }),
  retryOcr: (id) => invoke('invoices:retry-ocr', id),
  getSettings: () => invoke('settings:get'),
  saveSettings: (settings) => invoke('settings:save', settings),
  testOcrConnection: (settings) => invoke('settings:test-ocr', settings),
  getOcrServiceStatus: () => invoke('settings:service-status'),
  startOcrService: (settings) => invoke('settings:start-service', settings),
  getStats: (filter) => invoke('stats:get', filter),
  exportStats: (filter) => invoke('stats:export', filter),
  exportInvoices: (input) => invoke('invoices:export', input),
  exportInvoiceFiles: (input) => invoke('invoices:export-files', input),
  exportReimbursementBundle: (input) => invoke('invoices:export-bundle', input),
  deleteInvoices: (ids) => invoke('invoices:delete', ids),
  restoreInvoices: (ids) => invoke('invoices:restore', ids),
  purgeInvoices: (ids) => invoke('invoices:purge', ids),
  confirmInvoices: (ids) => invoke('invoices:confirm-batch', ids),
  retryOcrInvoices: (ids) => invoke('invoices:retry-batch', ids),
  setInvoicesStatus: (ids, status) => invoke('invoices:status-batch', { ids, status }),
  setInvoiceTags: (id, tags) => invoke('invoices:tags-set', { id, tags }),
  addInvoicesTags: (ids, tags) => invoke('invoices:tags-add', { ids, tags }),
  removeInvoicesTags: (ids, tags) => invoke('invoices:tags-remove', { ids, tags }),
  getTags: () => invoke('tags:list'),
  createBackup: () => invoke('data:backup'),
  restoreBackup: () => invoke('data:restore'),
  onOcrProgress: (callback: (progress: OcrProgress) => void) => {
    const listener = (_event: IpcRendererEvent, progress: OcrProgress) => callback(progress)
    ipcRenderer.on('ocr:progress', listener)
    return () => ipcRenderer.removeListener('ocr:progress', listener)
  },
}

if (process.argv.includes('--invoice-e2e=1')) {
  api.importPaths = (paths) => invoke('test:import-paths', paths)
}

contextBridge.exposeInMainWorld('invoiceApi', api)
