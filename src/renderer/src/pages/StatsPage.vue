<template>
  <section class="statistics-page">
    <div class="stats-filter">
      <el-select :popper-options="selectPopperOptions" :teleported="true" :show-arrow="false" v-model="projectId" aria-label="统计项目" class="project-select" @change="load"><el-option label="全部项目" value="all" /><el-option label="未分配" value="unassigned" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select>
      <el-select :popper-options="selectPopperOptions" :teleported="true" :show-arrow="false" v-model="reviewScope" aria-label="统计口径" class="scope-select" @change="load"><el-option label="仅已确认" value="confirmed" /><el-option label="全部发票（含待核对）" value="all" /></el-select>
      <el-select :popper-options="selectPopperOptions" :teleported="true" :show-arrow="false" v-model="statusScope" aria-label="统计发票状态" class="status-select" @change="load"><el-option label="未作废发票" value="valid" /><el-option label="全部状态（含作废）" value="all" /><el-option v-for="status in INVOICE_STATUSES" :key="status" :label="INVOICE_STATUS_LABELS[status]" :value="status" /></el-select>
      <div class="stats-actions"><el-button :disabled="loading || !stats?.invoiceCount" @click="viewInvoices()">查看明细</el-button><el-button :disabled="loading || !stats" :loading="exporting" @click="exportReport">导出统计报表</el-button></div>
    </div>
    <div class="stats-period"><span>开票日期</span><el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" clearable @change="load" /><div class="date-shortcuts"><button v-for="preset in presets" :key="preset.key" type="button" :class="{ active: isPreset(preset.key) }" :aria-pressed="isPreset(preset.key)" @click="choosePeriod(preset.key)">{{ preset.label }}</button></div></div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" class="stats-error"><el-button text @click="load">重新加载</el-button></el-alert>
    <div v-loading="loading" class="stats-content">
      <template v-if="stats">
        <p class="scope-note">{{ applied.reviewScope === 'all' ? '含待核对发票' : '仅统计已确认发票' }} · {{ applied.statuses ? '不含作废发票' : applied.status ? INVOICE_STATUS_LABELS[applied.status] : '含作废发票' }}<span v-if="stats.confirmedCount !== stats.invoiceCount"> · {{ stats.invoiceCount - stats.confirmedCount }} 张未确认</span></p>
        <div class="panel stat-cards"><div v-for="card in cards" :key="card.label" class="stat-card"><span>{{ card.label }}</span><strong>{{ card.value }}</strong><small>{{ card.note }}</small></div></div>
        <div v-if="qualityItems.some(item => item.count)" class="quality-strip"><span>待补充</span><el-button v-for="item in qualityItems.filter(item => item.count)" :key="item.field" link type="warning" @click="viewInvoices({ missingField: item.field })">{{ item.label }} {{ item.count }} 张</el-button><small>缺失字段不计入对应金额合计；未填日期不进入月度趋势。</small></div>
        <AdvanceStatsPanel :filter="applied" :revision="advanceRevision" />
        <div class="stats-grid">
          <div class="panel chart-panel monthly-panel"><div class="panel-title"><div><strong>月度趋势</strong><span>{{ monthlyCaption }}</span></div><div class="chart-controls"><el-select :popper-options="selectPopperOptions" :teleported="true" :show-arrow="false" v-model="monthMode" aria-label="月份显示范围"><el-option label="12个月" value="recent" /><el-option label="全部有票月份" value="all" /></el-select><el-radio-group v-model="metric" size="small" aria-label="月度指标"><el-radio-button value="amount">金额</el-radio-button><el-radio-button value="count">张数</el-radio-button></el-radio-group></div></div>
            <el-empty v-if="!months.length" description="当前范围没有带日期的发票" :image-size="56" />
            <div v-else class="rank-list month-list"><button v-for="row in months" :key="row.month" type="button" class="rank-row month-row" :disabled="!row.invoiceCount || loading" :aria-label="`查看${row.month}发票`" @click="viewMonth(row.month)"><span class="rank-label">{{ row.month }}</span><span class="bar-track"><span class="bar-fill" :style="{ width: `${monthWidth(row)}%` }" /></span><span class="rank-value"><strong>{{ metric === 'amount' ? `¥ ${formatMoney(row.totalAmount)}` : `${row.invoiceCount} 张` }}</strong><small>{{ metric === 'amount' ? `${row.invoiceCount} 张` : `¥ ${formatMoney(row.totalAmount)}` }}</small></span></button></div>
          </div>
          <div class="panel chart-panel"><div class="panel-title"><div><strong>报销状态</strong><span>点击状态查看对应发票</span></div></div><el-empty v-if="!stats.invoiceCount" description="当前范围暂无发票" :image-size="56" /><button v-for="row in stats.byStatus" v-else :key="row.status" class="distribution-row" type="button" :disabled="loading" :aria-label="`查看${INVOICE_STATUS_LABELS[row.status]}发票`" @click="viewInvoices({ status: row.status, statuses: undefined })"><span class="distribution-heading"><span>{{ INVOICE_STATUS_LABELS[row.status] }}</span><strong>¥ {{ formatMoney(row.totalAmount) }}</strong></span><span class="bar-track"><span class="bar-fill" :style="{ width: `${share(row.totalAmount)}%` }" /></span><small>{{ row.invoiceCount }} 张 · {{ share(row.totalAmount).toFixed(1) }}%</small></button></div>
          <div class="panel chart-panel"><div class="panel-title"><div><strong>项目对比</strong><span>包含未分配发票，金额互不重复</span></div><el-button v-if="stats.byProject.length > 10" text size="small" @click="allProjects = !allProjects">{{ allProjects ? '收起' : `查看全部 ${stats.byProject.length} 项` }}</el-button></div><el-empty v-if="!stats.byProject.length" description="当前范围暂无项目费用" :image-size="56" /><div v-else class="rank-list"><button v-for="row in projectRows" :key="row.projectId || 'unassigned'" type="button" class="rank-row" :disabled="loading" :aria-label="`查看项目${row.name}发票`" @click="viewInvoices({ projectId: row.projectId })"><span class="rank-label" :title="row.name">{{ row.name }}</span><span class="bar-track"><span class="bar-fill" :style="{ width: `${rankWidth(row.totalAmount, stats.byProject)}%` }" /></span><span class="rank-value"><strong>¥ {{ formatMoney(row.totalAmount) }}</strong><small>{{ row.invoiceCount }} 张</small></span></button></div></div>
          <div class="panel chart-panel"><div class="panel-title"><div><strong>发票类型</strong><span>价税合计占比</span></div></div><el-empty v-if="!stats.byType.length" description="当前范围暂无类型分布" :image-size="56" /><div v-else class="rank-list"><button v-for="row in stats.byType" :key="row.typeKey" class="distribution-row" type="button" :disabled="loading" @click="viewInvoices(row.typeKey ? { invoiceType: row.typeKey } : { missingField: 'invoiceType' })"><span class="distribution-heading"><span>{{ row.invoiceType }}</span><strong>¥ {{ formatMoney(row.totalAmount) }}</strong></span><span class="bar-track"><span class="bar-fill" :style="{ width: `${share(row.totalAmount)}%` }" /></span><small>{{ row.invoiceCount }} 张 · {{ share(row.totalAmount).toFixed(1) }}%</small></button></div></div>
          <div class="panel chart-panel seller-panel"><div class="panel-title"><div><strong>销售方排行</strong><span>{{ allSellers ? '全部销售方' : '金额前 10 名' }} · 按名称汇总</span></div><el-button v-if="stats.bySeller.length > 10" text size="small" @click="allSellers = !allSellers">{{ allSellers ? '收起' : `查看全部 ${stats.bySeller.length} 家` }}</el-button></div><el-empty v-if="!stats.bySeller.length" description="当前范围暂无销售方费用" :image-size="56" /><div v-else class="rank-list"><button v-for="row in sellerRows" :key="row.name" type="button" class="rank-row" :disabled="loading" :aria-label="`查看销售方${row.name || '未填'}发票`" @click="viewInvoices({ sellerName: row.name })"><span class="rank-label" :title="row.name">{{ row.name || '未填销售方' }}</span><span class="bar-track"><span class="bar-fill" :style="{ width: `${rankWidth(row.totalAmount, stats.bySeller)}%` }" /></span><span class="rank-value"><strong>¥ {{ formatMoney(row.totalAmount) }}</strong><small>{{ row.invoiceCount }} 张</small></span></button></div></div>
        </div>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { INVOICE_STATUSES, statsFilterSchema, type InvoiceFilter, type InvoiceStats, type StatsFilter } from '@shared/contracts'
import { INVOICE_STATUS_LABELS } from '@shared/labels'
import { formatMoney } from '@shared/money'
import { monthDates, monthSeries } from '@shared/stats'
import { api } from '@/api'
import { errorMessage } from '@/utils'
import { useProjectStore } from '@/stores/projects'
import { useInvoiceStore } from '@/stores/invoices'
import AdvanceStatsPanel from '@/components/AdvanceStatsPanel.vue'
import { useStatisticsViewStore } from '@/stores/statistics'

const projects = useProjectStore(), invoiceStore = useInvoiceStore(), router = useRouter()
const { projectId, dates, reviewScope, statusScope } = storeToRefs(useStatisticsViewStore())
const selectPopperOptions = { modifiers: [{ name: 'computeStyles', options: { gpuAcceleration: false, roundOffsets: true } }] }
const stats = ref<InvoiceStats>(), applied = ref<StatsFilter>({})
const loading = ref(false), exporting = ref(false), loadError = ref('')
const monthMode = ref<'recent' | 'all'>('recent'), metric = ref<'amount' | 'count'>('amount')
const advanceRevision = ref(0)
const allProjects = ref(false), allSellers = ref(false)
let version = 0, disposed = false, refreshTimer: ReturnType<typeof setTimeout> | undefined
let offData: (() => void) | undefined, offOcr: (() => void) | undefined
const presets = [{ key: 'all', label: '全部' }, { key: 'month', label: '本月' }, { key: 'lastMonth', label: '上月' }, { key: 'quarter', label: '近三个月' }, { key: 'year', label: '今年' }] as const
type Preset = typeof presets[number]['key']
function day(date: Date): string { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
function period(key: Preset): string[] {
  const now = new Date(), year = now.getFullYear(), month = now.getMonth()
  if (key === 'all') return []
  if (key === 'lastMonth') return [day(new Date(year, month - 1, 1)), day(new Date(year, month, 0))]
  return [day(key === 'year' ? new Date(year, 0, 1) : new Date(year, key === 'quarter' ? month - 2 : month, 1)), day(now)]
}
function isPreset(key: Preset): boolean { return JSON.stringify(dates.value || []) === JSON.stringify(period(key)) }
function choosePeriod(key: Preset): void { dates.value = period(key); void load() }
function currentFilter(): StatsFilter {
  return { projectId: projectId.value === 'all' ? undefined : projectId.value === 'unassigned' ? null : projectId.value,
    dateFrom: dates.value?.[0], dateTo: dates.value?.[1], reviewScope: reviewScope.value,
    status: statusScope.value === 'valid' || statusScope.value === 'all' ? undefined : statusScope.value,
    statuses: statusScope.value === 'valid' ? ['unprocessed', 'booked', 'reimbursed'] : undefined }
}
async function load(): Promise<void> {
  const request = ++version
  loading.value = true; loadError.value = ''
  try {
    const filter = statsFilterSchema.parse(currentFilter()), result = await api.getStats(filter)
    if (request !== version || disposed) return
    stats.value = result; applied.value = filter
  } catch (error) { if (request === version && !disposed) { stats.value = undefined; loadError.value = errorMessage(error) } }
  finally { if (request === version && !disposed) loading.value = false }
}
const cards = computed(() => {
  const value = stats.value
  if (!value) return []
  const amount = (field: 'totalAmount' | 'amountExcludingTax' | 'taxAmount') => value.invoiceCount > 0 && value.missing[field] === value.invoiceCount ? '—' : formatMoney(value[field])
  return [
    { label: '发票张数', value: String(value.invoiceCount), note: `已确认 ${value.confirmedCount} 张` },
    { label: '价税合计（元）', value: amount('totalAmount'), note: value.missing.totalAmount ? `${value.missing.totalAmount} 张未填写` : '当前范围合计' },
    { label: '不含税金额（元）', value: amount('amountExcludingTax'), note: value.missing.amountExcludingTax ? `${value.missing.amountExcludingTax} 张未填写` : '当前范围合计' },
    { label: '税额（元）', value: amount('taxAmount'), note: value.missing.taxAmount ? `${value.missing.taxAmount} 张未填写` : '当前范围合计' },
    { label: '平均票额（元）', value: value.invoiceCount > value.missing.totalAmount ? formatMoney(value.averageAmount) : '—', note: '按已填写价税合计计算' },
  ]
})
const qualityItems = computed(() => (['invoiceDate', 'totalAmount', 'amountExcludingTax', 'taxAmount'] as const).map(field => ({ field, label: { invoiceDate: '日期', totalAmount: '价税合计', amountExcludingTax: '不含税金额', taxAmount: '税额' }[field], count: stats.value?.missing[field] ?? 0 })))
const months = computed(() => monthSeries(stats.value?.monthly ?? [], monthMode.value, applied.value.dateFrom, applied.value.dateTo))
const monthlyCaption = computed(() => !months.value.length ? '价税合计按开票月份汇总' : monthMode.value === 'all' ? '全部有票月份，未填日期另计' : `${months.value[0].month} 至 ${months.value[months.value.length - 1].month}，无票月份补零`)
const projectRows = computed(() => allProjects.value ? stats.value?.byProject : stats.value?.byProject.slice(0, 10))
const sellerRows = computed(() => allSellers.value ? stats.value?.bySeller : stats.value?.bySeller.slice(0, 10))
function share(amount: number): number { return stats.value?.totalAmount ? amount / stats.value.totalAmount * 100 : 0 }
function rankWidth(amount: number, rows: Array<{ totalAmount: number }>): number { return amount / Math.max(1, ...rows.map(row => row.totalAmount)) * 100 }
function monthWidth(row: InvoiceStats['monthly'][number]): number {
  const key = metric.value === 'amount' ? 'totalAmount' : 'invoiceCount'
  return row[key] / Math.max(1, ...months.value.map(row => row[key])) * 100
}
async function viewInvoices(patch: InvoiceFilter = {}): Promise<void> {
  if (loading.value || !stats.value) return
  const { reviewScope: scope, ...filter } = applied.value
  const next: InvoiceFilter = { ...filter, reviewStatus: scope === 'all' ? undefined : 'confirmed', ...patch }
  invoiceStore.query = { ...next, page: 1, pageSize: invoiceStore.query.pageSize }
  await router.push({ path: '/invoices', query: next.projectId === null ? { project: 'unassigned' } : next.projectId ? { project: next.projectId } : {} })
}
function viewMonth(month: string): void {
  const [from, to] = monthDates(month)
  void viewInvoices({ dateFrom: applied.value.dateFrom && applied.value.dateFrom > from ? applied.value.dateFrom : from, dateTo: applied.value.dateTo && applied.value.dateTo < to ? applied.value.dateTo : to })
}
async function exportReport(): Promise<void> {
  if (loading.value || exporting.value || !stats.value) return
  exporting.value = true
  try { const result = await api.exportStats(applied.value); if (!result.canceled) ElMessage.success(`已导出 ${result.count} 张发票的统计报表`) } catch (error) { ElMessage.error(errorMessage(error)) } finally { exporting.value = false }
}
function scheduleRefresh(): void { advanceRevision.value++; if (refreshTimer) clearTimeout(refreshTimer); refreshTimer = setTimeout(() => { refreshTimer = undefined; void load() }, 250) }
onMounted(() => { void load(); offData = api.onDataChanged(scheduleRefresh); offOcr = api.onOcrProgress(event => { if (event.status === 'succeeded' || event.status === 'failed') scheduleRefresh() }) })
watch(() => projects.items, items => { if (projectId.value !== 'all' && projectId.value !== 'unassigned' && !items.some(project => project.id === projectId.value)) { projectId.value = 'all'; void load() } })
onBeforeUnmount(() => { disposed = true; version++; offData?.(); offOcr?.(); if (refreshTimer) clearTimeout(refreshTimer) })
</script>

<style scoped>
.statistics-page { min-width: 0; container: statistics / inline-size; padding-bottom: 4px; }
.stats-filter, .stats-period, .date-shortcuts, .stats-actions, .chart-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; min-width: 0; }
.stats-filter { margin-bottom: 12px; }.project-select { width: 190px; }.scope-select { width: 190px; }.status-select { width: 205px; }
.stats-actions { margin-left: auto; }.stats-actions .el-button + .el-button { margin-left: 0; }
.stats-period { margin-bottom: 14px; font-size: 12px; color: var(--muted); }.stats-period :deep(.el-date-editor) { width: 260px; flex: none; max-width: 100%; }
.date-shortcuts { gap: 3px; }.date-shortcuts button { background: transparent; color: var(--muted); border: 0; padding: 5px 9px; border-radius: 5px; cursor: pointer; font-size: 12px; }
.date-shortcuts button:hover, .date-shortcuts button.active { background: var(--el-color-primary-light-9); color: var(--primary); }
.stats-content { min-height: 180px; }.stats-error { margin-bottom: 14px; }.scope-note { margin: 0 0 12px; font-size: 11px; color: var(--muted); line-height: 1.6; }
.stat-cards { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); margin-bottom: 16px; overflow: hidden; }
.stat-card { min-width: 0; padding: 16px 18px; }.stat-card + .stat-card { border-left: 1px solid var(--border); }
.stat-card > span, .stat-card small { display: block; font-size: 11px; color: var(--muted); line-height: 1.6; }.stat-card strong { display: block; margin: 7px 0 5px; font-size: clamp(20px, 2.2cqi, 27px); font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.quality-strip { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin: -2px 0 14px; font-size: 12px; }.quality-strip > span, .quality-strip small { color: var(--muted); font-size: 11px; }.quality-strip .el-button { margin: 0; }
.stats-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; }
.chart-panel { min-width: 0; padding: 16px 18px; }.monthly-panel { min-height: 330px; }.seller-panel { grid-column: 1 / -1; }
.panel-title { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }.panel-title > div:first-child { min-width: 0; }.panel-title strong, .panel-title span { display: block; }.panel-title strong { font-size: 14px; font-weight: 600; }.panel-title span { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.chart-controls { gap: 7px; }.chart-controls .el-select { width: 140px; }.rank-list { max-height: 330px; overflow: auto; scrollbar-gutter: stable; }
.rank-row { width: 100%; display: grid; grid-template-columns: minmax(80px, 1fr) minmax(45px, 1.2fr) minmax(105px, auto); align-items: center; gap: 12px; padding: 9px 5px; }
.month-row { grid-template-columns: 65px minmax(45px, 1fr) minmax(145px, auto); padding-top: 6px; padding-bottom: 6px; }.rank-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; text-align: left; }
.rank-row, .distribution-row { border: 0; border-radius: 6px; background: transparent; color: var(--el-text-color-regular); cursor: pointer; }.rank-row:hover:enabled, .distribution-row:hover:enabled { background: light-dark(#f4f5f7, #2b2d33); }.rank-row:disabled { cursor: default; color: var(--muted); }
.bar-track { display: block; height: 6px; border-radius: 3px; background: light-dark(#edf0f3, #353740); overflow: hidden; }.bar-fill { display: block; height: 100%; border-radius: inherit; background: var(--primary); }
.rank-value { text-align: right; font-variant-numeric: tabular-nums; }.rank-value strong { display: block; font-size: 12px; font-weight: 500; }.rank-value small, .distribution-row > small { display: block; margin-top: 4px; color: var(--muted); font-size: 11px; }
.month-row .rank-value { display: flex; align-items: baseline; justify-content: flex-end; gap: 7px; white-space: nowrap; }.month-row .rank-value small { margin-top: 0; }
.distribution-row { display: block; width: 100%; padding: 10px 5px; text-align: left; }.distribution-heading { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 9px; font-size: 12px; }.distribution-heading > span { min-width: 0; overflow-wrap: anywhere; }.distribution-heading strong { flex: none; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
@container statistics (max-width: 1050px) { .stat-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }.stat-card:nth-child(4) { border-left: 0; }.stat-card:nth-child(n+4) { border-top: 1px solid var(--border); }.stats-actions { margin-left: 0; } }
@container statistics (max-width: 780px) { .stats-grid { grid-template-columns: minmax(0, 1fr); }.seller-panel { grid-column: auto; }.stat-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }.stat-card { padding: 12px 14px; }.stat-card:nth-child(odd) { border-left: 0; }.stat-card:nth-child(even) { border-left: 1px solid var(--border); }.stat-card:nth-child(n+3) { border-top: 1px solid var(--border); }.stat-card:last-child { grid-column: 1 / -1; }.rank-row { gap: 8px; }.chart-panel { padding: 14px; } }
</style>
