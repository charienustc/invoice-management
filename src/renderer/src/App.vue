<template>
  <div class="app-frame">
    <header class="window-titlebar" aria-label="窗口标题栏"><SidebarToggle /><span class="window-title">发票管理</span></header>
  <div class="app-shell">
    <aside id="app-sidebar" class="sidebar" :class="{ 'is-collapsed': !sidebarOpen }" :inert="!sidebarOpen" :aria-hidden="!sidebarOpen">
      <nav class="navigation" aria-label="主导航">
        <RouterLink v-for="item in navigation" :key="item.path" :to="item.path" class="nav-item" :class="{ 'is-active': route.path.startsWith(item.path) && !route.query.project }" :aria-current="route.path.startsWith(item.path) && !route.query.project ? 'page' : undefined">
          <el-icon :size="17"><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </RouterLink>
      </nav>
      <div class="project-heading"><span>项目</span><button type="button" aria-label="新建项目" title="新建项目" @click="openProjectDialog()"><el-icon><Plus /></el-icon></button></div>
      <nav class="project-navigation" aria-label="项目列表">
        <RouterLink :to="{ path: route.path === '/advances' ? '/advances' : '/invoices', query: { project: 'unassigned' } }" class="nav-item project-link" :class="{ 'is-active': route.query.project === 'unassigned' }"><el-icon :size="16"><FolderOpened /></el-icon><span>未分配</span><small v-if="route.path !== '/advances'">{{ projects.unassignedCount }}</small></RouterLink>
        <div v-for="project in projects.items" :key="project.id" class="project-row">
          <RouterLink :to="{ path: route.path === '/advances' ? '/advances' : '/invoices', query: { project: project.id } }" class="nav-item project-link" :class="{ 'is-active': route.query.project === project.id }" :title="project.name"><el-icon :size="16"><Folder /></el-icon><span>{{ project.name }}</span><small v-if="route.path !== '/advances'">{{ project.invoiceCount }}</small></RouterLink>
          <el-dropdown trigger="click" class="project-menu" @command="(command: string) => projectCommand(command, project)"><button type="button" class="project-menu-button" :aria-label="`管理项目：${project.name}`"><el-icon><MoreFilled /></el-icon></button><template #dropdown><el-dropdown-menu><el-dropdown-item command="edit">编辑项目</el-dropdown-item><el-dropdown-item command="delete" divided>删除项目</el-dropdown-item></el-dropdown-menu></template></el-dropdown>
        </div>
      </nav>
      <div class="local-note">数据保存在本机</div>
    </aside>
    <main class="main-area">
      <header v-if="!route.path.startsWith('/invoices')" class="page-header">
        <h1>{{ route.meta.title }}</h1>
      </header>
      <div class="page-content" :class="{ 'workspace-content': route.path.startsWith('/invoices') }"><RouterView v-slot="{ Component }"><Transition name="workspace" mode="out-in"><component :is="Component" :key="route.fullPath" /></Transition></RouterView></div>
    </main>
  </div>
  </div>
  <ProjectDialog v-model="projectDialogVisible" :project="editingProject" @saved="refreshProjectInvoices" />
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Files, Wallet, DataAnalysis, Setting, Plus, Folder, FolderOpened, MoreFilled } from '@element-plus/icons-vue'
import { api } from '@/api'
import { useInvoiceStore } from '@/stores/invoices'
import { useProjectStore } from '@/stores/projects'
import { usePreferencesStore } from '@/stores/preferences'
import ProjectDialog from '@/components/ProjectDialog.vue'
import SidebarToggle from '@/components/SidebarToggle.vue'
import { sidebarKey } from '@/utils/sidebar'
import type { InvoiceProject } from '@shared/contracts'
import { errorMessage } from '@/utils'

const route = useRoute()
const store = useInvoiceStore()
const router = useRouter()
const projects = useProjectStore()
const preferences = usePreferencesStore()
function applyPageSize(): void {
  if (preferences.loaded && store.query.pageSize !== preferences.settings.pageSize) void store.updateQuery({ page: 1, pageSize: preferences.settings.pageSize }).catch((error) => ElMessage.error(errorMessage(error)))
}
watch(() => preferences.settings.pageSize, applyPageSize)
const projectDialogVisible = ref(false)
const editingProject = ref<InvoiceProject>()
function openProjectDialog(project?: InvoiceProject): void { editingProject.value = project; projectDialogVisible.value = true }
function refreshProjectInvoices(): void { void store.fetchList().catch((error) => ElMessage.error(errorMessage(error))) }
async function projectCommand(command: string, project: InvoiceProject): Promise<void> {
  if (command === 'edit') { openProjectDialog(project); return }
  try {
    await ElMessageBox.confirm(`删除“${project.name}”？发票、垫付记录和附件会保留，只移除项目关联。`, '删除项目', { type: 'warning', confirmButtonText: '删除项目', cancelButtonText: '取消' })
    // A navigation guard must finish before deleting the project shown in an edited invoice.
    if (route.query.project === project.id) {
      const failure = await router.push('/invoices')
      if (failure) return
    }
    await api.deleteProject(project.id)
    await Promise.all([projects.fetch(), store.fetchList()])
    ElMessage.success('项目已删除，发票已保留')
  } catch (error) { if (error !== 'cancel' && error !== 'close') ElMessage.error(errorMessage(error)) }
}
const sidebarOpen = ref(true)
provide(sidebarKey, sidebarOpen)
function onKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.code === 'Backslash') { event.preventDefault(); sidebarOpen.value = !sidebarOpen.value }
}
const navigation = [
  { path: '/invoices', label: '发票管理', icon: Files },
  { path: '/advances', label: '垫付记录', icon: Wallet },
  { path: '/stats', label: '统计分析', icon: DataAnalysis },
  { path: '/settings', label: '设置', icon: Setting },
]
let unsubscribe: (() => void) | undefined
let unsubscribeData: (() => void) | undefined
let projectRefreshTimer: ReturnType<typeof setTimeout> | undefined
onMounted(() => {
  void preferences.load().then(() => { sidebarOpen.value = preferences.settings.sidebarExpanded; applyPageSize() }).catch((error) => ElMessage.error(errorMessage(error)))
  void projects.fetch().catch((error) => ElMessage.error(errorMessage(error)))
  unsubscribeData = api.onDataChanged(() => { void Promise.all([projects.fetch(), store.fetchList()]).catch((error) => ElMessage.error(errorMessage(error))) })
  unsubscribe = api.onOcrProgress((progress) => {
    store.applyProgress(progress)
    if (!projectRefreshTimer) projectRefreshTimer = setTimeout(() => { projectRefreshTimer = undefined; void projects.fetch().catch(console.error) }, 350)
  })
  window.addEventListener('keydown', onKeydown)
})
onBeforeUnmount(() => { unsubscribe?.(); unsubscribeData?.(); if (projectRefreshTimer) clearTimeout(projectRefreshTimer); window.removeEventListener('keydown', onKeydown) })
</script>
