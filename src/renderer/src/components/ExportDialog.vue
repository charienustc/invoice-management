<template>
  <el-dialog :model-value="modelValue" title="导出发票" width="560px" @update:model-value="close" @open="reset">
    <el-form label-width="92px" :disabled="running">
      <el-form-item label="文件格式">
        <el-radio-group v-model="form.format">
          <el-radio-button value="xlsx">Excel (xlsx)</el-radio-button>
          <el-radio-button value="csv">CSV</el-radio-button>
          <el-radio-button value="bundle">报销材料包</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="导出范围">
        <el-radio-group v-model="form.scope">
          <el-radio-button value="filter">当前筛选结果</el-radio-button>
          <el-radio-button value="selected" :disabled="!selectedCount">已选 {{ selectedCount }} 张</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item v-if="form.format !== 'bundle'" label="导出列">
        <el-checkbox-group v-model="form.columns" class="column-group">
          <el-checkbox v-for="column in EXPORT_COLUMNS" :key="column" :value="column" :label="EXPORT_COLUMN_LABELS[column]" />
        </el-checkbox-group>
      </el-form-item>
      <el-form-item v-if="form.format !== 'bundle'" label="原始文件">
        <el-checkbox v-model="form.includeFiles">同时把原始发票文件（PDF/图片）复制到指定目录</el-checkbox>
      </el-form-item>
      <el-form-item v-if="form.format === 'bundle'" label="包含内容"><div class="bundle-description">费用清单.xlsx、按清单序号命名的原件、合并打印.pdf。<br />清单包含核对状态和合并页码。每次最多 100 张、200 页，原件合计不超过 150 MB。</div></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="primary" :disabled="form.format !== 'bundle' && !form.columns.length" :loading="running" @click="confirm">{{ form.format === 'bundle' ? '生成材料包' : '开始导出' }}</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { errorMessage } from '@/utils'
import { DEFAULT_EXPORT_COLUMNS, EXPORT_COLUMNS, EXPORT_COLUMN_LABELS, type ExportColumn, type ExportFilesInput, type ExportInput } from '@shared/contracts'
import { api } from '@/api'

const props = defineProps<{ modelValue: boolean; selectedCount: number; buildScope: (scope: 'filter' | 'selected') => Pick<ExportInput, 'filter' | 'invoiceIds'> }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; exported: [message: string] }>()

const STORAGE_KEY = 'export-columns'
const form = reactive<{ format: 'xlsx' | 'csv' | 'bundle'; scope: 'filter' | 'selected'; columns: ExportColumn[]; includeFiles: boolean }>({ format: 'xlsx', scope: 'filter', columns: [...DEFAULT_EXPORT_COLUMNS], includeFiles: false })
const running = ref(false)

function loadColumns(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as ExportColumn[] | null
    form.columns = saved?.length ? saved.filter((column) => (EXPORT_COLUMNS as readonly string[]).includes(column)) : [...DEFAULT_EXPORT_COLUMNS]
  } catch {
    form.columns = [...DEFAULT_EXPORT_COLUMNS]
  }
}
function reset(): void {
  form.format = 'xlsx'
  form.scope = props.selectedCount ? 'selected' : 'filter'
  form.includeFiles = false
  loadColumns()
}
function close(): void { if (!running.value) emit('update:modelValue', false) }

async function confirm(): Promise<void> {
  if (running.value || (form.format !== 'bundle' && !form.columns.length)) return
  running.value = true
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form.columns))
    const scope = props.buildScope(form.scope)
    if (form.format === 'bundle') {
      const result = await api.exportReimbursementBundle(scope)
      if (result.canceled) return
      emit('exported', `已生成 ${result.count} 张发票的材料包：${result.filePath}`)
      emit('update:modelValue', false)
      return
    }
    const input: ExportInput = { format: form.format, columns: form.columns, ...scope }
    const result = await api.exportInvoices(input)
    if (result.canceled) return
    let fileMessage = ''
    if (form.includeFiles) {
      const filesInput: ExportFilesInput = scope
      const filesResult = await api.exportInvoiceFiles(filesInput)
      fileMessage = filesResult.canceled ? '' : `，原始文件已复制 ${filesResult.count} 个`
    }
    if (!result.canceled) emit('exported', `已导出 ${result.count} 张发票${fileMessage}`)
    emit('update:modelValue', false)
  } catch (error) {
    ElMessage.error(errorMessage(error))
  } finally {
    running.value = false
  }
}
</script>

<style scoped>
.column-group { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0 8px; }
.bundle-description { line-height: 1.8; color: var(--muted); font-size: 12px; }
.column-group :deep(.el-checkbox) { margin-right: 0; height: 30px; }
</style>
