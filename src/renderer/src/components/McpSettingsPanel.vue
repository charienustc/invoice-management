<template>
  <div class="mcp-settings" v-loading="loading">
    <div class="mcp-grid">
      <div class="panel mcp-group"><div class="group-heading"><h2>MCP 服务</h2><span class="connection-state" :data-state="status?.state"><i />{{ status?.state === 'running' ? '运行中' : status?.state === 'error' ? '启动失败' : '已关闭' }}</span></div>
        <el-alert v-if="status?.error || status?.warning" :title="status.error || status.warning" type="warning" :closable="false" />
        <div class="mcp-row switch-row"><div><label>启用 MCP 服务</label><small>应用打开时，允许 agent 通过本机连接调用工具</small></div><el-switch v-model="form.enabled" aria-label="启用 MCP 服务" :disabled="saving || disabled" /></div>
        <div class="mcp-row"><div><label>本机端口</label><small>仅监听 127.0.0.1</small></div><el-input-number v-model="form.port" aria-label="MCP 本机端口" :min="1024" :max="65535" :controls="false" :disabled="saving || disabled" /></div>
        <div class="mcp-row switch-row"><div><label>允许 agent 修改数据</label><small>开启后可修改字段、项目、标签和审核状态</small></div><el-switch v-model="form.allowWrites" aria-label="允许 agent 修改数据" :disabled="saving || disabled" /></div>
        <div class="connection-address"><span>服务地址</span><code>{{ status?.url }}</code></div>
      </div>
      <div class="panel mcp-group"><h2>连接 agent</h2><p class="mcp-description">支持标准 MCP 的本机客户端均可接入。选择 HTTP 或 stdio，连接时保持本应用打开。</p>
        <el-select v-model="clientType" aria-label="MCP 配置格式" class="client-select"><el-option v-for="client in clients" :key="client.value" :label="client.label" :value="client.value" /></el-select>
        <p class="mcp-description">{{ descriptions[clientType] }}</p>
        <div v-if="clientType === 'http'" class="manual-connection"><span>地址 <code>{{ status?.url }}</code></span><span>请求头 <code>Authorization: Bearer &lt;访问令牌&gt;</code></span><div class="connection-actions"><el-button size="small" :disabled="!canConnect" @click="copy('url')">复制地址</el-button><el-button size="small" :disabled="!canConnect" @click="copy('authorization')">复制 Authorization 值</el-button></div></div>
        <div class="connection-actions"><el-button type="primary" :disabled="status?.state !== 'running' || dirty" @click="copy(clientType)">复制连接配置</el-button><el-button :disabled="status?.state !== 'running' || dirty" @click="preview">{{ showingConfig ? '收起配置' : '查看配置' }}</el-button></div>
        <template v-if="showingConfig && connection"><pre class="config-preview">{{ connection[clientType].replaceAll(connection.token, '&lt;访问令牌&gt;') }}</pre><p class="mcp-description">预览已隐藏令牌，复制时包含完整令牌。</p></template>
        <div v-if="clientType === 'stdio'" class="connection-actions stdio-actions"><el-button size="small" :disabled="!canConnect" @click="copy('command')">复制命令</el-button><el-button size="small" :disabled="!canConnect" @click="copy('args')">复制参数</el-button><el-button size="small" :disabled="!canConnect" @click="copy('env')">复制环境变量</el-button></div>
        <p class="mcp-description connection-scope">仅限本机连接。云端 agent 无法直接访问此地址；仅支持旧版 SSE 的客户端请改用 stdio。配置文件的外层格式以客户端要求为准。</p>
        <div class="token-actions"><span>访问令牌</span><el-button size="small" :disabled="dirty || saving || disabled" @click="copy('token')">复制令牌</el-button><el-button size="small" :disabled="dirty || saving || disabled" @click="rotate">重置令牌</el-button></div><p class="mcp-description">重置令牌后，已有客户端需要更新连接配置。</p>
      </div>
      <div class="panel mcp-group tool-group"><div class="group-heading"><h2>可用工具</h2><span class="tool-count">{{ status?.tools.length ?? 0 }} 项 · {{ status?.settings.allowWrites ? '允许修改' : '只读' }}</span></div>
        <div class="tools-list"><div v-for="tool in status?.tools" :key="tool.name" class="tool-row"><span class="tool-kind" :class="{ writable: tool.writable }">{{ tool.writable ? '修改' : '查询' }}</span><div><strong>{{ tool.title }}</strong><code>{{ tool.name }}</code></div></div></div>
        <div class="mcp-activity"><span>工具调用 {{ status?.requestCount ?? 0 }} 次</span><span v-if="status?.lastCall">最近：{{ status.lastCall.tool }} · {{ status.lastCall.success ? '成功' : '失败' }} · {{ new Date(status.lastCall.time).toLocaleTimeString('zh-CN') }}</span></div>
      </div>
    </div>
    <div class="mcp-actions"><span v-if="dirty" class="draft-note">有未保存的设置</span><el-button type="primary" :loading="saving" :disabled="disabled || (!dirty && !status?.warning && status?.state !== 'error')" @click="save">{{ status?.state === 'error' && !dirty ? '保存并重试' : '保存连接设置' }}</el-button></div>
  </div>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { DEFAULT_MCP_SETTINGS, mcpSettingsSchema, type McpSettings, type McpStatus, type McpConnectionFormat } from '@shared/mcp'
import { api } from '@/api'
import { errorMessage } from '@/utils'
defineProps<{ disabled: boolean }>()
const emit = defineEmits<{ dirty: [value: boolean]; saving: [value: boolean] }>()
const form = ref<McpSettings>({ ...DEFAULT_MCP_SETTINGS }), baseline = ref(JSON.stringify(form.value)), status = ref<McpStatus>(), loading = ref(true), saving = ref(false)
const clientType = ref<'http' | 'stdio' | 'desktop' | 'code'>('http'), showingConfig = ref(false), connection = ref<Awaited<ReturnType<typeof api.getMcpConnection>>>()
const clients = [{ value: 'http', label: '通用 HTTP' }, { value: 'stdio', label: '通用 stdio' }, { value: 'desktop', label: 'Claude Desktop 示例' }, { value: 'code', label: 'Claude Code 示例' }]
const descriptions = {
  http: '选择 Streamable HTTP，填写服务地址，并添加 Authorization 请求头。JSON 为单个服务配置，可按客户端格式放入对应位置。',
  stdio: '选择 stdio，填写命令、参数数组和环境变量。使用应用自带的运行时，无需另外安装 Node。JSON 为单个服务配置。',
  desktop: 'Claude Desktop：将配置合并到开发者设置中的 claude_desktop_config.json 的 mcpServers。',
  code: 'Claude Code：将配置合并到项目 .mcp.json 的 mcpServers。',
}
const dirty = computed(() => JSON.stringify(form.value) !== baseline.value)
const canConnect = computed(() => status.value?.state === 'running' && !dirty.value && !saving.value)
watch(dirty, (value) => { emit('dirty', value); if (value) { showingConfig.value = false; connection.value = undefined } })
watch(saving, (value) => emit('saving', value), { flush: 'sync' })
let timer: ReturnType<typeof setInterval> | undefined, disposed = false
function apply(value: McpStatus): void { status.value = value; form.value = { ...value.settings }; baseline.value = JSON.stringify(form.value); showingConfig.value = false; connection.value = undefined }
async function save(): Promise<void> {
  const parsed = mcpSettingsSchema.safeParse(form.value)
  if (!parsed.success) { ElMessage.warning('端口应为 1024 至 65535 的整数'); return }
  saving.value = true
  try { apply(await api.saveMcpSettings(parsed.data)); ElMessage.success('连接设置已保存') } catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
async function copy(format: McpConnectionFormat): Promise<void> { try { await api.copyMcpConnection(format); ElMessage.success(format === 'token' ? '访问令牌已复制' : '连接配置已复制') } catch (error) { ElMessage.error(errorMessage(error)) } }
async function preview(): Promise<void> { if (showingConfig.value) { showingConfig.value = false; return }; try { connection.value = await api.getMcpConnection(); showingConfig.value = true } catch (error) { ElMessage.error(errorMessage(error)) } }
async function rotate(): Promise<void> {
  try { await ElMessageBox.confirm('重置后，已有客户端需要更新连接配置。是否继续？', '重置访问令牌', { confirmButtonText: '重置令牌', cancelButtonText: '取消', type: 'warning' }); saving.value = true; apply(await api.rotateMcpToken()); ElMessage.success('令牌已重置，请更新客户端配置') }
  catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
onMounted(async () => { try { apply(await api.getMcpStatus()); if (!disposed) timer = setInterval(() => { void api.getMcpStatus().then((value) => { if (!disposed && !saving.value) status.value = value }).catch(() => {}) }, 3000) } catch (error) { ElMessage.error(errorMessage(error)) } finally { loading.value = false } })
onBeforeUnmount(() => { disposed = true; if (timer) clearInterval(timer) })
</script>
<style scoped>
.client-select { width: 100%; }.manual-connection { display: grid; gap: 10px; padding: 12px; margin-bottom: 16px; border-radius: 6px; background: light-dark(#f6f8fb, #292a2f); font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }.manual-connection > span { min-width: 0; }.manual-connection code { display: block; margin-top: 5px; color: #657a92; }.stdio-actions { margin-top: 12px; }.connection-scope { margin-top: 14px; }
.mcp-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; align-items: start; }.mcp-group { min-width: 0; padding: 4px clamp(14px, 2cqi, 24px) 18px; }h2 { margin: 0; padding: 16px 0 10px; font-size: 13px; font-weight: 600; }.group-heading { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; }
.mcp-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 40%); gap: 16px; align-items: center; min-height: 58px; padding: 12px 0; font-size: 13px; }.mcp-row + .mcp-row { border-top: 1px solid light-dark(#f0f0f3, #393b43); }.mcp-row > * { min-width: 0; }.switch-row { grid-template-columns: minmax(0, 1fr) auto; }.mcp-row small { display: block; margin-top: 5px; color: var(--muted); font-size: 11px; line-height: 1.7; }.mcp-row :deep(.el-input-number) { width: 100%; }.connection-state { display: flex; gap: 6px; align-items: center; font-size: 11px; color: light-dark(#9096a2, #b5b6c1); }.connection-state i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }.connection-state[data-state="running"] { color: #478568; }.connection-state[data-state="error"] { color: #c06050; }
.connection-address { display: grid; gap: 8px; border-top: 1px solid var(--border); padding-top: 16px; font-size: 11px; color: var(--muted); }code, pre { font-family: Consolas, monospace; overflow-wrap: anywhere; }.connection-address code { color: #657a92; }.mcp-description { margin: 8px 0 14px; font-size: 12px; line-height: 1.8; color: var(--muted); overflow-wrap: anywhere; }.client-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 3px; gap: 3px; border-radius: 7px; background: light-dark(#eeeef3, #292a2f); }.client-options button { padding: 8px; border: 0; border-radius: 5px; font-size: 12px; background: transparent; color: light-dark(#80838e, #b5b6c1); cursor: pointer; }.client-options button.active { background: light-dark(#fff, #242529); color: light-dark(#333c4c, #e4e4eb); box-shadow: 0 1px 3px #00000012; }.connection-actions, .token-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }.connection-actions .el-button, .token-actions .el-button { margin-left: 0; }.token-actions { padding-top: 16px; margin-top: 18px; border-top: 1px solid var(--border); }.token-actions > span { margin-right: auto; font-size: 12px; }.config-preview { margin: 14px 0 0; max-height: 260px; overflow: auto; padding: 12px; background: light-dark(#f6f8fb, #292a2f); border: 1px solid light-dark(#e8ecf2, #393b43); border-radius: 6px; white-space: pre-wrap; font-size: 11px; line-height: 1.7; }
.tool-group { grid-column: 1 / -1; }.tool-count { font-size: 11px; color: var(--muted); }.tools-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 26px; }.tool-row { display: flex; align-items: flex-start; gap: 10px; border-top: 1px solid light-dark(#f0f0f3, #393b43); padding: 12px 0; min-width: 0; }.tool-kind { font-size: 10px; color: #647995; background: light-dark(#f0f3f8, #292a2f); border-radius: 4px; padding: 4px 5px; flex: none; }.tool-kind.writable { color: #977441; background: light-dark(#faf5e9, #292a2f); }.tool-row > div { min-width: 0; }.tool-row strong { display: block; font-size: 12px; font-weight: 400; }.tool-row code { display: block; color: light-dark(#969da8, #9395a1); font-size: 10px; margin-top: 5px; }.mcp-activity { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--border); padding-top: 14px; overflow-wrap: anywhere; }
.mcp-actions { position: sticky; bottom: -22px; z-index: 1; display: flex; align-items: center; gap: 10px; padding: 14px 0; margin-top: 18px; border-top: 1px solid var(--border); background: light-dark(#ffffffee, #202124ee); backdrop-filter: blur(8px); }.mcp-actions .el-button { margin-left: auto; }.draft-note { font-size: 11px; color: #a47d35; }
@container settings (max-width: 1000px) { .mcp-grid { grid-template-columns: minmax(0, 1fr); } }@container settings (max-width: 580px) { .mcp-row:not(.switch-row), .tools-list { grid-template-columns: minmax(0, 1fr); }.mcp-row { gap: 8px; } }
</style>
