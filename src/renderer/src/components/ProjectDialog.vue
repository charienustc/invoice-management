<template>
  <el-dialog :model-value="modelValue" :title="project ? '编辑项目' : '新建项目'" width="440px" @open="reset" @update:model-value="close">
    <el-form label-position="top" @submit.prevent="save">
      <el-form-item label="项目名称" required><el-input ref="nameInput" v-model="name" maxlength="80" placeholder="例如：实验设备采购" @keyup.enter="save" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="description" type="textarea" :rows="3" maxlength="1000" /></el-form-item>
    </el-form>
    <template #footer><el-button :disabled="saving" @click="close">取消</el-button><el-button type="primary" :loading="saving" :disabled="!name.trim()" @click="save">{{ project ? '保存' : '创建' }}</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { ElMessage, type InputInstance } from 'element-plus'
import type { InvoiceProject } from '@shared/contracts'
import { api } from '@/api'
import { useProjectStore } from '@/stores/projects'
import { errorMessage } from '@/utils'
const props = defineProps<{ modelValue: boolean; project?: InvoiceProject }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; saved: [project: InvoiceProject] }>()
const projects = useProjectStore()
const name = ref(''), description = ref(''), saving = ref(false), nameInput = ref<InputInstance>()
async function reset(): Promise<void> { name.value = props.project?.name ?? ''; description.value = props.project?.description ?? ''; await nextTick(); nameInput.value?.focus() }
function close(): void { if (!saving.value) emit('update:modelValue', false) }
async function save(): Promise<void> {
  if (saving.value || !name.value.trim()) return
  saving.value = true
  try {
    const input = { name: name.value.trim(), description: description.value.trim() }
    const project = props.project ? await api.updateProject({ id: props.project.id, ...input }) : await api.createProject(input)
    await projects.fetch()
    emit('saved', project)
    emit('update:modelValue', false)
  } catch (error) { ElMessage.error(errorMessage(error)) } finally { saving.value = false }
}
</script>
