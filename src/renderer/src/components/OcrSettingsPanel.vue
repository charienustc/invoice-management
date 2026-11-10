<template>
  <div class="settings-layout">
    <div class="panel settings-panel">
      <div class="settings-title"><h2>发票识别</h2></div>
      <el-form-item label="识别方式" class="engine-choice">
        <el-select v-model="form.engineMode" aria-label="识别方式" :disabled="loading || testing || starting || saving"><el-option label="内置 OCR" value="builtin" /><el-option label="外部 OCR 服务" value="external" /></el-select>
      </el-form-item>
      <div v-if="form.engineMode === 'builtin'" class="engine-details"><strong>PP-OCRv6 small</strong><span>在本机识别，无需配置。首次识别时加载模型。</span></div>
      <div v-if="form.engineMode === savedEngineMode" class="service-status" :data-state="serviceStatus.state">
        <span class="service-status-dot" />
        <div class="service-status-text"><strong>{{ form.engineMode === 'builtin' && serviceStatus.state === 'offline' ? '待命' : statusMeta[serviceStatus.state].text }}</strong><span>{{ serviceStatus.message }}</span></div>
        <span v-if="serviceStatus.pid" class="service-pid">PID {{ serviceStatus.pid }}</span>
        <el-button size="small" :loading="checking" @click="checkStatus()">重新检测</el-button>
        <el-button v-if="!['online', 'starting', 'checking'].includes(serviceStatus.state)" size="small" type="primary" :loading="starting" @click="startService">立即启动</el-button>
      </div>
      <el-form v-loading="loading" :model="form" label-position="top" @submit.prevent>
        <template v-if="form.engineMode === 'external'">
        <h3 class="section-heading">连接配置</h3>
        <el-form-item label="服务地址" required><el-input v-model="form.endpoint" placeholder="http://127.0.0.1:8080/ocr" clearable><template #prepend>POST</template></el-input><div class="field-help">本机 PaddleX 默认使用 http://127.0.0.1:8080/ocr，健康检测使用同地址的 /health。</div></el-form-item>
        <h3 class="section-heading">自动启动</h3>
        <div class="autostart-title"><div><strong>启动软件时启动 OCR 服务</strong><span>检测到已有服务时不会重复启动。</span></div><el-switch v-model="form.autoStart" aria-label="启动软件时启动 OCR 服务" /></div>
        <template v-if="form.autoStart">
          <el-form-item label="启动程序绝对路径" required><el-input v-model="form.startupExecutable" placeholder="选择 PaddleX 或服务启动程序"><template #append><el-button :icon="FolderOpened" aria-label="选择启动程序" @click="selectPath('executable')" /></template></el-input></el-form-item>
          <el-form-item label="启动参数（每行一个参数）"><el-input v-model="startupArgsText" class="args-input" type="textarea" :rows="5" placeholder="--pipeline&#10;OCR&#10;--serve&#10;--host&#10;127.0.0.1&#10;--port&#10;8080" /></el-form-item>
          <div class="ocr-fields wide-first">
            <el-form-item label="工作目录（可留空）"><el-input v-model="form.startupWorkingDirectory" placeholder="留空则使用应用当前目录"><template #append><el-button :icon="FolderOpened" aria-label="选择工作目录" @click="selectPath('directory')" /></template></el-input></el-form-item>
            <el-form-item label="启动等待超时（毫秒）"><el-input-number v-model="form.startupTimeoutMs" :min="10000" :max="600000" :step="10000" :controls="false" /></el-form-item>
          </div>
        </template>
        </template>
        <el-collapse class="advanced-settings"><el-collapse-item :title="form.engineMode === 'builtin' ? '高级参数 · 超时与重试' : '高级参数 · 协议、超时与重试'" name="advanced">
        <div class="ocr-fields">
          <el-form-item v-if="form.engineMode === 'external'" label="请求协议"><el-select v-model="form.requestProtocol"><el-option label="PaddleX 原生 JSON + Base64" value="paddlex-json" /><el-option label="multipart 文件上传" value="multipart" /></el-select></el-form-item>
          <el-form-item v-if="form.engineMode === 'external'" label="响应适配器"><el-select v-model="form.adapter"><el-option label="自动识别常见结构" value="auto" /><el-option label="PaddleOCR / PaddleX" value="paddle" /><el-option label="通用 lines 结构" value="lines" /></el-select></el-form-item>
          <el-form-item v-if="form.engineMode === 'external' && form.requestProtocol === 'multipart'" label="文件字段名" required><el-input v-model="form.fileField" placeholder="file" /></el-form-item>
          <el-form-item label="请求超时（毫秒）"><el-input-number v-model="form.timeoutMs" :min="1000" :max="120000" :step="1000" :controls="false" /></el-form-item>
          <el-form-item v-if="form.engineMode === 'external'" label="OCR 并发数"><el-input-number v-model="form.concurrency" :min="1" :max="3" /></el-form-item>
          <el-form-item label="自动重试次数"><el-input-number v-model="form.maxRetries" :min="0" :max="5" /></el-form-item>
        </div>

        </el-collapse-item></el-collapse>
        <el-alert v-if="testResult" :title="`测试成功：返回 ${testResult.lineCount} 行文本，用时 ${testResult.durationMs} ms`" type="success" :closable="false" show-icon class="test-result" />
        <div class="settings-actions"><el-button :loading="testing" :disabled="form.engineMode === 'external' && !form.endpoint" @click="testConnection">{{ form.engineMode === 'builtin' ? '测试内置 OCR' : '测试 OCR 请求' }}</el-button><el-button type="primary" :loading="saving" @click="save">保存设置</el-button></div>
      </el-form>
    </div>
    <aside class="panel help-panel"><h3>{{ form.engineMode === 'builtin' ? '本机识别' : '接入说明' }}</h3><template v-if="form.engineMode === 'builtin'"><p class="backup-help">模型随应用安装，可离线使用。批量导入时逐张处理，避免同时占用过多内存。</p><p class="backup-help">识别结果仍需核对，可在发票详情中直接修改。</p></template><template v-else><p class="backup-help">支持 PaddleX 和兼容的 HTTP 服务。自动启动仅支持本机地址。</p><p class="backup-help">使用远程服务时，发票图片会发送至所填地址。</p></template><p class="backup-help">测试使用空白图片。</p></aside>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { DEFAULT_OCR_SETTINGS, type OcrConnectionResult, type OcrServiceState, type OcrServiceStatus, type OcrSettings } from '@shared/contracts'
import { api } from '@/api'
import { FolderOpened } from '@element-plus/icons-vue'
import { errorMessage } from '@/utils'

const emit = defineEmits<{ dirty: [value: boolean] }>()
const baseline = ref('')
const form = ref<OcrSettings>({ ...DEFAULT_OCR_SETTINGS, startupArgs: [...DEFAULT_OCR_SETTINGS.startupArgs] })
const startupArgsText = ref(DEFAULT_OCR_SETTINGS.startupArgs.join('\n'))
const savedEngineMode = ref<OcrSettings['engineMode']>('builtin')
const dirty = computed(() => !!baseline.value && JSON.stringify({ form: form.value, args: startupArgsText.value }) !== baseline.value)
watch(dirty, (value) => emit('dirty', value))
async function selectPath(kind: 'executable' | 'directory'): Promise<void> {
  try { const path = await api.selectOcrPath(kind); if (path !== null) { if (kind === 'executable') form.value.startupExecutable = path; else form.value.startupWorkingDirectory = path } } catch (error) { ElMessage.error(errorMessage(error)) }
}
const serviceStatus = ref<OcrServiceStatus>({ state: 'unconfigured', message: '尚未检测', managedByApp: false })
const loading = ref(false)
const saving = ref(false)
const testing = ref(false)
const checking = ref(false)
const starting = ref(false)
const testResult = ref<OcrConnectionResult>()
watch(() => form.value.engineMode, () => { testResult.value = undefined })
const statusMeta: Record<OcrServiceState, { text: string }> = {
  unconfigured: { text: '未配置' }, checking: { text: '检测中' }, starting: { text: '启动中' },
  online: { text: '服务在线' }, offline: { text: '服务离线' }, error: { text: '启动失败' },
}
let pollTimer: ReturnType<typeof setInterval> | undefined
let disposed = false

function prepareSettings(): void {
  form.value.startupArgs = startupArgsText.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}
function applySettings(settings: OcrSettings): void {
  form.value = settings
  savedEngineMode.value = settings.engineMode
  startupArgsText.value = settings.startupArgs.join('\n')
  baseline.value = JSON.stringify({ form: form.value, args: startupArgsText.value })
}
async function load(): Promise<void> {
  loading.value = true
  try { applySettings(await api.getSettings()) } catch (error) { ElMessage.error(errorMessage(error)) } finally { loading.value = false }
}
async function checkStatus(showLoading = true): Promise<void> {
  if (showLoading) checking.value = true
  try { serviceStatus.value = await api.getOcrServiceStatus() } catch (error) { if (showLoading) ElMessage.error(errorMessage(error)) } finally { checking.value = false }
}
async function save(): Promise<void> {
  saving.value = true
  prepareSettings()
  try {
    applySettings(await api.saveSettings(form.value))
    testResult.value = undefined
    ElMessage.success('OCR 设置已保存')
    await checkStatus(false)
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
async function startService(): Promise<void> {
  starting.value = true
  prepareSettings()
  try {
    applySettings(await api.saveSettings(form.value))
    serviceStatus.value = await api.startOcrService(form.value)
    ElMessage.success('OCR 已就绪')
  } catch (error) {
    ElMessage.error(errorMessage(error))
    await checkStatus(false)
  } finally { starting.value = false }
}
async function testConnection(): Promise<void> {
  testing.value = true
  testResult.value = undefined
  prepareSettings()
  try { testResult.value = await api.testOcrConnection(form.value); await checkStatus(false) } catch (error) { ElMessage.error(errorMessage(error)) } finally { testing.value = false }
}
onMounted(async () => {
  await load()
  await checkStatus(false)
  if (disposed) return
  pollTimer = setInterval(() => void checkStatus(false), 5000)
})
onBeforeUnmount(() => { disposed = true; if (pollTimer) clearInterval(pollTimer) })
</script>

<style scoped>
.backup-help { font-size: 12px; color: var(--muted); line-height: 1.8; margin: -8px 0 16px; }
.backup-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.backup-actions .el-button + .el-button { margin-left: 0; }
.backup-path { font-size: 11px; color: var(--primary); overflow-wrap: anywhere; line-height: 1.7; }
.settings-layout { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 1fr); gap: 18px; }
.settings-panel { min-width: 0; container: ocr-form / inline-size; padding: 20px clamp(14px, 2cqi, 26px) 0; }
.ocr-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 18px; }.ocr-fields > * { min-width: 0; }.wide-first { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
@container settings (max-width: 1050px) { .settings-layout { grid-template-columns: minmax(0, 1fr); } }
@container ocr-form (max-width: 650px) { .ocr-fields { grid-template-columns: minmax(0, 1fr); } }
.settings-title { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
.settings-title h2 { margin: 0; font-size: 14px; }
.engine-choice :deep(.el-select) { width: min(100%, 360px); }
.engine-details { display: flex; flex-direction: column; gap: 5px; margin: 4px 0 18px; font-size: 12px; }
.engine-details span { color: var(--muted); line-height: 1.6; }
.service-status { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; padding: 0 0 16px; border-bottom: 1px solid var(--border); }
.service-status-dot { width: 9px; height: 9px; flex: none; border-radius: 50%; background: light-dark(#a1a9b8, #363840); }
.service-status[data-state="online"] .service-status-dot { background: #2ba77a; box-shadow: 0 0 0 4px #2ba77a18; }
.service-status[data-state="starting"] .service-status-dot, .service-status[data-state="checking"] .service-status-dot { background: #d3922f; box-shadow: 0 0 0 4px #d3922f18; }
.service-status[data-state="error"] .service-status-dot { background: #d95757; }
.service-status-text { flex: 1 1 14rem; min-width: 0; overflow-wrap: anywhere; }
.service-status-text strong, .service-status-text span { display: block; }
.service-status-text strong { color: var(--el-text-color-primary); font-size: 13px; }
.service-status-text span { margin-top: 3px; color: var(--muted); font-size: 11px; }
.service-pid { color: light-dark(#8a94a7, #b5b6c1); font: 11px Consolas, monospace; }
.settings-panel :deep(.el-form-item__label) { color: var(--el-text-color-regular); font-size: 12px; height: auto; line-height: 1.6; }
.settings-panel :deep(.el-select), .settings-panel :deep(.el-input-number), .settings-panel :deep(.el-input), .settings-panel :deep(.el-textarea) { width: 100%; max-width: 100%; min-width: 0; }
.settings-panel :deep(.el-form-item__content) { min-width: 0; }
.field-help { margin-top: 6px; color: var(--muted); font-size: 11px; line-height: 1.7; overflow-wrap: anywhere; }
.autostart-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.autostart-title > div { min-width: 0; }.autostart-title :deep(.el-switch) { flex: none; }.autostart-title strong, .autostart-title span { display: block; }
.autostart-title strong { color: var(--el-text-color-regular); font-size: 13px; }
.autostart-title span { margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.6; }
.args-input :deep(textarea) { font: 12px/1.6 Consolas, monospace; }
.advanced-settings { margin: 26px 0; --el-collapse-header-bg-color: transparent; --el-collapse-content-bg-color: transparent; --el-collapse-border-color: var(--border); --el-collapse-content-text-color: var(--el-text-color-regular); }
.advanced-settings :deep(.el-collapse-item__header) { border-radius: 6px; transition: background-color 100ms var(--ease-out); }
.advanced-settings :deep(.el-collapse-item__header:hover) { background-color: light-dark(#f6f7f9, #2b2c32); }
.settings-actions { position: sticky; bottom: -22px; background: light-dark(#fff, #242529); z-index: 2; padding-bottom: 16px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); }
.test-result { margin-top: 8px; }
.help-panel { min-width: 0; align-self: start; padding: 16px; }
.help-panel h3 { margin: 0 0 16px; font-size: 14px; }
</style>
