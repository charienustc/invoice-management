<template>
  <div v-loading="loading" class="settings-shell">
    <div class="settings-tabs" role="tablist" aria-label="设置分类" :style="{ '--settings-tab-count': tabs.length }">
      <button v-for="tab in tabs" :id="`settings-tab-${tab.id}`" :key="tab.id" type="button" role="tab" :aria-selected="activeTab === tab.id" :aria-controls="`settings-panel-${tab.id}`" :disabled="saving || appearanceSaving || connectionSaving || changingDirectory" :class="{ active: activeTab === tab.id }" @click="selectTab(tab.id)">{{ tab.label }}</button>
    </div>
    <el-alert v-if="info?.preferencesWarning" :title="info.preferencesWarning" type="warning" :closable="false" class="preferences-warning" />

    <section v-show="activeTab === 'general'" id="settings-panel-general" role="tabpanel" aria-labelledby="settings-tab-general" class="general-settings">
      <div class="settings-grid">
      <div class="setting-group panel"><h2>启动与窗口</h2>
        <div class="setting-row switch-row"><div><label>开机启动</label><small>{{ info?.loginStartupSupported ? '登录 Windows 后自动启动' : '在 Windows 安装版中可用' }}</small></div><el-switch v-model="general.openAtLogin" aria-label="开机启动" :disabled="!info?.loginStartupSupported" /></div>
        <div class="setting-row"><label>启动页面</label><el-select v-model="general.startupPage" aria-label="启动页面"><el-option label="发票管理" value="invoices" /><el-option label="统计分析" value="stats" /></el-select></div>
        <div class="setting-row switch-row"><label>记住窗口大小和位置</label><el-switch v-model="general.rememberWindowState" aria-label="记住窗口大小和位置" /></div>
        <div class="setting-row switch-row"><label>启动时展开侧栏</label><el-switch v-model="general.sidebarExpanded" aria-label="启动时展开侧栏" /></div>
      </div>
      <div class="setting-group panel"><h2>导入</h2>
        <div class="setting-row switch-row"><div><label>导入后自动识别</label><small>关闭后保留为待识别，可手动重新识别</small></div><el-switch v-model="general.autoRecognize" aria-label="导入后自动识别" /></div>
        <div class="setting-row"><div><label>默认项目</label><small>在项目中导入时，优先归入当前项目</small></div><el-select v-model="general.defaultProjectId" aria-label="默认项目" filterable><el-option label="未分配" :value="''" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select></div>
      </div>
      </div>
      <div class="general-actions"><el-button :disabled="saving || appearanceSaving" @click="resetGeneral">恢复默认值</el-button><span v-if="generalDirty" class="draft-note">有未保存的设置</span><el-button type="primary" :loading="saving" :disabled="appearanceSaving || (!generalDirty && !info?.preferencesWarning)" @click="saveGeneral">保存通用设置</el-button></div>
    </section>
    <section v-show="activeTab === 'appearance'" id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance"><AppearanceSettingsPanel v-if="visitedAppearance" :disabled="saving" @dirty="appearanceDirty = $event" @saving="appearanceSaving = $event" /></section>

    <section v-show="activeTab === 'ocr'" id="settings-panel-ocr" role="tabpanel" aria-labelledby="settings-tab-ocr"><OcrSettingsPanel v-if="visitedOcr" @dirty="ocrDirty = $event" /></section>
    <section v-show="activeTab === 'connections'" id="settings-panel-connections" role="tabpanel" aria-labelledby="settings-tab-connections"><McpSettingsPanel v-if="visitedConnections" :disabled="saving || appearanceSaving" @dirty="connectionDirty = $event" @saving="connectionSaving = $event" /></section>

    <section v-show="activeTab === 'data'" id="settings-panel-data" role="tabpanel" aria-labelledby="settings-tab-data" class="data-settings">
      <div class="settings-grid">
      <div class="setting-group panel"><h2>数据存储</h2>
        <div class="storage-location"><span>{{ info?.dataDirectory || '正在读取…' }}</span><el-button @click="openDirectory">打开数据文件夹</el-button></div>
        <div class="storage-controls"><el-button :loading="changingDirectory" :disabled="storageDisabled" @click="changeDirectory('select')">更改目录</el-button><el-button :disabled="storageDisabled || info?.dataDirectory === info?.defaultDataDirectory" @click="changeDirectory('default')">恢复默认目录</el-button></div>
        <p class="settings-description">默认位置：{{ info?.defaultDataDirectory || '正在读取…' }}<br />更改后迁移发票、垫付及凭证，校验完成后重启；原数据保留。请选择空文件夹。</p>
        <div class="storage-summary"><div><strong>{{ info?.invoiceCount ?? '—' }}</strong><span>发票</span></div><div><strong>{{ info?.trashCount ?? '—' }}</strong><span>回收站</span></div><div><strong>{{ formatBytes(info?.originalBytes) }}</strong><span>原件大小</span></div></div>
      </div>
      <div class="setting-group panel"><h2>备份与恢复</h2><p class="settings-description">备份包含发票、原文件、垫付记录及凭证、收回明细、项目、标签和识别记录。恢复会替换现有数据，恢复前会自动备份并重启。应用设置保持不变。</p>
        <div class="backup-actions"><el-button :loading="backingUp" :disabled="restoring || changingDirectory" @click="createBackup">创建备份</el-button><el-button :loading="restoring" :disabled="backingUp || changingDirectory" @click="restoreBackup">恢复备份</el-button></div>
        <p v-if="backupPath" class="backup-path">备份位置：{{ backupPath }}</p>
      </div>
      </div>
    </section>

    <section v-show="activeTab === 'about'" id="settings-panel-about" role="tabpanel" aria-labelledby="settings-tab-about" class="about-settings">
      <div class="settings-grid">
      <div class="setting-group panel"><h2>发票管理</h2><div class="setting-row"><span>版本</span><span>{{ info?.version || '—' }}</span></div><div class="setting-row"><span>运行平台</span><span>{{ info?.platform }} / {{ info?.arch }}</span></div><div class="setting-row"><span>Electron</span><span>{{ info?.electronVersion || '—' }}</span></div></div>
      <div class="setting-group panel"><h2>快捷键</h2><div v-for="shortcut in shortcuts" :key="shortcut.keys" class="setting-row"><span>{{ shortcut.label }}</span><kbd>{{ shortcut.keys }}</kbd></div></div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DEFAULT_APP_SETTINGS, type ApplicationInfo, type AppSettings } from '@shared/contracts'
import { api } from '@/api'
import { usePreferencesStore } from '@/stores/preferences'
import { useProjectStore } from '@/stores/projects'
import { errorMessage } from '@/utils'
import OcrSettingsPanel from '@/components/OcrSettingsPanel.vue'
import AppearanceSettingsPanel from '@/components/AppearanceSettingsPanel.vue'
import McpSettingsPanel from '@/components/McpSettingsPanel.vue'
const visitedConnections = ref(false), connectionDirty = ref(false), connectionSaving = ref(false)
const visitedAppearance = ref(false), appearanceDirty = ref(false), appearanceSaving = ref(false)
const tabs = [{ id: 'general', label: '通用' }, { id: 'appearance', label: '外观' }, { id: 'ocr', label: '识别服务' }, { id: 'connections', label: '连接' }, { id: 'data', label: '数据' }, { id: 'about', label: '关于' }] as const
type Tab = typeof tabs[number]['id']
const activeTab = ref<Tab>('general'), visitedOcr = ref(false), ocrDirty = ref(false)
const preferences = usePreferencesStore(), projects = useProjectStore()
const general = ref<Omit<AppSettings, 'defaultProjectId'> & { defaultProjectId: string }>({ ...DEFAULT_APP_SETTINGS, defaultProjectId: '' })
const baseline = ref(JSON.stringify(general.value)), info = ref<ApplicationInfo>()
const loading = ref(true), saving = ref(false)
const generalDirty = computed(() => JSON.stringify(general.value) !== baseline.value)
function applyGeneral(settings: AppSettings): void { general.value = { ...settings, defaultProjectId: settings.defaultProjectId ?? '' }; baseline.value = JSON.stringify(general.value) }
async function loadInfo(): Promise<void> { try { info.value = await api.getApplicationInfo() } catch (error) { ElMessage.error(errorMessage(error)) } }
function selectTab(tab: Tab): void { activeTab.value = tab; if (tab === 'appearance') visitedAppearance.value = true; if (tab === 'ocr') visitedOcr.value = true; if (tab === 'connections') visitedConnections.value = true; if (tab === 'data' || tab === 'about') void loadInfo() }
function generalValues(settings: typeof general.value): Pick<AppSettings, 'openAtLogin' | 'startupPage' | 'rememberWindowState' | 'sidebarExpanded' | 'autoRecognize' | 'defaultProjectId'> { return { openAtLogin: settings.openAtLogin, startupPage: settings.startupPage, rememberWindowState: settings.rememberWindowState, sidebarExpanded: settings.sidebarExpanded, autoRecognize: settings.autoRecognize, defaultProjectId: settings.defaultProjectId || null } }
function resetGeneral(): void { general.value = { ...general.value, ...generalValues({ ...DEFAULT_APP_SETTINGS, defaultProjectId: '' }), defaultProjectId: '' } }
async function saveGeneral(): Promise<void> {
  if (saving.value) return
  saving.value = true
  try { applyGeneral(await preferences.save({ ...preferences.settings, ...generalValues(general.value) })); await loadInfo(); ElMessage.success('通用设置已保存') }
  catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
watch(() => projects.items, (items) => { if (general.value.defaultProjectId && !items.some((project) => project.id === general.value.defaultProjectId)) general.value.defaultProjectId = '' })
const changingDirectory = ref(false), migrationReady = ref(false)
const storageDisabled = computed(() => changingDirectory.value || backingUp.value || restoring.value || saving.value || appearanceSaving.value || connectionSaving.value || generalDirty.value || ocrDirty.value || appearanceDirty.value || connectionDirty.value)
async function changeDirectory(mode: 'select' | 'default'): Promise<void> {
  changingDirectory.value = true
  let restarting = false
  try { const result = await api.changeDataDirectory(mode); if (!result.canceled) { restarting = true; migrationReady.value = true; ElMessage.success('数据迁移完成，正在重启') } }
  catch (error) { ElMessage.error(errorMessage(error)) }
  finally { if (!restarting) changingDirectory.value = false }
}
const backingUp = ref(false), restoring = ref(false), backupPath = ref('')
async function createBackup(): Promise<void> {
  backingUp.value = true
  try { const result = await api.createBackup(); if (!result.canceled) { backupPath.value = result.path ?? ''; ElMessage.success('备份已完成') } }
  catch (error) { ElMessage.error(errorMessage(error)) } finally { backingUp.value = false }
}
async function restoreBackup(): Promise<void> {
  restoring.value = true
  try { const result = await api.restoreBackup(); if (!result.canceled) { backupPath.value = result.safetyBackupPath ?? ''; ElMessage.success('备份校验通过，即将重启恢复') } }
  catch (error) { ElMessage.error(errorMessage(error)) } finally { restoring.value = false }
}
async function openDirectory(): Promise<void> { try { await api.openDataDirectory() } catch (error) { ElMessage.error(errorMessage(error)) } }
function formatBytes(bytes?: number): string { if (bytes === undefined) return '—'; if (bytes < 1024) return `${bytes} B`; if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`; return `${(bytes / 1024 ** 2).toFixed(1)} MB` }
const shortcuts = [{ label: '搜索发票', keys: 'Ctrl + F' }, { label: '导入发票', keys: 'Ctrl + O' }, { label: '预览选中发票', keys: '空格' }, { label: '校对选中发票', keys: 'Enter' }, { label: '保存校正', keys: 'Ctrl + S' }, { label: '确认发票', keys: 'Ctrl + Enter' }, { label: '切换侧栏', keys: 'Ctrl + \\' }]
let leaving: Promise<boolean> | undefined
async function confirmLeave(): Promise<boolean> {
  if (saving.value || appearanceSaving.value || connectionSaving.value || changingDirectory.value) return false
  if (!generalDirty.value && !ocrDirty.value && !appearanceDirty.value && !connectionDirty.value) return true
  return leaving ??= ElMessageBox.confirm('设置尚未保存。是否放弃修改并离开？', '未保存的设置', { confirmButtonText: '放弃修改', cancelButtonText: '继续设置', type: 'warning' }).then(() => true, () => false).finally(() => { leaving = undefined })
}
onBeforeRouteLeave(confirmLeave)
function beforeUnload(event: BeforeUnloadEvent): void {
  if (migrationReady.value) return
  if (!generalDirty.value && !ocrDirty.value && !appearanceDirty.value && !connectionDirty.value && !saving.value && !appearanceSaving.value && !connectionSaving.value && !changingDirectory.value) return
  event.preventDefault(); event.returnValue = ''
  void confirmLeave().then((leave) => { if (leave) { baseline.value = JSON.stringify(general.value); ocrDirty.value = false; appearanceDirty.value = false; connectionDirty.value = false; window.close() } })
}
onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload)
  try { await Promise.all([preferences.load(true), loadInfo()]); applyGeneral(preferences.settings) } catch (error) { ElMessage.error(errorMessage(error)) } finally { loading.value = false }
})
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<style scoped>
.settings-shell { width: 100%; min-width: 0; container: settings / inline-size; }
.settings-tabs { display: grid; grid-template-columns: repeat(var(--settings-tab-count), minmax(0, 1fr)); width: min(100%, 42rem); padding: 3px; gap: 2px; border: 1px solid light-dark(#e5e5e9, #393b43); border-radius: 9px; background: light-dark(#eeeef2, #292a2f); margin-bottom: 22px; }
.settings-tabs button { min-width: 0; min-height: 32px; padding: 7px 10px; border: 0; background: transparent; border-radius: 6px; color: light-dark(#777782, #b5b6c1); cursor: pointer; font-size: 12px; transition: background 150ms, box-shadow 150ms; }
.settings-tabs button.active { background: light-dark(#fff, #242529); color: light-dark(#30303a, #e4e4eb); box-shadow: 0 1px 4px #00000012; }
.general-settings, .data-settings, .about-settings { width: 100%; min-width: 0; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: start; gap: 18px; }
.setting-group { min-width: 0; padding: 4px clamp(14px, 2cqi, 24px); }
.setting-group h2 { font-size: 13px; font-weight: 600; margin: 0; padding: 15px 0 10px; }
.setting-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 45%); align-items: center; gap: 16px; min-height: 56px; padding: 12px 0; font-size: 13px; }
.setting-row > * { min-width: 0; overflow-wrap: anywhere; }.switch-row { grid-template-columns: minmax(0, 1fr) auto; }.about-settings .setting-row { grid-template-columns: minmax(0, 1fr) auto; }
.setting-row + .setting-row { border-top: 1px solid light-dark(#f0f0f3, #393b43); }
.setting-row small { display: block; color: var(--muted); font-size: 11px; margin-top: 5px; line-height: 1.5; }
.setting-row :deep(.el-select) { width: 100%; }
.setting-row :deep(.el-switch) { flex: none; }
.general-actions { position: sticky; bottom: -22px; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 14px 0; margin-top: 18px; border-top: 1px solid var(--border); background: light-dark(#ffffffee, #202124ee); backdrop-filter: blur(8px); }
.general-actions .el-button:last-child { margin-left: auto; }
.draft-note { font-size: 11px; color: #a47d35; }
.storage-location { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0 18px; }
.storage-location span { flex: 1 1 60%; color: var(--muted); font: 12px/1.6 Consolas, monospace; overflow-wrap: anywhere; min-width: 0; }
.storage-location .el-button { flex: none; }
.storage-summary { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; padding: 16px 0; border-top: 1px solid var(--border); }.storage-summary > div { min-width: 0; overflow-wrap: anywhere; }
.storage-summary strong, .storage-summary span { display: block; }
.storage-summary strong { font-size: 20px; font-weight: 500; font-variant-numeric: tabular-nums; }
.storage-summary span { color: var(--muted); font-size: 11px; margin-top: 6px; }
.settings-description { font-size: 12px; color: var(--muted); line-height: 1.9; margin: 4px 0 16px; }
.backup-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 18px; }
.backup-actions .el-button + .el-button { margin-left: 0; }
.backup-path { font-size: 11px; color: var(--primary); overflow-wrap: anywhere; line-height: 1.8; }
.preferences-warning { margin-bottom: 16px; }
kbd { font: 11px Consolas, monospace; color: light-dark(#777782, #b5b6c1); background: light-dark(#f4f4f7, #292a2f); border: 1px solid light-dark(#e8e8ec, #393b43); border-radius: 4px; padding: 4px 7px; }
@container settings (max-width: 1000px) { .settings-grid { grid-template-columns: minmax(0, 1fr); } }
@container settings (max-width: 580px) { .setting-row:not(.switch-row) { grid-template-columns: minmax(0, 1fr); gap: 8px; }.about-settings .setting-row { grid-template-columns: minmax(0, 1fr) auto; }.settings-tabs button { padding-left: 5px; padding-right: 5px; } }
</style>

<style scoped>
.storage-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }.storage-controls .el-button + .el-button { margin-left: 0; }
</style>
