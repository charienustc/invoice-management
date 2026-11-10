<template>
  <div class="appearance-settings">
    <div class="appearance-grid">
      <div class="panel appearance-group"><h2>界面</h2>
        <div class="appearance-row"><div><label>颜色</label><small>保存后应用到整个界面</small></div><el-select v-model="form.colorMode" aria-label="颜色" :disabled="saving || disabled"><el-option label="浅色模式" value="light" /><el-option label="深色模式" value="dark" /><el-option label="跟随系统" value="system" /></el-select></div>
        <div class="appearance-row"><div><label>界面大小</label><small>调整文字和控件大小，保存后生效</small></div><el-select v-model="form.uiScale" aria-label="界面大小" :disabled="saving || disabled"><el-option v-for="scale in scales" :key="scale.value" :label="scale.label" :value="scale.value" /></el-select></div>
        <div class="appearance-row"><label>动效</label><el-select v-model="form.motion" aria-label="动效" :disabled="saving || disabled"><el-option label="跟随系统" value="system" /><el-option label="减少动态效果" value="reduce" /></el-select></div>
      </div>
      <div class="panel appearance-group"><h2>列表显示</h2>
        <div class="appearance-row"><label>列表密度</label><el-select v-model="form.density" aria-label="列表密度" :disabled="saving || disabled"><el-option label="标准" value="comfortable" /><el-option label="紧凑" value="compact" /></el-select></div>
        <div class="appearance-row"><label>默认每页条数</label><el-select v-model="form.pageSize" aria-label="默认每页条数" :disabled="saving || disabled"><el-option v-for="size in [10, 20, 50, 100]" :key="size" :label="`${size} 条`" :value="size" /></el-select></div>
      </div>
      <div class="panel appearance-preview" ><div class="preview-caption"><h2>预览</h2><span>{{ form.uiScale }}% · {{ form.density === 'compact' ? '紧凑' : '标准' }}列表</span></div>
        <div class="sample-table" :class="{ compact: form.density === 'compact' }" :style="{ '--preview-size': `${12 * form.uiScale / preferences.settings.uiScale}px` }" aria-label="列表外观预览">
          <div class="sample-row sample-header"><span>发票信息</span><span>开票日期</span><span>价税合计</span><span>状态</span></div>
          <div v-for="invoice in samples" :key="invoice.name" class="sample-row"><div><strong>{{ invoice.name }}</strong><small>{{ invoice.number }}</small></div><span>{{ invoice.date }}</span><span class="sample-money">{{ invoice.amount }}</span><span class="sample-state"><i />{{ invoice.status }}</span></div>
        </div>
      </div>
    </div>
    <div class="appearance-actions"><el-button :disabled="saving || disabled" @click="form = values(DEFAULT_APP_SETTINGS)">恢复默认值</el-button><span v-if="dirty" class="draft-note">有未保存的设置</span><el-button type="primary" :loading="saving" :disabled="!dirty || disabled" @click="save">保存外观设置</el-button></div>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { DEFAULT_APP_SETTINGS, type AppSettings } from '@shared/contracts'
import { usePreferencesStore } from '@/stores/preferences'
import { errorMessage } from '@/utils'
defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ dirty: [value: boolean]; saving: [value: boolean] }>()
type Appearance = Pick<AppSettings, 'density' | 'pageSize' | 'motion' | 'uiScale' | 'colorMode'>
function values(settings: AppSettings): Appearance { return { density: settings.density, pageSize: settings.pageSize, motion: settings.motion, uiScale: settings.uiScale, colorMode: settings.colorMode } }
const preferences = usePreferencesStore(), form = ref(values(DEFAULT_APP_SETTINGS)), baseline = ref(JSON.stringify(form.value)), saving = ref(false)
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
watch(dirty, (value) => emit('dirty', value))
watch(saving, (value) => emit('saving', value), { flush: 'sync' })
const scales = [{ value: 90, label: '90% · 较小' }, { value: 100, label: '100% · 默认' }, { value: 110, label: '110%' }, { value: 125, label: '125% · 较大' }]
const samples = [{ name: '办公用品', number: '260110028001', date: '2026-11-04', amount: '¥ 268.00', status: '已确认' }, { name: '差旅住宿', number: '260110028002', date: '2026-11-03', amount: '¥ 680.00', status: '已确认' }]
async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try { const saved = await preferences.save({ ...preferences.settings, ...form.value }); form.value = values(saved); baseline.value = JSON.stringify(form.value); ElMessage.success('外观设置已保存') }
  catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
onMounted(async () => { try { await preferences.load(); form.value = values(preferences.settings); baseline.value = JSON.stringify(form.value) } catch (error) { ElMessage.error(errorMessage(error)) } })
</script>
<style scoped>
.appearance-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }
.appearance-group { min-width: 0; padding: 4px clamp(14px, 2cqi, 24px); } h2 { font-size: 13px; font-weight: 600; margin: 0; padding: 16px 0 10px; }
.appearance-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 45%); align-items: center; gap: 16px; min-height: 58px; padding: 12px 0; font-size: 13px; }.appearance-row + .appearance-row { border-top: 1px solid light-dark(#f0f0f3, #393b43); }.appearance-row > * { min-width: 0; }.appearance-row small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.6; }.appearance-row :deep(.el-select) { width: 100%; }
.appearance-preview { grid-column: 1 / -1; min-width: 0; padding: 0 clamp(14px, 2cqi, 24px) 22px; }.preview-caption { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; justify-content: space-between; padding-bottom: 12px; }.preview-caption span { font-size: 11px; color: var(--muted); }
.sample-table { border: 1px solid light-dark(#e9eaf0, #393b43); border-radius: 8px; overflow: hidden; font-size: var(--preview-size); }.sample-row { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, .8fr); gap: 12px; align-items: center; padding: 16px; transition: padding 160ms var(--ease-out); }.sample-row + .sample-row { border-top: 1px solid light-dark(#f0f0f3, #393b43); }.sample-row > * { min-width: 0; overflow-wrap: anywhere; }.sample-header { font-size: .9em; color: light-dark(#9095a0, #b5b6c1); background: light-dark(#f8f9fb, #292a2f); padding-top: 10px; padding-bottom: 10px; }.sample-row strong { font-weight: 500; }.sample-row small { display: block; color: light-dark(#969ba5, #9395a1); margin-top: 5px; font-size: .86em; }.sample-money { font-variant-numeric: tabular-nums; }.sample-state { display: flex; align-items: center; gap: 5px; color: #4d8069; font-size: .9em; }.sample-state i { flex: none; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }.compact .sample-row:not(.sample-header) { padding-top: 9px; padding-bottom: 9px; }.compact .sample-row small { margin-top: 2px; }
.appearance-actions { position: sticky; bottom: -22px; z-index: 1; display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 14px 0; margin-top: 18px; background: light-dark(#ffffffee, #202124ee); backdrop-filter: blur(8px); border-top: 1px solid var(--border); }.appearance-actions .el-button:last-child { margin-left: auto; }.draft-note { font-size: 11px; color: #a47d35; }
@container settings (max-width: 1000px) { .appearance-grid { grid-template-columns: minmax(0, 1fr); } }
@container settings (max-width: 580px) { .appearance-row { grid-template-columns: minmax(0, 1fr); gap: 8px; }.sample-row { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr) minmax(0, 1fr); gap: 8px; padding-left: 10px; padding-right: 10px; }.sample-row > :nth-child(2) { display: none; } }
</style>
