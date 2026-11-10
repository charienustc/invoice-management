<template><div class="panel advance-stats"><div class="advance-stats-heading"><strong>垫付情况</strong><RouterLink :to="{path: '/advances', query: projectQuery}">查看垫付记录</RouterLink></div><p>按当前项目与垫付日期统计；不受发票核对、状态筛选影响，与上方发票金额分开显示。</p><el-alert v-if="error" :title="error" type="error" :closable="false" /><div v-else class="advance-stats-values" v-loading="loading"><div v-for="item in items" :key="item.label"><span>{{ item.label }}</span><strong>¥ {{ formatMoney(item.value) }}</strong></div></div><small>收回不抵减支出。已补票不计入无票支出；发票删除、作废或变更项目、金额后，原关联不再抵扣无票支出。</small></div></template>
<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { StatsFilter } from '@shared/contracts'
import { api } from '@/api'
import { formatMoney } from '@shared/money'
import { errorMessage } from '@/utils'
const props = defineProps<{ filter: StatsFilter; revision: number }>()
const summary = ref({ amount: 0, remaining: 0, recovered: 0, unbilledAmount: 0 }), loading = ref(false), error = ref('')
const projectQuery = computed(() => ({ ...(props.filter.projectId === null ? { project: 'unassigned' } : props.filter.projectId ? { project: props.filter.projectId } : {}), dateFrom: props.filter.dateFrom, dateTo: props.filter.dateTo }))
const items = computed(() => [{label: '无票支出', value: summary.value.unbilledAmount}, {label: '垫付金额', value: summary.value.amount}, {label: '已收回', value: summary.value.recovered}, {label: '待收回', value: summary.value.remaining}])
let version = 0
watch(() => [props.filter, props.revision], async () => { const request = ++version; loading.value = true; try { const data = await api.listAdvances({projectId: props.filter.projectId, dateFrom: props.filter.dateFrom, dateTo: props.filter.dateTo}); if (request !== version) return; summary.value = data; error.value = '' } catch (reason) { if (request === version) error.value = errorMessage(reason) } finally { if (request === version) loading.value = false } }, {immediate: true})
onBeforeUnmount(() => version++)
</script>
<style scoped>
.advance-stats { margin-top: 16px; padding: 18px; }.advance-stats-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; font-size: 13px; }.advance-stats-heading a { color: var(--primary); text-decoration: none; font-size: 12px; }.advance-stats p, .advance-stats small { color: var(--muted); font-size: 11px; line-height: 1.6; }.advance-stats-values { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; margin: 18px 0; }.advance-stats-values span { color: var(--muted); font-size: 12px; }.advance-stats-values strong { display: block; margin-top: 9px; font-weight: 500; font-size: 21px; overflow-wrap: anywhere; }@media(max-width:1100px) {.advance-stats-values {grid-template-columns: 1fr 1fr;}}
</style>
