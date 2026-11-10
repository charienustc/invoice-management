<template>
  <section class="invoice-list" :data-layout="listLayout">

    <div v-if="projectScope !== undefined" class="invoice-project-tabs"><span>发票</span><RouterLink :to="{path: '/advances', query: route.query}">垫付记录</RouterLink></div>
    <div class="toolbar">
      <div class="toolbar-title"><span class="toolbar-name" :title="trashMode ? '回收站' : currentProject?.name || (projectScope === null ? '未分配' : '发票')">{{ trashMode ? '回收站' : currentProject?.name || (projectScope === null ? '未分配' : '发票') }}</span><span class="list-count">{{ store.total }} 张</span></div>
      <div class="toolbar-search"><el-input ref="searchInput" v-model="filters.keyword" aria-label="搜索发票" :prefix-icon="Search" placeholder="搜索" clearable @keyup.enter="search" /></div>
      <Transition name="toolbar-change" mode="out-in">
        <div v-if="selected.length" key="selection" class="toolbar-actions batch-actions">
          <span class="selection-text">已选 {{ selected.length }} 张</span>
          <el-button size="small" :icon="Download" @click="exportDialogVisible = true">导出所选</el-button>
          <template v-if="!trashMode">
            <el-button size="small" :icon="Folder" @click="assigningProject = true">分配项目</el-button>
            <el-button size="small" type="primary" @click="batchConfirm">批量确认</el-button>
            <el-dropdown @command="batchCommand"><el-button size="small" :icon="MoreFilled" aria-label="更多批量操作" /><template #dropdown><el-dropdown-menu>
              <el-dropdown-item command="retry">重新识别</el-dropdown-item>
              <el-dropdown-item v-for="meta in statusOptions" :key="meta.value" :command="`status:${meta.value}`">标记为{{ meta.label }}</el-dropdown-item>
              <el-dropdown-item divided command="addTags">添加标签</el-dropdown-item><el-dropdown-item command="removeTags">移除标签</el-dropdown-item>
              <el-dropdown-item divided command="trash">移入回收站</el-dropdown-item>
            </el-dropdown-menu></template></el-dropdown>
          </template>
          <template v-else><el-button size="small" type="primary" @click="batchRestore">恢复</el-button><el-button size="small" type="danger" plain @click="batchPurge">彻底删除</el-button></template>
          <el-button size="small" text @click="clearSelection">取消选择</el-button>
        </div>
        <div v-else key="normal" class="toolbar-actions">
          <el-button :icon="View" :disabled="!focusedInvoice" title="预览（空格）" @click="quickLook = true">预览</el-button>
          <el-button v-if="!trashMode" type="primary" :icon="Plus" :loading="importing" title="导入发票（Ctrl+O）" @click="importFiles">导入发票</el-button>
          <el-button :icon="Download" @click="exportDialogVisible = true">导出</el-button>
        </div>
      </Transition>
    </div>
    <div class="list-controls">
      <div class="list-views" aria-label="发票快捷筛选" :style="{ '--view-index': activeViewIndex }">
        <span v-if="activeViewIndex >= 0" class="view-indicator" aria-hidden="true" />
        <button v-for="view in views" :key="view.key" type="button" :class="{ active: activeView === view.key }" :aria-pressed="activeView === view.key" @click="selectView(view.key)">{{ view.label }}</button>
      </div>
      <div class="view-options"><el-button text :icon="Filter" :aria-expanded="advancedOpen" aria-controls="invoice-filters" @click="advancedOpen = !advancedOpen">{{ advancedOpen ? '收起筛选' : '高级筛选' }}<span v-if="advancedCount" class="filter-count">{{ advancedCount }}</span></el-button><el-button text :icon="Delete" @click="toggleTrash">{{ trashMode ? '返回发票列表' : '回收站' }}</el-button></div>
    </div>
    <div v-if="extraFilterChips.length" class="extra-filters"><span class="filter-caption">已筛选</span><TextBadge v-for="chip in extraFilterChips" :key="chip.key" :label="chip.label" variant="filter" removable @remove="removeExtraFilter(chip.key)" /><el-button text size="small" @click="clearExtraFilters">清除附加条件</el-button></div>
    <div class="filter-reveal" :class="{ expanded: advancedOpen }" :inert="!advancedOpen" :aria-hidden="!advancedOpen">
      <div class="filter-inner"><div class="filter-panel">
        <el-form id="invoice-filters" inline @submit.prevent="search">
          <el-form-item label="开票日期"><el-date-picker v-model="filters.dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" style="width: 240px" /></el-form-item>
          <el-form-item label="价税合计"><div class="amount-range"><el-input-number v-model="minimumAmount" aria-label="最低金额" placeholder="最低金额" :min="0" :max="999999999.99" :precision="2" :controls="false" /><span>至</span><el-input-number v-model="maximumAmount" aria-label="最高金额" placeholder="最高金额" :min="0" :max="999999999.99" :precision="2" :controls="false" /></div></el-form-item>
          <el-form-item label="审核状态"><el-select v-model="filters.reviewStatus" clearable placeholder="全部" style="width: 110px"><el-option label="未核对" value="unreviewed" /><el-option label="待核对" value="needs_review" /><el-option label="已确认" value="confirmed" /></el-select></el-form-item>
          <el-form-item label="发票状态"><el-select v-model="filters.status" clearable placeholder="全部" style="width: 110px"><el-option v-for="meta in statusOptions" :key="meta.value" :label="meta.label" :value="meta.value" /></el-select></el-form-item>
          <el-form-item label="标签"><el-select v-model="filters.tag" clearable filterable placeholder="全部" style="width: 130px"><el-option v-for="tag in tagOptions" :key="tag" :label="tag" :value="tag" /></el-select></el-form-item>
          <el-form-item label="OCR 状态"><el-select v-model="filters.ocrStatus" clearable placeholder="全部" style="width: 120px"><el-option v-for="(meta, key) in ocrStatusMeta" :key="key" :label="meta.text" :value="key" /></el-select></el-form-item>
          <el-form-item label="发票类型"><el-select v-model="filters.invoiceType" clearable placeholder="全部" style="width: 180px"><el-option v-for="type in ['增值税专用发票', '增值税普通发票', '电子发票（普通发票）', '电子发票（铁路电子客票）', '电子发票（航空运输电子客票行程单）', '航空运输电子客票行程单', '电子发票', '其他发票']" :key="type" :label="type" :value="type" /></el-select></el-form-item>
          <el-form-item><el-button @click="reset">重置</el-button></el-form-item>
        </el-form>
      </div></div>
    </div>

    <div class="panel table-panel">
      <div ref="tableContainer" class="table-wrap" tabindex="0" aria-label="发票列表">
        <el-table ref="tableRef" v-loading="store.loading" :data="store.items" row-key="id" height="100%" highlight-current-row @row-click="focusRow" @row-dblclick="openDetail" @selection-change="selected = $event">
        <el-table-column key="selection" type="selection" :width="compactList ? 42 : 46" @click.stop />
        <el-table-column key="invoice" label="发票信息" :min-width="compactList ? 180 : 210">
          <template #default="{ row }">
            <div class="invoice-number">{{ row.invoiceNumber || '未识别号码' }}</div>
            <div class="sub-text" :title="[row.invoiceType, row.invoiceCode].filter(Boolean).join(' · ')">{{ row.invoiceType || '未分类' }}<span v-if="row.invoiceCode"> · {{ row.invoiceCode }}</span></div>
            <div v-if="!wideList" class="invoice-meta"><time>{{ row.invoiceDate || '未填日期' }}</time><span :title="row.projects[0]?.name">{{ row.projects[0]?.name || '未分配' }}</span></div>
            <div v-if="compactList" class="compact-parties"><div :title="row.sellerName">销：{{ row.sellerName || '待补充' }}</div><div :title="row.buyerName">购：{{ row.buyerName || '待补充' }}</div></div>
          </template>
        </el-table-column>
        <el-table-column v-if="!compactList" key="parties" label="购销方" min-width="200">
          <template #default="{ row }"><div class="party" :title="row.sellerName">{{ row.sellerName || '销售方待补充' }}</div><div class="sub-text" :title="row.buyerName">购：{{ row.buyerName || '待补充' }}</div></template>
        </el-table-column>
        <el-table-column v-if="wideList" key="date" prop="invoiceDate" label="开票日期" width="110"><template #default="{ row }">{{ row.invoiceDate || '—' }}</template></el-table-column>
        <el-table-column key="amount" label="价税合计" :width="compactList ? 108 : 120" align="right"><template #default="{ row }"><span class="money" :title="`¥ ${formatMoney(row.totalAmount)}`">¥ {{ formatMoney(row.totalAmount) }}</span></template></el-table-column>
        <el-table-column v-if="wideList" key="project" label="项目" min-width="120" show-overflow-tooltip><template #default="{ row }"><span class="project-cell">{{ row.projects[0]?.name || '—' }}</span></template></el-table-column>
        <el-table-column key="archive" :label="compactList ? '状态 / 标签' : '归档 / 标签'" :width="compactList ? 208 : 166">
          <template #default="{ row }">
            <div class="archive-cell"><TextBadge :label="invoiceStatusMeta[row.status as InvoiceStatus].text" :tone="invoiceStatusMeta[row.status as InvoiceStatus].type" variant="status" />
              <div v-if="compactList" class="processing-status"><TextBadge :label="reviewStatusMeta[row.reviewStatus as ReviewStatus].text" :tone="reviewStatusMeta[row.reviewStatus as ReviewStatus].type" variant="status" /><TextBadge :label="ocrStatusMeta[row.ocrStatus as OcrStatus].text" :tone="ocrStatusMeta[row.ocrStatus as OcrStatus].type" variant="status" /></div>
              <div v-if="row.tags.length" class="invoice-tags"><TextBadge v-for="tag in row.tags.slice(0, 2)" :key="tag" :label="tag" class="invoice-tag" /><TextBadge v-if="row.tags.length > 2" :label="`+${row.tags.length - 2}`" variant="count" :title="row.tags.slice(2).join('、')" /></div>
            </div>
          </template>
        </el-table-column>
        <el-table-column v-if="wideList" key="ocr" label="OCR" width="100"><template #default="{ row }"><TextBadge :label="ocrStatusMeta[row.ocrStatus as OcrStatus].text" :tone="ocrStatusMeta[row.ocrStatus as OcrStatus].type" variant="status" /></template></el-table-column>
        <el-table-column v-if="!compactList" key="review" :label="wideList ? '审核状态' : '识别 / 审核'" :width="wideList ? 100 : 112"><template #default="{ row }"><div class="processing-status"><TextBadge v-if="!wideList" :label="ocrStatusMeta[row.ocrStatus as OcrStatus].text" :tone="ocrStatusMeta[row.ocrStatus as OcrStatus].type" variant="status" /><TextBadge :label="reviewStatusMeta[row.reviewStatus as ReviewStatus].text" :tone="reviewStatusMeta[row.reviewStatus as ReviewStatus].type" variant="status" /></div></template></el-table-column>
        <el-table-column key="actions" label="操作" :width="compactList ? 64 : 80" align="center"><template #default="{ row }"><el-button link type="primary" @click.stop="openDetail(row)">查看</el-button></template></el-table-column>
          <template #empty><div class="invoice-empty"><strong>{{ trashMode ? '回收站为空' : hasFilters ? '没有找到匹配的发票' : '暂无发票' }}</strong><p>{{ hasFilters ? '试试其他关键字，或重置筛选条件' : trashMode ? '移入回收站的发票会显示在这里' : '支持 PDF、JPG、PNG、BMP 和 WebP 文件。' }}</p><el-button v-if="hasFilters" @click="reset">重置筛选</el-button><el-button v-else-if="!trashMode" type="primary" :icon="Upload" :loading="importing" @click="importFiles">导入发票</el-button></div></template>
        </el-table>
      </div>
      <div class="pagination-bar"><span v-if="focusedInvoice" class="keyboard-hint">空格预览 · 回车校对</span><el-pagination background :pager-count="5" layout="total, sizes, prev, pager, next" :total="store.total" :current-page="store.query.page" :page-size="store.query.pageSize" :page-sizes="[10, 20, 50, 100]" @current-change="store.updateQuery({ page: $event })" @size-change="store.updateQuery({ page: 1, pageSize: $event })" /></div>
    </div>

    <el-dialog :model-value="!!importSummary" title="导入结果" width="680px" @close="importSummary = undefined">
      <template v-if="importSummary">
        <p>新增 {{ importSummary.imported.length }} 张 · 重复 {{ importSummary.duplicates.length }} 个 · 失败 {{ importSummary.failures.length }} 个</p>
        <div class="import-results">
          <div v-for="item in importSummary.duplicates" :key="item.invoiceId + item.fileName" class="import-result-row"><span>{{ item.fileName }}<small>{{ item.deleted ? '已在回收站中' : '已存在，无需重复导入' }}</small></span><el-button v-if="item.deleted" size="small" @click="restoreDuplicate(item.invoiceId)">恢复并查看</el-button><el-button v-else size="small" @click="locateDuplicate(item.invoiceId)">查看已有发票</el-button></div>
          <div v-for="item in importSummary.failures" :key="item.fileName" class="import-result-row"><span>{{ item.fileName }}<small>{{ item.message }}</small></span></div>
        </div>
      </template>
      <template #footer><el-button @click="importSummary = undefined">关闭</el-button></template>
    </el-dialog>
    <el-dialog v-model="quickLook" class="quick-look" title="预览" width="min(1000px, 88vw)" :destroy-on-close="true" :close-on-click-modal="true">
      <FilePreview v-if="focusedInvoice" :invoice-id="focusedInvoice.id" :file-name="focusedInvoice.fileName" :mime-type="focusedInvoice.mimeType" />
      <template #footer><span class="muted">{{ focusedInvoice?.invoiceNumber || focusedInvoice?.fileName }}</span><el-button type="primary" @click="openFocused">校对发票</el-button></template>
    </el-dialog>
    <ProjectAssignmentDialog v-model="assigningProject" :invoice-ids="ids()" :initial-project-id="sharedProjectId" @changed="projectAssigned" />
    <ExportDialog v-model="exportDialogVisible" :selected-count="selected.length" :build-scope="buildExportScope" @exported="(message) => ElMessage.success(message)" />
    <BatchTagDialog v-model="tagDialogVisible" :mode="tagDialogMode" :count="selected.length" :existing-tags="tagOptions" @confirm="applyTagDialog" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox, ElNotification, type InputInstance, type TableInstance } from 'element-plus'
import { Delete, Download, Filter, Folder, MoreFilled, Plus, Search, Upload, View } from '@element-plus/icons-vue'
import { INVOICE_STATUSES, type Invoice, type InvoiceFilter, type InvoiceStatus, type ImportSummary, type OcrStatus, type ReviewStatus } from '@shared/contracts'
import { INVOICE_STATUS_LABELS } from '@shared/labels'
import { formatMoney } from '@shared/money'
import { api } from '@/api'
import { useInvoiceStore } from '@/stores/invoices'
import { errorMessage, invoiceStatusMeta, ocrStatusMeta, reviewStatusMeta } from '@/utils'
import ExportDialog from '@/components/ExportDialog.vue'
import BatchTagDialog from '@/components/BatchTagDialog.vue'
import FilePreview from '@/components/FilePreview.vue'
import ProjectAssignmentDialog from '@/components/ProjectAssignmentDialog.vue'
import { useProjectStore } from '@/stores/projects'
import TextBadge from '@/components/TextBadge.vue'

const router = useRouter()
const store = useInvoiceStore()
const route = useRoute()
const projects = useProjectStore()
const projectScope = route.query.project === 'unassigned' ? null : typeof route.query.project === 'string' ? route.query.project : undefined
const currentProject = computed(() => projects.items.find((project) => project.id === projectScope))
if (store.query.projectId !== projectScope) store.query = { page: 1, pageSize: store.query.pageSize, projectId: projectScope }
const assigningProject = ref(false)
const tableRef = ref<TableInstance>()
const selected = ref<Invoice[]>([])
const sharedProjectId = computed(() => selected.value.length && selected.value.every((invoice) => invoice.projects[0]?.id === selected.value[0].projects[0]?.id) ? selected.value[0].projects[0]?.id ?? '' : undefined)
const searchInput = ref<InputInstance>()
const tableContainer = ref<HTMLElement>()
const availableWidth = ref(0)
const wideList = computed(() => availableWidth.value >= 1280)
const compactList = computed(() => availableWidth.value < 960)
const listLayout = computed(() => wideList.value ? 'wide' : compactList.value ? 'compact' : 'regular')
let resizeObserver: ResizeObserver | undefined
const focusedId = ref('')
const focusedInvoice = computed(() => store.items.find((invoice) => invoice.id === focusedId.value))
const quickLook = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | undefined
function focusRow(invoice: Invoice): void { tableContainer.value?.focus({ preventScroll: true }); focusedId.value = invoice.id; tableRef.value?.setCurrentRow(invoice) }
function openFocused(): void { if (focusedInvoice.value) openDetail(focusedInvoice.value) }
function onKeydown(event: KeyboardEvent): void {
  if (document.querySelector('.el-overlay:not([style*="display: none"])')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchInput.value?.focus(); return }
  const target = event.target as HTMLElement
  if (target.closest('input, textarea, select, [contenteditable="true"], .el-select, .el-date-editor')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') { event.preventDefault(); if (!trashMode.value && !importing.value) void importFiles(); return }
  if (event.key === 'Enter' && focusedInvoice.value) { event.preventDefault(); openFocused() }
  if (event.code === 'Space' && focusedInvoice.value && !target.closest('button, a')) { event.preventDefault(); quickLook.value = true }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!store.items.length) return
    event.preventDefault()
    const current = store.items.findIndex((invoice) => invoice.id === focusedId.value)
    const index = Math.max(0, Math.min(store.items.length - 1, current < 0 ? 0 : current + (event.key === 'ArrowDown' ? 1 : -1)))
    focusRow(store.items[index])
    void nextTick(() => tableRef.value?.$el.querySelector('.current-row')?.scrollIntoView({ block: 'nearest' }))
  }
}
const importing = ref(false)
const importSummary = ref<ImportSummary>()
const exportDialogVisible = ref(false)
const tagDialogVisible = ref(false)
const tagDialogMode = ref<'add' | 'remove'>('add')
const trashMode = ref(!!store.query.deleted)
const advancedOpen = ref(false)
const tagOptions = ref<string[]>([])
const filters = reactive<{ keyword: string; dates: string[] | null; reviewStatus: ReviewStatus | ''; ocrStatus: OcrStatus | ''; invoiceType: string; status: InvoiceStatus | ''; tag: string }>({ keyword: '', dates: [], reviewStatus: '', ocrStatus: '', invoiceType: '', status: '', tag: '' })

const query = store.query
const extraFilters = ref<Pick<InvoiceFilter, 'amountMin' | 'amountMax' | 'statuses' | 'sellerName' | 'missingField'>>({ amountMin: query.amountMin, amountMax: query.amountMax, statuses: query.statuses, sellerName: query.sellerName, missingField: query.missingField })
const minimumAmount = computed({ get: () => extraFilters.value.amountMin === undefined ? undefined : extraFilters.value.amountMin / 100, set: (value: number | undefined) => { extraFilters.value.amountMin = value == null ? undefined : Math.round(value * 100) } })
const maximumAmount = computed({ get: () => extraFilters.value.amountMax === undefined ? undefined : extraFilters.value.amountMax / 100, set: (value: number | undefined) => { extraFilters.value.amountMax = value == null ? undefined : Math.round(value * 100) } })
const extraFilterChips = computed(() => [
  { key: 'sellerName' as const, label: extraFilters.value.sellerName !== undefined ? `销售方：${extraFilters.value.sellerName || '未填'}` : '' },
  { key: 'missingField' as const, label: extraFilters.value.missingField ? `未填${({invoiceDate:'开票日期',totalAmount:'价税合计',amountExcludingTax:'不含税金额',taxAmount:'税额',invoiceType:'发票类型'})[extraFilters.value.missingField]}` : '' },
  { key: 'amountMin' as const, label: extraFilters.value.amountMin !== undefined ? `价税合计 ≥ ¥${formatMoney(extraFilters.value.amountMin)}` : '' },
  { key: 'amountMax' as const, label: extraFilters.value.amountMax !== undefined ? `价税合计 ≤ ¥${formatMoney(extraFilters.value.amountMax)}` : '' },
  { key: 'statuses' as const, label: extraFilters.value.statuses?.length ? `状态：${extraFilters.value.statuses.map((value) => INVOICE_STATUS_LABELS[value]).join('、')}` : '' },
].filter((chip) => chip.label))
function removeExtraFilter(key: keyof typeof extraFilters.value): void { delete extraFilters.value[key]; void search() }
function clearExtraFilters(): void { extraFilters.value = {}; void search() }
Object.assign(filters, { keyword: query.keyword ?? '', dates: query.dateFrom || query.dateTo ? [query.dateFrom ?? '', query.dateTo ?? ''] : [], reviewStatus: query.reviewStatus ?? '', ocrStatus: query.ocrStatus ?? '', invoiceType: query.invoiceType ?? '', status: query.status ?? '', tag: query.tag ?? '' })
const advancedCount = computed(() => [filters.reviewStatus, filters.ocrStatus, filters.invoiceType, filters.status, filters.tag].filter(Boolean).length + extraFilterChips.value.length)
const hasFilters = computed(() => !!(filters.keyword || filters.dates?.length || advancedCount.value || extraFilterChips.value.length))
const views = [{ key: 'all', label: '全部发票' }, { key: 'unreviewed', label: '未核对' }, { key: 'needs_review', label: '待核对' }, { key: 'confirmed', label: '已确认' }, { key: 'failed', label: '识别失败' }] as const
const activeView = computed(() => filters.ocrStatus === 'failed' && !filters.reviewStatus ? 'failed' : !filters.ocrStatus ? filters.reviewStatus || 'all' : '')
const activeViewIndex = computed(() => views.findIndex((view) => view.key === activeView.value))
function selectView(key: typeof views[number]['key']): void {
  filters.reviewStatus = key === 'all' || key === 'failed' ? '' : key
  filters.ocrStatus = key === 'failed' ? 'failed' : ''
  void search()
}

const statusOptions = computed(() => INVOICE_STATUSES.map((value) => ({ value, label: INVOICE_STATUS_LABELS[value] })))

function currentFilter(): InvoiceFilter {
  return {
    keyword: filters.keyword || undefined,
    dateFrom: filters.dates?.[0],
    dateTo: filters.dates?.[1],
    reviewStatus: filters.reviewStatus || undefined,
    ocrStatus: filters.ocrStatus || undefined,
    invoiceType: filters.invoiceType || undefined,
    status: filters.status || undefined,
    tag: filters.tag || undefined,
    deleted: trashMode.value ? true : undefined,
    projectId: projectScope,
    amountMin: extraFilters.value.amountMin,
    amountMax: extraFilters.value.amountMax,
    statuses: extraFilters.value.statuses,
    sellerName: extraFilters.value.sellerName,
    missingField: extraFilters.value.missingField,
  }
}
async function search(): Promise<void> {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = undefined
  if (extraFilters.value.amountMin !== undefined && extraFilters.value.amountMax !== undefined && extraFilters.value.amountMin > extraFilters.value.amountMax) { ElMessage.warning('最低金额不能大于最高金额'); return }
  clearSelection()
  focusedId.value = ''
  try { await store.updateQuery({ ...currentFilter(), page: 1 }) } catch (error) { ElMessage.error(errorMessage(error)) }
}
function reset(): Promise<void> {
  extraFilters.value = {}
  filters.keyword = ''
  filters.dates = []
  filters.reviewStatus = ''
  filters.ocrStatus = ''
  filters.invoiceType = ''
  filters.status = ''
  filters.tag = ''
  return search()
}
function toggleTrash(): void {
  trashMode.value = !trashMode.value
  clearSelection()
  void search()
}
function clearSelection(): void {
  selected.value = []
  tableRef.value?.clearSelection()
}
async function refreshTags(): Promise<void> {
  try { tagOptions.value = await api.getTags() } catch { /* 标签列表加载失败不阻断页面 */ }
}
function refresh(): Promise<void[]> {
  return Promise.all([store.fetchList(), refreshTags(), projects.fetch()])
}
async function importFiles(): Promise<void> {
  importing.value = true
  try {
    const result = await api.importFiles(projectScope)
    if (!result.imported.length && !result.duplicates.length && !result.failures.length && !result.warnings?.length) return
    if (result.warnings?.length) ElMessage.warning(result.warnings.join('；'))
    ElNotification({ customClass: 'app-notification', title: '导入完成', message: `新增 ${result.imported.length} 张，重复 ${result.duplicates.length} 个，失败 ${result.failures.length} 个${result.failures.length ? `：${result.failures[0].message}` : ''}`, type: result.failures.length ? 'warning' : 'success' })
    if (result.duplicates.length || result.failures.length) importSummary.value = result
    await refresh()
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { importing.value = false }
}
function buildExportScope(scope: 'filter' | 'selected'): { filter?: InvoiceFilter; invoiceIds?: string[] } {
  const { page, pageSize, ...filter } = store.query
  return scope === 'selected' ? { invoiceIds: selected.value.map((item) => item.id), filter: { deleted: trashMode.value, projectId: projectScope } } : { filter }
}
function locateDuplicate(id: string): void { importSummary.value = undefined; void router.push({ path: `/invoices/${id}`, query: route.query }) }
async function restoreDuplicate(id: string): Promise<void> {
  try { await api.restoreInvoices([id]); locateDuplicate(id) } catch (error) { ElMessage.error(errorMessage(error)) }
}
async function runBatch(action: () => Promise<number>, successText: string): Promise<void> {
  try {
    const count = await action()
    ElMessage.success(`${successText}（${count} 张）`)
    clearSelection()
    await refresh()
  } catch (error) { if (error !== 'cancel') ElMessage.error(errorMessage(error)) }
}
async function batchConfirm(): Promise<void> {
  try {
    const result = await api.confirmInvoices(ids())
    clearSelection()
    await refresh()
    if (result.skipped.length) await ElMessageBox.alert(`已确认 ${result.confirmed} 张，未处理 ${result.skipped.length} 张。\n${result.skipped.map((item) => `${item.fileName}：${item.reason}`).join('\n')}`, '批量确认结果', { customClass: 'batch-result-dialog' })
    else ElMessage.success(`已确认 ${result.confirmed} 张发票`)
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error)) }
}
function batchRetry(): Promise<void> { return runBatch(() => api.retryOcrInvoices(ids()), '已加入识别队列') }
function batchDelete(): Promise<void> {
  return runBatch(async () => { await ElMessageBox.confirm(`确定将已选 ${selected.value.length} 张发票移入回收站吗？`, '移入回收站', { type: 'warning' }); return api.deleteInvoices(ids()) }, '已移入回收站')
}
function batchRestore(): Promise<void> { return runBatch(() => api.restoreInvoices(ids()), '已恢复') }
function batchPurge(): Promise<void> {
  return runBatch(async () => { await ElMessageBox.confirm(`彻底删除后无法恢复，已选 ${selected.value.length} 张发票及其原始文件将被删除。`, '彻底删除', { type: 'error', confirmButtonText: '彻底删除' }); return api.purgeInvoices(ids()) }, '已彻底删除')
}
function batchSetStatus(status: InvoiceStatus): void { void runBatch(() => api.setInvoicesStatus(ids(), status), `已设置状态为「${INVOICE_STATUS_LABELS[status]}」`) }
function ids(): string[] { return selected.value.map((item) => item.id) }
function openTagDialog(mode: 'add' | 'remove'): void { tagDialogMode.value = mode; tagDialogVisible.value = true }
async function applyTagDialog(tags: string[]): Promise<void> {
  tagDialogVisible.value = false
  await runBatch(() => tagDialogMode.value === 'add' ? api.addInvoicesTags(ids(), tags) : api.removeInvoicesTags(ids(), tags), tagDialogMode.value === 'add' ? '已添加标签' : '已移除标签')
}
function openDetail(row: Invoice): void { quickLook.value = false; void router.push({ path: `/invoices/${row.id}`, query: route.query }) }
async function projectAssigned(count: number): Promise<void> {
  clearSelection()
  await refresh()
  ElMessage.success(`已更新 ${count} 张发票的项目归属`)
}
function batchCommand(command: string): void {
  if (command.startsWith('status:')) batchSetStatus(command.slice(7) as InvoiceStatus)
  else if (command === 'retry') void batchRetry()
  else if (command === 'addTags') openTagDialog('add')
  else if (command === 'removeTags') openTagDialog('remove')
  else if (command === 'trash') void batchDelete()
}
watch([filters, extraFilters], () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => { searchTimer = undefined; void search() }, 220)
}, { deep: true, flush: 'sync' })
watch(() => filters.status, (value) => { if (value) extraFilters.value.statuses = undefined }, { flush: 'sync' })
watch(focusedInvoice, (invoice) => { if (!invoice) quickLook.value = false })
watch(listLayout, async () => { await nextTick(); tableRef.value?.doLayout(); if (focusedInvoice.value) tableRef.value?.setCurrentRow(focusedInvoice.value) })
onMounted(() => {
  if (tableContainer.value) {
    availableWidth.value = tableContainer.value.clientWidth
    resizeObserver = new ResizeObserver(([entry]) => { if (entry) availableWidth.value = entry.contentRect.width })
    resizeObserver.observe(tableContainer.value)
  }
  void refresh().catch((error) => ElMessage.error(errorMessage(error)))
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => { resizeObserver?.disconnect(); if (searchTimer) clearTimeout(searchTimer); window.removeEventListener('keydown', onKeydown) })
</script>

<style scoped>
.invoice-list { min-width: 0; width: 100%; container: invoice / inline-size; }
.toolbar-title { max-width: 100%; min-width: 0; }.toolbar-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }.list-count { flex: none; }
.invoice-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 3px 10px; margin-top: 5px; font-size: 11px; color: var(--muted); }.invoice-meta time { flex: none; font-variant-numeric: tabular-nums; }.invoice-meta > span { min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compact-parties { margin-top: 7px; font-size: 11px; line-height: 1.6; color: var(--el-text-color-regular); }.compact-parties > div { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.processing-status { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 5px; }
.table-panel, .table-wrap { min-width: 0; width: 100%; }.invoice-number { overflow-wrap: anywhere; }
.money { display: block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; line-height: 1.5; }
@container invoice (max-width: 959px) {
  .toolbar-search { flex: 1 1 160px; max-width: 300px; }.toolbar-actions { min-width: 0; max-width: 100%; }.batch-actions { flex-wrap: wrap; }
  .pagination-bar { padding: 10px 12px; flex-wrap: wrap; gap: 8px; }.keyboard-hint { display: none; }
  .invoice-tags { flex-wrap: wrap; }.invoice-tag { max-width: 95px; }
  :deep(.el-table .cell) { padding-left: 10px; padding-right: 10px; }
}
.extra-filters { display: flex; gap: 7px; align-items: center; flex-wrap: wrap; padding: 0 22px 12px; }.filter-caption { margin-right: 2px; color: light-dark(#9297a2, #b5b6c1); font-size: 11px; }
section { height: 100%; display: flex; flex-direction: column; min-height: 0; }
.toolbar { flex: none; flex-wrap: wrap; margin: 0; padding: 16px 22px; min-height: 68px; background: var(--toolbar-bg); border-bottom: 1px solid var(--border); }
.toolbar-title { font-size: 18px; gap: 10px; white-space: nowrap; }
.list-count { font-size: 12px; font-weight: 400; color: var(--muted); }
.toolbar-search { width: clamp(180px, 23vw, 300px); margin-left: auto; }
.toolbar-search :deep(.el-input__wrapper) { background: light-dark(#e9eaee, #292a2f); box-shadow: none; border-radius: 8px; }
.toolbar-search :deep(.el-input__wrapper.is-focus) { box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 14%, transparent); }
.toolbar-actions { gap: 6px; }
.selection-text { font-size: 12px; color: var(--muted); }
.list-controls { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 14px 22px; flex: none; }
.list-views { position: relative; isolation: isolate; display: grid; grid-template-columns: repeat(5, 78px); padding: 3px; background: light-dark(#eeeef1, #292a2f); border: 1px solid light-dark(#e6e6e9, #393b43); border-radius: 8px; }
.list-views button { position: relative; z-index: 1; border: 0; background: transparent; height: 27px; font-size: 12px; color: light-dark(#707178, #b5b6c1); cursor: pointer; }
.list-views button.active { color: light-dark(#24252a, #e4e4eb); font-weight: 600; }
.view-indicator { position: absolute; top: 3px; bottom: 3px; left: 3px; width: 78px; background: light-dark(#fff, #242529); border-radius: 6px; box-shadow: 0 1px 4px #00000014, 0 0 0 1px #00000004; transform: translateX(calc(var(--view-index) * 78px)); transition: transform 240ms var(--ease-spring); }
.view-options { display: flex; gap: 4px; }
.filter-count { padding-left: 5px; color: var(--primary); }
.filter-reveal { visibility: hidden; display: grid; grid-template-rows: 0fr; opacity: 0; flex: none; transition: grid-template-rows 230ms var(--ease-out), opacity 160ms, visibility 0s 230ms; }
.filter-reveal.expanded { visibility: visible; grid-template-rows: 1fr; opacity: 1; transition-delay: 0s; }
.filter-inner { overflow: hidden; min-height: 0; }
.filter-panel { margin: 0 22px 14px; padding: 14px 16px 0; border: 1px solid var(--border); border-radius: 9px; background: light-dark(#f8f8fa, #292a2f); }
.filter-panel .el-form { display: flex; flex-wrap: wrap; gap: 0 14px; }
.filter-panel .el-form-item { margin-right: 0; margin-bottom: 14px; }
.amount-range { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 11px; }.amount-range :deep(.el-input-number) { width: 108px; }.amount-range :deep(input) { text-align: left; font-variant-numeric: tabular-nums; }
.table-panel { flex: 1; min-height: 0; border-width: 1px 0 0; border-radius: 0; box-shadow: none; }
.table-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; outline: none; }
.invoice-number { color: var(--el-text-color-primary); font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
.party { color: var(--el-text-color-regular); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.archive-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }.invoice-tags { display: flex; align-items: center; gap: 4px; max-width: 100%; }.invoice-tag { max-width: 80px; flex: 0 1 auto; }.invoice-tags .badge-count { flex: none; }
.keyboard-hint { color: light-dark(#96969e, #b5b6c1); font-size: 11px; margin-right: auto; }
.invoice-empty { display: flex; align-items: center; flex-direction: column; padding: 50px 10px; color: var(--muted); }
.invoice-empty strong { font-size: 15px; font-weight: 500; color: light-dark(#66666f, #e4e4eb); }
.invoice-empty p { font-size: 12px; margin: 10px 0 18px; }
.import-results { max-height: 360px; overflow: auto; }
.import-result-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; border-top: 1px solid var(--border); }
.import-result-row > span { min-width: 0; overflow-wrap: anywhere; }
.import-result-row small { display: block; margin-top: 5px; color: var(--muted); }
:deep(.el-table__row) { cursor: default; }
@media (max-width: 1180px) { .toolbar { padding: 12px 16px; } .toolbar-search { width: 180px; } .toolbar-actions { gap: 4px; } .list-controls { padding-left: 16px; padding-right: 16px; } .list-views { grid-template-columns: repeat(5, 68px); } .view-indicator { width: 68px; transform: translateX(calc(var(--view-index) * 68px)); } }
</style>

<style scoped>
.invoice-project-tabs { display: flex; gap: 18px; padding: 12px 22px 0; font-size: 12px; flex: none; }.invoice-project-tabs span { color: var(--primary); }.invoice-project-tabs a { color: var(--muted); text-decoration: none; }
</style>
