<template>
  <button class="sidebar-toggle" type="button" aria-label="切换侧栏" title="切换侧栏（Ctrl+\）" aria-controls="app-sidebar" :aria-expanded="sidebarOpen" @click="sidebarOpen = !sidebarOpen"><el-icon :size="18"><Fold /></el-icon></button>
</template>

<script setup lang="ts">
import { inject } from 'vue'
import { Fold } from '@element-plus/icons-vue'
import { sidebarKey } from '@/utils/sidebar'

const sidebarOpen = inject(sidebarKey)!
</script>
