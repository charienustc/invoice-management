<template>
  <el-dialog :model-value="modelValue" :title="mode === 'add' ? `为已选 ${count} 张发票添加标签` : `从已选 ${count} 张发票移除标签`" width="440px" @update:model-value="(value: boolean) => emit('update:modelValue', value)" @open="tags = []">
    <el-select
      class="tag-editor"
      v-model="tags"
      multiple
      filterable
      allow-create
      default-first-option
      :reserve-keyword="false"
      placeholder="输入或选择标签，回车创建"
      style="width: 100%"
    >
      <template #label="{ label }"><span :title="String(label)">{{ label }}</span></template>
      <el-option v-for="tag in existingTags" :key="tag" :label="tag" :value="tag" />
    </el-select>
    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :disabled="!tags.length" @click="confirm">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ modelValue: boolean; mode: 'add' | 'remove'; count: number; existingTags: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; confirm: [tags: string[]] }>()

const tags = ref<string[]>([])
function confirm(): void {
  emit('confirm', [...tags.value])
  tags.value = []
}
</script>
