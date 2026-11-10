import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/invoices' },
    { path: '/invoices', component: () => import('@/pages/InvoiceListPage.vue'), meta: { title: '发票管理' } },
    { path: '/invoices/:id', component: () => import('@/pages/InvoiceDetailPage.vue'), meta: { title: '发票详情' } },
    { path: '/advances', component: () => import('@/pages/AdvancesPage.vue'), meta: { title: '垫付记录' } },
    { path: '/stats', component: () => import('@/pages/StatsPage.vue'), meta: { title: '统计分析' } },
    { path: '/settings', component: () => import('@/pages/SettingsPage.vue'), meta: { title: '设置' } },
  ],
})
