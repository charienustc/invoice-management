<template>
  <section ref="root" class="advances-page" :data-layout="compact ? 'compact' : 'full'">
    <div v-if="projectScope !== undefined" class="project-tabs"><strong>{{ projectName }}</strong><RouterLink :to="{path: '/invoices', query: route.query}">发票</RouterLink><span aria-current="page">垫付记录</span></div>
    <div class="advance-toolbar">
      <el-input v-model="keyword" aria-label="搜索垫付记录" placeholder="搜索事项、收款方或备注" clearable @input="search" />
      <el-select v-model="status" aria-label="收回状态" clearable placeholder="全部收回状态" @change="load"><el-option label="未收回" value="unpaid" /><el-option label="部分收回" value="partial" /><el-option label="已收回" value="paid" /></el-select>
      <el-select v-model="billing" aria-label="补票状态" clearable placeholder="全部票据状态" @change="load"><el-option label="无票（含关联失效）" value="unbilled" /><el-option label="已补票" value="linked" /></el-select>
      <div class="advance-actions"><el-button :disabled="busy || loading" @click="exportRecords">导出</el-button><el-button :type="trash ? 'primary' : 'default'" @click="trash = !trash; load()">回收站</el-button><el-button type="primary" @click="edit()">新增垫付</el-button></div>
    </div>
    <div class="advance-dates"><el-date-picker v-model="dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" @change="load" /><el-select v-if="projectScope === undefined" v-model="projectFilter" aria-label="垫付项目筛选" clearable placeholder="全部项目" @change="load"><el-option label="未分配" value="unassigned" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select></div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false"><el-button text @click="load">重新加载</el-button></el-alert>
    <div class="panel advance-summary"><div v-for="item in summary" :key="item.label"><span>{{ item.label }}</span><strong>{{ formatMoney(item.value) }}</strong></div></div>
    <p class="advance-note">{{ trash ? '回收站内记录不计入正常统计，可恢复。' : `${data.total} 笔 · 收回不抵减支出；已补票不计入无票支出。` }}</p>
    <div v-loading="loading" class="panel advance-table">
      <el-table :data="visibleRows" row-key="id" @row-dblclick="edit">
        <el-table-column label="事项" min-width="190"><template #default="{row}"><button class="record-title" @click="edit(row)">{{ row.title }}</button><div class="sub-text">{{ row.date }}<span v-if="row.payee"> · {{ row.payee }}</span></div><div v-if="compact" class="sub-text">{{ row.projectName }} · {{ row.remaining === 0 ? '已收回' : row.recovered ? '部分收回' : '未收回' }} · {{ row.linked ? '已补票' : '无票' }}</div></template></el-table-column>
        <el-table-column v-if="!compact" label="项目" min-width="100" prop="projectName" show-overflow-tooltip />
        <el-table-column label="垫付金额" min-width="110" align="right"><template #default="{row}">{{ formatMoney(row.amount) }}<div v-if="compact" class="sub-text">已收回 {{ formatMoney(row.recovered) }}</div></template></el-table-column>
        <el-table-column v-if="!compact" label="已收回" min-width="100" align="right"><template #default="{row}">{{ formatMoney(row.recovered) }}</template></el-table-column>
        <el-table-column label="待收回" min-width="110" align="right"><template #default="{row}"><strong>{{ formatMoney(row.remaining) }}</strong></template></el-table-column>
        <el-table-column v-if="!compact" label="状态" min-width="100"><template #default="{row}"><TextBadge :label="row.remaining === 0 ? '已收回' : row.recovered ? '部分收回' : '未收回'" :tone="row.remaining === 0 ? 'success' : 'warning'" /></template></el-table-column>
        <el-table-column v-if="!compact" label="凭证" min-width="90"><template #default="{row}"><span :title="row.invoiceNumber">{{ row.linked ? '已补票' : row.invoiceId ? '关联失效' : '无票' }}</span><div v-if="row.attachments.length" class="sub-text">{{ row.attachments.length }} 个附件</div></template></el-table-column>
        <el-table-column label="操作" width="75" fixed="right"><template #default="{row}"><el-button link type="primary" @click="edit(row)">{{ trash ? '查看' : '编辑' }}</el-button></template></el-table-column>
        <template #empty><el-empty :description="trash ? '回收站为空' : '暂无垫付记录'" :image-size="60" /></template>
      </el-table>
      <div class="pagination-bar"><el-pagination background layout="total, prev, pager, next" :total="data.total" :page-size="20" v-model:current-page="page" /></div>
    </div>
    <el-drawer v-model="drawer" :title="record ? '垫付详情' : '新增垫付'" size="min(640px, 100vw)" :before-close="closeEditor" class="advance-editor" :close-on-click-modal="false">
      <el-form label-position="top" :disabled="busy || !!record?.deleted">
        <el-form-item label="事项" required><el-input v-model="form.title" aria-label="垫付事项" maxlength="200" autofocus /></el-form-item>
        <div class="editor-columns"><el-form-item label="金额（元）" required><el-input v-model="amountText" aria-label="垫付金额" inputmode="decimal" placeholder="0.00" /></el-form-item><el-form-item label="垫付日期" required><el-date-picker v-model="form.date" aria-label="垫付日期" type="date" value-format="YYYY-MM-DD" :clearable="false" /></el-form-item></div>
        <div class="editor-columns"><el-form-item label="项目"><el-select v-model="form.projectId" aria-label="所属垫付项目" @change="form.invoiceId = null; invoiceOptions = []"><el-option label="未分配" :value="null" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select></el-form-item><el-form-item label="收款方"><el-input v-model="form.payee" aria-label="收款方" maxlength="200" /></el-form-item></div>
        <el-form-item label="备注"><el-input v-model="form.remark" aria-label="垫付备注" type="textarea" :rows="2" maxlength="2000" /></el-form-item>
        <el-form-item label="关联补开发票"><el-select v-model="form.invoiceId" aria-label="关联补开发票" clearable @clear="form.invoiceId = null" filterable remote :remote-method="findInvoices" :loading="findingInvoices" placeholder="输入发票号码或销售方搜索" @visible-change="(value: boolean) => value && findInvoices('')"><el-option v-for="invoice in invoiceOptions" :key="invoice.id" :label="`${invoice.invoiceNumber || invoice.fileName} · ¥${formatMoney(invoice.totalAmount)}`" :value="invoice.id" /></el-select><small>仅关联同项目、同金额的有效发票，一张发票关联一笔垫付；收回金额单独登记。</small></el-form-item>
      </el-form>
      <el-alert v-if="record?.invoiceId && !record.linked" type="warning" title="关联发票已删除、作废或变更项目或金额，当前仍计入无票支出。请重新关联或清除关联。" :closable="false" />
      <div class="editor-section"><div class="section-toolbar"><strong>付款凭证 / 收据</strong><el-button v-if="!record?.deleted" :disabled="busy" @click="attach">添加附件</el-button></div><p v-if="!record?.attachments.length" class="advance-note">可添加付款截图、收据或 PDF，也可以不添加。</p><div v-for="file in record?.attachments" :key="file.id" class="attachment-row"><el-button link @click="openAttachment(file.id)">{{ file.name }}</el-button><small>{{ Math.ceil(file.size / 1024) }} KB</small><el-button v-if="!record?.deleted" text :disabled="busy" @click="removeAttachment(file.id)">移除</el-button></div></div>
      <div class="editor-section"><div class="section-toolbar"><strong>收回记录</strong><span v-if="record">待收回 ¥{{ formatMoney(record.remaining) }}</span></div>
        <div v-if="!record?.deleted" class="return-form"><el-date-picker v-model="payment.date" type="date" value-format="YYYY-MM-DD" aria-label="收回日期" :clearable="false" /><el-input v-model="payment.amount" aria-label="本次收回金额" placeholder="本次金额（元）" inputmode="decimal" /><el-input v-model="payment.remark" aria-label="收回备注" placeholder="备注（选填）" maxlength="1000" /><el-button :disabled="busy || record?.remaining === 0" @click="recover">登记收回</el-button></div>
        <div v-for="item in record?.returns" :key="item.id" class="return-row"><span>{{ item.date }}<small>{{ item.remark }}</small></span><strong>¥{{ formatMoney(item.amount) }}</strong><el-button v-if="!record?.deleted" text :disabled="busy" @click="removeReturn(item.id)">撤销</el-button></div>
      </div>
      <template #footer><div class="advance-editor-actions"><el-button v-if="record" :disabled="busy" @click="setDeleted">{{ record.deleted ? '恢复记录' : '移入回收站' }}</el-button><span v-if="dirty" class="draft-note">未保存</span><el-button v-if="!record?.deleted" type="primary" :loading="busy" @click="save">保存记录</el-button><el-button @click="closeEditor()">完成</el-button></div></template>
    </el-drawer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute, onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Advance, AdvanceFields, AdvanceFilter, AdvanceResult } from '@shared/advances'
import { advanceSaveSchema } from '@shared/advances'
import type { Invoice } from '@shared/contracts'
import { formatMoney, parseMoneyToCents } from '@shared/money'
import { api } from '@/api'
import { useProjectStore } from '@/stores/projects'
import { errorMessage } from '@/utils'
import TextBadge from '@/components/TextBadge.vue'
const route = useRoute(), projects = useProjectStore()
const root = ref<HTMLElement>(), compact = ref(false)
let observer: ResizeObserver | undefined
const projectScope = route.query.project === 'unassigned' ? null : typeof route.query.project === 'string' ? route.query.project : undefined
const projectName = computed(() => projects.items.find(item => item.id === projectScope)?.name || '未分配')
const keyword = ref(''), projectFilter = ref(''), status = ref(''), billing = ref(''), dates = ref<string[]>(typeof route.query.dateFrom === 'string' || typeof route.query.dateTo === 'string' ? [String(route.query.dateFrom ?? ''), String(route.query.dateTo ?? '')] : []), trash = ref(false), page = ref(1)
const data = ref<AdvanceResult>({ items: [], total: 0, amount: 0, recovered: 0, remaining: 0, unbilledAmount: 0 })
const loading = ref(false), loadError = ref(''), busy = ref(false)
const visibleRows = computed(() => data.value.items.slice((page.value - 1) * 20, page.value * 20))
const summary = computed(() => [{label: '垫付金额（元）', value: data.value.amount}, {label: '已收回（元）', value: data.value.recovered}, {label: '待收回（元）', value: data.value.remaining}, {label: '无票支出（元）', value: data.value.unbilledAmount}])
function filter(): AdvanceFilter { return { keyword: keyword.value, projectId: projectScope !== undefined ? projectScope : projectFilter.value === 'unassigned' ? null : projectFilter.value || undefined, dateFrom: dates.value?.[0] || undefined, dateTo: dates.value?.[1] || undefined, status: status.value as AdvanceFilter['status'] || undefined, billing: billing.value as AdvanceFilter['billing'] || undefined, deleted: trash.value } }
let loadVersion = 0, searchTimer: ReturnType<typeof setTimeout> | undefined, off: (() => void) | undefined
async function load() { const version = ++loadVersion; loading.value = true; try { const result = await api.listAdvances(filter()); if (version !== loadVersion) return; data.value = result; page.value = Math.min(page.value, Math.max(1, Math.ceil(result.total / 20))); loadError.value = '' } catch (error) { loadError.value = errorMessage(error) } finally { if (version === loadVersion) loading.value = false } }
function search() { clearTimeout(searchTimer); searchTimer = setTimeout(() => { page.value = 1; void load() }, 200) }
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}` }
const empty = (): AdvanceFields => ({ title: '', amount: 0, date: today(), projectId: projectScope ?? null, payee: '', remark: '', invoiceId: null })
const form = ref(empty()), amountText = ref(''), drawer = ref(false), record = ref<Advance>(), baseline = ref('')
const snapshot = () => JSON.stringify({ ...form.value, amountText: amountText.value })
const dirty = computed(() => drawer.value && snapshot() !== baseline.value)
const payment = ref({ date: today(), amount: '', remark: '' }), invoiceOptions = ref<Invoice[]>([]), findingInvoices = ref(false)
let invoiceSearch = 0
function adopt(value: Advance) { record.value = value; form.value = { title: value.title, amount: value.amount, date: value.date, projectId: value.projectId, payee: value.payee, remark: value.remark, invoiceId: value.invoiceId }; amountText.value = (value.amount / 100).toFixed(2); baseline.value = snapshot() }
function edit(value?: Advance) { record.value = value; form.value = value ? { title: value.title, amount: value.amount, date: value.date, projectId: value.projectId, payee: value.payee, remark: value.remark, invoiceId: value.invoiceId } : empty(); amountText.value = value ? (value.amount / 100).toFixed(2) : ''; payment.value = { date: today(), amount: '', remark: '' }; invoiceOptions.value = []; baseline.value = snapshot(); drawer.value = true; void findInvoices('') }
async function findInvoices(keyword: string) { const version = ++invoiceSearch; findingInvoices.value = true; try { const result = await api.listInvoices({ page: 1, pageSize: 50, keyword, projectId: form.value.projectId, statuses: ['unprocessed', 'booked', 'reimbursed'] }); if (version !== invoiceSearch) return; const options = result.items; if (form.value.invoiceId && !options.some(item => item.id === form.value.invoiceId)) { const current = await api.getInvoice(form.value.invoiceId); options.unshift(current.invoice) }; invoiceOptions.value = options } catch (error) { ElMessage.error(errorMessage(error)) } finally { if (version === invoiceSearch) findingInvoices.value = false } }
async function persist(): Promise<Advance> { const amount = parseMoneyToCents(amountText.value); if (amount === null || amount <= 0) throw new Error('请输入大于 0 且最多两位小数的金额'); const input = advanceSaveSchema.parse({ ...form.value, amount, id: record.value?.id, revision: record.value?.revision }); const result = await api.saveAdvance(input); adopt(result); return result }
async function action(task: () => Promise<void>) { if (busy.value) return; busy.value = true; try { await task(); await load() } catch (error) { ElMessage.error(errorMessage(error)) } finally { busy.value = false } }
async function save() { await action(async () => { if (payment.value.amount || payment.value.remark) throw new Error('请先登记或清空收回信息，再保存记录'); await persist(); drawer.value = false; ElMessage.success('垫付记录已保存') }) }
async function recover() { await action(async () => { const amount = parseMoneyToCents(payment.value.amount); if (amount === null || amount <= 0) throw new Error('请输入本次收回金额'); const current = dirty.value || !record.value ? await persist() : record.value; adopt(await api.addAdvanceReturn({ id: current.id, revision: current.revision, amount, date: payment.value.date, remark: payment.value.remark })); payment.value.amount = ''; payment.value.remark = ''; ElMessage.success('已登记收回') }) }
async function attach() { await action(async () => { const current = dirty.value || !record.value ? await persist() : record.value; adopt(await api.addAdvanceAttachments({ id: current.id, revision: current.revision })) }) }
async function openAttachment(attachmentId: string) { try { await api.openAdvanceAttachment({ id: record.value!.id, attachmentId }) } catch (error) { ElMessage.error(errorMessage(error)) } }
async function removeAttachment(attachmentId: string) { try { await ElMessageBox.confirm('移除这份凭证附件？', '移除附件'); await action(async () => { const current = dirty.value ? await persist() : record.value!; adopt(await api.removeAdvanceAttachment({ id: current.id, revision: current.revision, attachmentId })) }) } catch {} }
async function removeReturn(returnId: string) { try { await ElMessageBox.confirm('撤销这次收回记录？待收回余额会相应增加。', '撤销收回记录'); await action(async () => { const current = dirty.value ? await persist() : record.value!; adopt(await api.removeAdvanceReturn({ id: current.id, revision: current.revision, returnId })) }) } catch {} }
async function setDeleted() { if (!record.value) return; try { if (!record.value.deleted) await ElMessageBox.confirm('将这条垫付记录移入回收站？收回记录和附件会保留。', '移入回收站'); await action(async () => { await api.setAdvanceDeleted({ id: record.value!.id, revision: record.value!.revision, deleted: !record.value!.deleted }); drawer.value = false }) } catch {} }
async function mayLeave() { if (busy.value) return false; if (!dirty.value && !payment.value.amount && !payment.value.remark) return true; try { await ElMessageBox.confirm('当前记录尚未保存，关闭会放弃本次修改或未登记的收回金额。', '未保存的修改', { confirmButtonText: '放弃修改', cancelButtonText: '继续编辑', type: 'warning' }); return true } catch { return false } }
async function closeEditor(done?: () => void) { if (await mayLeave()) { drawer.value = false; done?.() } }
async function exportRecords() { await action(async () => { const result = await api.exportAdvances(filter()); if (!result.canceled) ElMessage.success(`已导出 ${result.count} 笔垫付记录`) }) }
onBeforeRouteLeave(mayLeave)
function beforeUnload(event: BeforeUnloadEvent) { if (!dirty.value && !busy.value && !payment.value.amount && !payment.value.remark) return; event.preventDefault(); event.returnValue = ''; void mayLeave().then(leave => { if (leave) { drawer.value = false; window.close() } }) }
onMounted(() => { observer = new ResizeObserver(([entry]) => { compact.value = entry.contentRect.width < 1040 }); if (root.value) observer.observe(root.value); void load(); off = api.onDataChanged(() => void load()); window.addEventListener('beforeunload', beforeUnload) })
onBeforeUnmount(() => { observer?.disconnect(); loadVersion++; invoiceSearch++; off?.(); clearTimeout(searchTimer); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<style scoped>
.advances-page { min-width: 0; }.advance-toolbar, .advance-dates, .advance-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.advance-toolbar > .el-input { width: 260px; }.advance-toolbar > .el-select { width: 160px; }.advance-actions { margin-left: auto; }.advance-actions .el-button + .el-button { margin-left: 0; }.advance-dates { margin: 12px 0 18px; }.advance-dates > .el-select { width: 190px; }.advance-dates :deep(.el-date-editor) { flex: none; max-width: 100%; width: 280px; }.advance-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }.advance-summary > div { padding: 16px; }.advance-summary > div + div { border-left: 1px solid var(--border); }.advance-summary span { display: block; font-size: 12px; color: var(--muted); }.advance-summary strong { display: block; margin-top: 9px; font-size: 23px; font-weight: 500; font-variant-numeric: tabular-nums; }.advance-note { color: var(--muted); font-size: 12px; line-height: 1.6; }.advance-table { overflow: hidden; }.record-title { border: 0; padding: 0; background: transparent; color: var(--el-text-color-primary); text-align: left; cursor: pointer; font-weight: 500; overflow-wrap: anywhere; }.record-title:hover { color: var(--primary); }.project-tabs { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; font-size: 13px; }.project-tabs a { color: var(--muted); text-decoration: none; }.project-tabs span { color: var(--primary); }
.editor-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }.editor-columns .el-date-editor, .editor-columns .el-select { width: 100%; }.editor-section { border-top: 1px solid var(--border); padding-top: 18px; margin-top: 20px; }.section-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; font-size: 13px; }.section-toolbar > span, small { color: var(--muted); font-size: 11px; }.attachment-row, .return-row { display: flex; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 12px; }.attachment-row .el-button:first-child { flex: 1; min-width: 0; justify-content: flex-start; white-space: normal; height: auto; overflow-wrap: anywhere; text-align: left; }.return-row > span { flex: 1; }.return-row small { display: block; margin-top: 4px; }.return-form { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }.return-form .el-date-editor { width: 100%; }.advance-editor-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }.advance-editor-actions > .el-button:first-child { margin-right: auto; }.advance-editor-actions .el-button + .el-button { margin-left: 0; }.draft-note { color: var(--el-color-warning); font-size: 12px; }
@media(max-width: 1100px) { .advance-summary { grid-template-columns: 1fr 1fr; }.advance-summary > div:nth-child(3) { border-left: 0; }.advance-summary > div:nth-child(n+3) { border-top: 1px solid var(--border); }.advance-actions { margin-left: 0; } }
@media(max-width: 500px) { .editor-columns { grid-template-columns: 1fr; gap: 0; }.advance-summary strong { font-size: 19px; } }
</style>
