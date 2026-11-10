<template>
  <el-dialog :model-value="modelValue" title="分配项目" width="420px" @open="projectId = initialProjectId" @update:model-value="close">
    <p class="assignment-count">已选择 {{ invoiceIds.length }} 张发票</p>
    <el-select v-model="projectId" placeholder="选择项目" filterable aria-label="目标项目" style="width: 100%"><el-option label="未分配" value="" /><el-option v-for="project in projects.items" :key="project.id" :label="project.name" :value="project.id" /></el-select>
    <el-button text class="new-project" @click="creating = true">新建项目</el-button>
    <template #footer><el-button :disabled="saving" @click="close">取消</el-button><el-button type="primary" :loading="saving" :disabled="projectId === undefined" @click="save">确定</el-button></template>
  </el-dialog>
  <ProjectDialog v-model="creating" @saved="projectId = $event.id" />
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '@/api'
import { useProjectStore } from '@/stores/projects'
import { errorMessage } from '@/utils'
import ProjectDialog from './ProjectDialog.vue'
const props = defineProps<{ modelValue: boolean; invoiceIds: string[]; initialProjectId?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; changed: [count: number] }>()
const projects = useProjectStore()
const projectId = ref<string>(), saving = ref(false), creating = ref(false)
function close(): void { if (!saving.value) emit('update:modelValue', false) }
async function save(): Promise<void> {
  if (saving.value || projectId.value === undefined) return
  saving.value = true
  try {
    const count = await api.setInvoiceProjects(props.invoiceIds, projectId.value ? [projectId.value] : [])
    await projects.fetch()
    emit('changed', count)
    emit('update:modelValue', false)
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
</script>
<style scoped>
.assignment-count { color: var(--muted); font-size: 12px; margin-top: 0; margin-bottom: 14px; }
.new-project { margin-top: 10px; }
</style>
