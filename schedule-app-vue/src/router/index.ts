import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * 路由表。
 *
 * - 公開端入口在 `/`：有 `?user=` → 個人班表選擇；無 → 大眾 landing（向後相容
 *   LINE bot 的 `https://.../?user=名字` 連結）。
 * - 每條路由加上舊版 `.html` 的 alias，未來把 Firebase Hosting 切到本 app 時，
 *   舊的深層連結（含書籤）仍可運作。
 * - 管理端路由 meta.requiresAdmin = true，由下方 guard 擋登入 + 允許名單。
 */
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'home',
    alias: '/index.html',
    component: () => import('@/views/public/PublicHomeView.vue'),
  },
  {
    path: '/view',
    name: 'view',
    alias: '/view.html',
    component: () => import('@/views/public/PublicScheduleView.vue'),
  },

  // ── 管理端 ──────────────────────────────────────────────
  {
    path: '/admin/login',
    name: 'admin-login',
    component: () => import('@/views/admin/AdminLoginView.vue'),
  },
  {
    path: '/admin',
    name: 'admin',
    alias: ['/edit-chart', '/edit-chart/index.html'],
    component: () => import('@/views/admin/CollectionPickerView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/edit',
    name: 'editor',
    alias: '/edit-chart/edit-chart.html',
    component: () => import('@/views/admin/EditChartView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/users',
    name: 'users',
    alias: '/edit-chart/edit-user.html',
    component: () => import('@/views/admin/EditUserView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/observation',
    name: 'observation',
    alias: '/edit-chart/observation.html',
    component: () => import('@/views/admin/ObservationView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/difference',
    name: 'difference',
    alias: '/edit-chart/difference.html',
    component: () => import('@/views/admin/DifferenceView.vue'),
    meta: { requiresAdmin: true },
  },
  {
    path: '/admin/agent-log',
    name: 'agent-log',
    alias: '/edit-chart/agent_log_dashboard.html',
    component: () => import('@/views/admin/AgentLogView.vue'),
    meta: { requiresAdmin: true },
  },

  { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior() {
    return { top: 0 }
  },
})

router.beforeEach(async (to) => {
  if (!to.meta.requiresAdmin) return true

  // 開發專用：VITE_DEV_BYPASS_AUTH=true 時略過登入檢查（僅 dev build 生效，正式環境永遠無效）
  if (import.meta.env.DEV && import.meta.env.VITE_DEV_BYPASS_AUTH === 'true') return true

  const auth = useAuthStore()
  await auth.whenReady()

  if (!auth.user) {
    return { name: 'admin-login', query: { redirect: to.fullPath } }
  }
  if (!auth.isAdmin) {
    // 已登入但不在允許名單 → 導到登入頁顯示「無權限」
    return { name: 'admin-login', query: { redirect: to.fullPath, denied: '1' } }
  }
  return true
})

export default router
