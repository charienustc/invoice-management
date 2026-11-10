<template>
  <div v-loading="loading" class="detail-page">
    <template v-if="detail">
      <div class="detail-toolbar">
        <div class="detail-heading"><el-button :icon="ArrowLeft" text @click="router.push({ path: '/invoices', query: route.query })">返回列表</el-button><span class="file-title" :title="detail.invoice.fileName">{{ detail.invoice.fileName }}</span></div>
        <div v-if="!detail.invoice.deletedAt" class="toolbar-actions">
          <el-button :icon="Refresh" :loading="recognizing" :disabled="saving" @click="retry">{{ recognizing ? '识别中' : '重新识别' }}</el-button>
          <el-button :loading="saving" title="保存校正（Ctrl+S）" @click="save(false)">保存校正</el-button>
          <el-button type="primary" :loading="saving" title="确认发票（Ctrl+Enter）" @click="save(true)">确认发票</el-button>
        </div>
        <div v-else class="toolbar-actions">
          <el-button type="success" @click="restoreInvoice">恢复</el-button>
          <el-button type="danger" @click="purgeInvoice">彻底删除</el-button>
        </div>
      </div>
      <div class="detail-metadata">
      <div class="status-line">
        <TextBadge :label="ocrStatusMeta[detail.invoice.ocrStatus].text" :tone="ocrStatusMeta[detail.invoice.ocrStatus].type" variant="status" />
        <TextBadge :label="reviewStatusMeta[detail.invoice.reviewStatus].text" :tone="reviewStatusMeta[detail.invoice.reviewStatus].type" variant="status" />
        <TextBadge v-if="detail.invoice.deletedAt" label="回收站" tone="warning" variant="status" />
        <span v-if="detail.invoice.ocrAttempts">已尝试 {{ detail.invoice.ocrAttempts }} 次</span>
        <span v-if="dirty" class="unsaved">有未保存修改</span>
      </div>
      <div class="meta-line">
        <span class="meta-label">项目</span>
        <el-select :model-value="detail.invoice.projects[0]?.id || ''" aria-label="所属项目" placeholder="未分配" filterable style="width: 180px" size="small" :disabled="!!detail.invoice.deletedAt || changingProject" @change="changeProject"><el-option label="未分配" value="" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select>
        <span class="meta-label">发票状态</span>
        <el-select :model-value="detail.invoice.status" size="small" style="width: 120px" :disabled="!!detail.invoice.deletedAt" @change="changeStatus">
          <el-option v-for="meta in invoiceStatusOptions" :key="meta.value" :label="meta.label" :value="meta.value" />
        </el-select>
        <span class="meta-label">标签</span>
        <el-select
          class="tag-editor"
          :model-value="detail.invoice.tags"
          multiple
          filterable
          allow-create
          default-first-option
          :reserve-keyword="false"
          size="small"
          placeholder="添加标签"
          style="width: 280px"
          :disabled="!!detail.invoice.deletedAt"
          @change="changeTags"
        >
          <template #label="{ label }"><span :title="String(label)">{{ label }}</span></template>
          <el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" />
        </el-select>
      </div>
      </div>
      <el-alert v-if="detail.invoice.ocrError" :title="detail.invoice.ocrError" type="error" :closable="false" show-icon class="detail-alert" />
      <el-alert v-if="externalUpdate" type="warning" :closable="false" class="detail-alert"><template #title>这张发票已在其他位置更新。<el-button link type="warning" @click="reloadExternal">重新载入</el-button></template></el-alert>
      <el-alert v-if="detail.duplicates.length" type="warning" :closable="false" show-icon class="detail-alert">
        <template #title>检测到 {{ detail.duplicates.length }} 张业务号码相同的发票，请确认是否重复。<el-button v-for="item in detail.duplicates" :key="item.id" link type="warning" @click="openDuplicate(item.id)">{{ item.fileName }}</el-button></template>
      </el-alert>
      <div class="detail-grid">
        <FilePreview :invoice-id="detail.invoice.id" :file-name="detail.invoice.fileName" :mime-type="detail.invoice.mimeType" :highlight="activeEvidence?.region" :highlight-label="activeField ? EXPORT_COLUMN_LABELS[activeField] : undefined" />
        <div class="panel edit-panel">
          <div class="editor-heading"><strong>发票信息</strong></div>
          <div class="editor-scroll"><InvoiceForm v-model="form" :disabled="saving || !!detail.invoice.deletedAt" :evidence="latestResult?.evidence ?? {}" @focus-field="activeField = $event" />
          <div v-if="!detail.invoice.deletedAt" class="editor-footer"><el-button text :icon="Delete" @click="removeInvoice">移入回收站</el-button></div>
          </div>
        </div>
      </div>

    </template>
    <el-empty v-else-if="!loading" description="发票不存在或加载失败"><el-button @click="router.push({ path: '/invoices', query: route.query })">返回列表</el-button></el-empty>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Refresh, Delete } from '@element-plus/icons-vue'
import { INVOICE_STATUSES, type InvoiceDetail, type InvoiceFields, type InvoiceStatus } from '@shared/contracts'
import { INVOICE_STATUS_LABELS } from '@shared/labels'
import { api } from '@/api'
import { useInvoiceStore } from '@/stores/invoices'
import { errorMessage, ocrStatusMeta, reviewStatusMeta } from '@/utils'
import { EXPORT_COLUMN_LABELS } from '@shared/contracts'
import FilePreview from '@/components/FilePreview.vue'
import { useProjectStore } from '@/stores/projects'
import InvoiceForm from '@/components/InvoiceForm.vue'
import TextBadge from '@/components/TextBadge.vue'

const route = useRoute()
const router = useRouter()
const store = useInvoiceStore()
const projects = useProjectStore()
const changingProject = ref(false)
const id = String(route.params.id)
const detail = ref<InvoiceDetail>()
const loading = ref(false)
const saving = ref(false)
const retrying = ref(false)
const recognizing = computed(() => retrying.value || ['queued', 'running'].includes(detail.value?.invoice.ocrStatus ?? ''))
const baseline = ref('')
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
let loadVersion = 0
let leaveRequest: Promise<boolean> | undefined
let unsubscribe: (() => void) | undefined
let unsubscribeData: (() => void) | undefined
const externalUpdate = ref(false)
const emptyFields = (): InvoiceFields => ({ invoiceType: '', invoiceCode: '', invoiceNumber: '', invoiceDate: '', buyerName: '', buyerTaxId: '', sellerName: '', sellerTaxId: '', amountExcludingTax: null, taxAmount: null, totalAmount: null, remark: '' })
const form = ref<InvoiceFields>(emptyFields())
baseline.value = JSON.stringify(form.value)
const activeField = ref<keyof InvoiceFields>()
const activeEvidence = computed(() => activeField.value ? latestResult.value?.evidence[activeField.value] : undefined)
const latestResult = computed(() => detail.value?.ocrResults[0])
const tagOptions = ref<string[]>([])
const invoiceStatusOptions = INVOICE_STATUSES.map((value) => ({ value, label: INVOICE_STATUS_LABELS[value] }))
function setDetail(value: InvoiceDetail): void {
  externalUpdate.value = false
  detail.value = value
  const { invoice } = value
  form.value = { invoiceType: invoice.invoiceType, invoiceCode: invoice.invoiceCode, invoiceNumber: invoice.invoiceNumber, invoiceDate: invoice.invoiceDate, buyerName: invoice.buyerName, buyerTaxId: invoice.buyerTaxId, sellerName: invoice.sellerName, sellerTaxId: invoice.sellerTaxId, amountExcludingTax: invoice.amountExcludingTax, taxAmount: invoice.taxAmount, totalAmount: invoice.totalAmount, remark: invoice.remark }
  baseline.value = JSON.stringify(form.value)
}
async function load(fillRecognized = false): Promise<void> {
  const version = ++loadVersion
  loading.value = true
  try {
    const value = await api.getInvoice(id)
    if (version !== loadVersion) return
    if (dirty.value && detail.value && fillRecognized && !saving.value && !externalUpdate.value) {
      const before = JSON.parse(baseline.value) as InvoiceFields
      const draft = { ...form.value }
      const keys = Object.keys(before) as Array<keyof InvoiceFields>
      const parsed = value.ocrResults[0]?.parsedFields ?? {}
      const empty = emptyFields()
      const conflict = keys.some(key => value.invoice[key] !== before[key]
        && (value.invoice.manualFields.includes(key) || key === 'remark' || value.invoice[key] !== (parsed[key] ?? empty[key])))
      if (!conflict) {
        setDetail(value)
        for (const key of keys) if (draft[key] !== before[key]) Object.assign(form.value, { [key]: draft[key] })
        return
      }
      externalUpdate.value = true
    }
    if (dirty.value && detail.value) {
      detail.value.ocrResults = value.ocrResults
      detail.value.duplicates = value.duplicates
      detail.value.invoice.ocrStatus = value.invoice.ocrStatus
      detail.value.invoice.ocrAttempts = value.invoice.ocrAttempts
      detail.value.invoice.ocrError = value.invoice.ocrError
      return
    }
    setDetail(value)
    try { tagOptions.value = await api.getTags() } catch { /* 标签列表加载失败不阻断详情页 */ }
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { loading.value = false }
}
async function changeProject(projectId: string): Promise<void> {
  if (!detail.value) return
  changingProject.value = true
  try {
    await api.setInvoiceProjects([id], projectId ? [projectId] : [])
    await projects.fetch()
    detail.value.invoice.projects = projectId ? projects.items.filter((project) => project.id === projectId).map(({ id, name }) => ({ id, name })) : []
    await store.fetchList()
    ElMessage.success('项目归属已更新')
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { changingProject.value = false }
}
watch(() => projects.items, (items) => {
  if (detail.value) detail.value.invoice.projects = detail.value.invoice.projects.flatMap((project) => {
    const current = items.find((item) => item.id === project.id)
    return current ? [{ id: current.id, name: current.name }] : []
  })
})
async function changeStatus(status: InvoiceStatus): Promise<void> {
  if (!detail.value) return
  try {
    await api.setInvoicesStatus([id], status)
    detail.value.invoice.status = status
    ElMessage.success('发票状态已更新')
  } catch (error) { ElMessage.error(errorMessage(error)) }
}
async function changeTags(tags: string[]): Promise<void> {
  if (!detail.value) return
  try {
    await api.setInvoiceTags(id, tags)
    detail.value.invoice.tags = tags
    tagOptions.value = await api.getTags()
    ElMessage.success('标签已更新')
  } catch (error) { ElMessage.error(errorMessage(error)) }
}
async function removeInvoice(): Promise<void> {
  try {
    await ElMessageBox.confirm('将该发票移入回收站？原文件保留，可在回收站恢复。', '移入回收站', { type: 'warning' })
    await api.deleteInvoices([id])
    await Promise.all([store.fetchList(), projects.fetch()])
    ElMessage.success('已移入回收站')
    void router.push({ path: '/invoices', query: route.query })
  } catch (error) { if (error !== 'cancel') ElMessage.error(errorMessage(error)) }
}
async function restoreInvoice(): Promise<void> {
  try {
    await api.restoreInvoices([id])
    await load()
    await Promise.all([store.fetchList(), projects.fetch()])
    ElMessage.success('已恢复')
  } catch (error) { ElMessage.error(errorMessage(error)) }
}
async function purgeInvoice(): Promise<void> {
  try {
    await ElMessageBox.confirm('彻底删除后无法恢复，该发票及其原始文件将被删除。', '彻底删除', { type: 'error', confirmButtonText: '彻底删除' })
    await api.purgeInvoices([id])
    await Promise.all([store.fetchList(), projects.fetch()])
    ElMessage.success('已彻底删除')
    void router.push({ path: '/invoices', query: route.query })
  } catch (error) { if (error !== 'cancel') ElMessage.error(errorMessage(error)) }
}
async function save(confirm: boolean): Promise<boolean> {
  if (saving.value) return false
  loadVersion++
  saving.value = true
  try {
    setDetail(await api.saveInvoice({ id, fields: form.value, confirm, expectedFieldRevision: detail.value?.fieldRevision }))
    await Promise.all([store.fetchList(), projects.fetch()])
    ElMessage.success(confirm ? '发票已确认' : '校正内容已保存')
    return true
  } catch (error) { if (error instanceof Error && error.name === 'DATA_CONFLICT') externalUpdate.value = true; ElMessage.error(errorMessage(error)); return false } finally { saving.value = false }
}
async function reloadExternal(): Promise<void> {
  try { if (dirty.value) await ElMessageBox.confirm('重新载入会放弃当前未保存的校正，是否继续？', '重新载入发票', { confirmButtonText: '重新载入', cancelButtonText: '继续编辑', type: 'warning' }); loadVersion++; setDetail(await api.getInvoice(id)) } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error)) }
}
async function refreshExternal(): Promise<void> {
  const version = ++loadVersion
  try {
    const value = await api.getInvoice(id)
    if (version !== loadVersion) return
    if (!dirty.value && !saving.value) { setDetail(value); return }
    if (!detail.value) return
    // Keep the draft's field revision, while reflecting live tags, project and status.
    const draftRevision = detail.value.fieldRevision
    if (value.fieldRevision !== draftRevision || value.invoice.deletedAt !== detail.value.invoice.deletedAt) externalUpdate.value = true
    detail.value = { ...value, fieldRevision: draftRevision }
  } catch (error) { ElMessage.error(errorMessage(error)) }
}
async function retry(): Promise<void> {
  if (recognizing.value || saving.value) return
  retrying.value = true
  try {
    await api.retryOcr(id)
    await load(true)
    ElMessage.success('已开始识别')
  } catch (error) { ElMessage.error(errorMessage(error)) }
  finally { retrying.value = false }
}
function openDuplicate(invoiceId: string): void { void router.push({ path: `/invoices/${invoiceId}`, query: route.query }) }
async function confirmLeave(): Promise<boolean> {
  if (saving.value) return false
  if (!dirty.value) return true
  if (leaveRequest) return leaveRequest
  leaveRequest = (async () => {
    try {
      await ElMessageBox.confirm('当前校正尚未保存。保存后离开，或放弃本次修改；点击右上角关闭可继续编辑。', '未保存的修改', { confirmButtonText: '保存并离开', cancelButtonText: '放弃修改', distinguishCancelAndClose: true, closeOnClickModal: false, closeOnPressEscape: true, type: 'warning' })
      return await save(false)
    } catch (action) { return action === 'cancel' }
    finally { leaveRequest = undefined }
  })()
  return leaveRequest
}
function onKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey) || detail.value?.invoice.deletedAt || document.querySelector('.el-overlay:not([style*="display: none"])')) return
  if (event.key.toLowerCase() === 's' || event.key === 'Enter') { event.preventDefault(); void save(event.key === 'Enter') }
}
onBeforeRouteLeave(() => confirmLeave())
function beforeUnload(event: BeforeUnloadEvent): void {
  if (!dirty.value && !saving.value) return
  event.preventDefault()
  event.returnValue = ''
  void confirmLeave().then((leave) => {
    if (leave) { baseline.value = JSON.stringify(form.value); window.close() }
  })
}
onMounted(() => {
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('keydown', onKeydown)
  void load()
  unsubscribeData = api.onDataChanged(() => { void refreshExternal() })
  unsubscribe = api.onOcrProgress((progress) => {
    if (progress.invoiceId !== id) return
    if (detail.value) { detail.value.invoice.ocrStatus = progress.status; detail.value.invoice.ocrError = progress.error ?? null }
    if (progress.status === 'succeeded') { void load(true); void store.fetchList() }
  })
})
onBeforeUnmount(() => { loadVersion++; unsubscribe?.(); unsubscribeData?.(); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('keydown', onKeydown) })
</script>

<style scoped>
.detail-page { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.detail-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: none; margin-bottom: 14px; }
.detail-heading { display: flex; align-items: center; min-width: 0; }
.file-title { margin-left: 8px; color: var(--el-text-color-regular); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-toolbar .toolbar-actions { flex: none; }
.detail-metadata { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 24px; flex: none; margin-bottom: 16px; }
.status-line, .meta-line { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--muted); font-size: 11px; }
.meta-line { margin-left: auto; }
.meta-label { margin-left: 6px; color: var(--muted); font-size: 11px; }
.unsaved { color: #b8842c; }
.detail-alert { flex: none; margin-bottom: 12px; }
.detail-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(360px, 1fr); gap: 16px; }
.edit-panel { min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex: none; padding: 14px 18px; border-bottom: 1px solid var(--border); }
.editor-heading strong { font-size: 13px; font-weight: 600; }
.editor-heading span { font-size: 10px; color: light-dark(#86958a, #b5b6c1); }
.editor-scroll { flex: 1; min-height: 0; overflow: auto; padding: 16px; }
@media (max-width: 1180px) {
  .detail-grid { grid-template-columns: minmax(0, 1fr) minmax(360px, 1fr); gap: 12px; }
  .detail-toolbar { flex-wrap: wrap; }
  .detail-heading { max-width: 280px; }
  .detail-toolbar .el-button { padding-left: 10px; padding-right: 10px; }
  .editor-heading span { display: none; }
  .meta-line { margin-left: 0; }
}
</style>

<style scoped>
.editor-footer { margin-top: 20px; padding-top: 12px; border-top: 1px solid var(--border); }
.editor-footer .el-button { color: var(--muted); }
.editor-footer .el-button:hover { color: var(--el-color-danger); }
</style>
