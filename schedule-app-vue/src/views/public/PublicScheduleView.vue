<script setup lang="ts">
/**
 * 大眾班表查看（舊版 view.html 對應頁）。
 * query: ?service=崇拜名稱（必填）&user=名字（可選，標示該人名所在格）
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { loadServeList } from '@/services/serves'
import { loadFutureRows, loadMetadata, loadPastRows } from '@/services/schedule'
import {
  cellOf,
  defaultVisibleGroupIds,
  getVisibleServiceItems,
} from '@/utils/schedule'
import { formatDisplayDate } from '@/utils/dates'
import type { DisplayConfig, ScheduleRow, Serve } from '@/types'

const route = useRoute()
const serviceName = computed(() => (route.query.service as string) || '')
const highlightUser = computed(() => (route.query.user as string) || '')

const loading = ref(true)
const errorTitle = ref('')
const errorMsg = ref('')

const serve = ref<Serve | null>(null)
const collectionName = ref('')
const serviceItems = ref<string[]>([])
const displayConfig = ref<DisplayConfig | null>(null)
const futureRows = ref<ScheduleRow[]>([])
const pastRows = ref<ScheduleRow[]>([])

const showPast = ref(false)
const pastLoaded = ref(false)
const loadingPast = ref(false)

// 群組可見性（key = group id）
const groupVisible = reactive<Record<string, boolean>>({})

const filterGroups = computed(() =>
  (displayConfig.value?.groups ?? []).filter(
    (g) => g.id !== 'ungrouped' && g.items.length > 0,
  ),
)

const visibleServiceItems = computed(() =>
  getVisibleServiceItems(
    serviceItems.value,
    displayConfig.value,
    (id) => groupVisible[id] !== false,
  ),
)

interface RenderRow {
  row: ScheduleRow
  isPast: boolean
}
const renderRows = computed<RenderRow[]>(() => {
  const out: RenderRow[] = []
  if (showPast.value) for (const row of pastRows.value) out.push({ row, isPast: true })
  for (const row of futureRows.value) out.push({ row, isPast: false })
  return out
})

function cellText(row: ScheduleRow, service: string): string {
  return cellOf(row, service).join('/')
}

function isHighlighted(row: ScheduleRow, service: string): boolean {
  return !!highlightUser.value && cellText(row, service).includes(highlightUser.value)
}

async function togglePast() {
  if (!showPast.value && !pastLoaded.value) {
    loadingPast.value = true
    try {
      pastRows.value = await loadPastRows(collectionName.value, 5)
      pastLoaded.value = true
    } catch (e) {
      console.error('載入歷史資料失敗:', e)
    } finally {
      loadingPast.value = false
    }
  }
  showPast.value = !showPast.value
}

onMounted(async () => {
  try {
    if (!serviceName.value) {
      errorTitle.value = '缺少參數'
      errorMsg.value = '網址需包含 ?service=崇拜名稱'
      return
    }

    const serves = await loadServeList()
    const found = serves.find((s) => s.name === serviceName.value)
    if (!found) {
      errorTitle.value = '找不到班表'
      errorMsg.value = `無效的班表名稱：${serviceName.value}`
      return
    }
    serve.value = found
    collectionName.value = found.id

    const [meta, rows] = await Promise.all([
      loadMetadata(found.id),
      loadFutureRows(found.id),
    ])
    serviceItems.value = meta?.serviceItems ?? []
    displayConfig.value = meta?.displayConfig ?? null
    futureRows.value = rows

    for (const id of defaultVisibleGroupIds(displayConfig.value)) groupVisible[id] = true
    for (const g of filterGroups.value) if (!(g.id in groupVisible)) groupVisible[g.id] = false
  } catch (e) {
    console.error('載入失敗:', e)
    errorTitle.value = '載入失敗'
    errorMsg.value = '請檢查網路連線後重試'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="view-page">
    <div v-if="errorTitle" class="error-page">
      <div class="error-icon">⚠️</div>
      <h2>{{ errorTitle }}</h2>
      <p>{{ errorMsg }}</p>
      <router-link to="/" class="btn btn-secondary">回首頁</router-link>
    </div>

    <template v-else>
      <header class="view-header">
        <h1>{{ serve?.emoji }} {{ serve?.name }}班表</h1>
        <div class="view-controls">
          <label v-for="g in filterGroups" :key="g.id" class="group-toggle">
            <input v-model="groupVisible[g.id]" type="checkbox" />
            {{ g.name }}
          </label>
          <button class="btn btn-secondary btn-sm" :disabled="loadingPast" @click="togglePast">
            {{ loadingPast ? '載入中…' : showPast ? '📅 隱藏歷史' : '📅 顯示前 5 週' }}
          </button>
        </div>
      </header>

      <div v-if="loading" class="loading-message">載入中...</div>

      <div v-else class="table-wrap">
        <table class="view-table">
          <thead>
            <tr>
              <th class="date-col">日期</th>
              <th v-for="item in visibleServiceItems" :key="item">{{ item }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="renderRows.length === 0">
              <td :colspan="visibleServiceItems.length + 1" class="empty-row">目前沒有班表資料</td>
            </tr>
            <tr v-for="{ row, isPast } in renderRows" :key="row.date" :class="{ past: isPast }">
              <td class="date-col">{{ formatDisplayDate(row.date) }}</td>
              <td
                v-for="item in visibleServiceItems"
                :key="item"
                :class="{ highlight: isHighlighted(row, item) }"
              >
                {{ cellText(row, item) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.view-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 16px 64px;
}
.view-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
}
.view-header h1 {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
}
.view-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}
.group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 14px;
  color: var(--text-secondary);
  cursor: pointer;
}
.btn-sm {
  padding: 6px 12px;
  font-size: 13px;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-sm);
}
.view-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--bg-primary);
}
.view-table th,
.view-table td {
  border: 1px solid var(--gray-100);
  padding: 10px 12px;
  text-align: center;
  font-size: 14px;
  white-space: nowrap;
}
.view-table thead th {
  background: var(--bg-secondary);
  font-weight: 600;
  color: var(--text-primary);
  position: sticky;
  top: 0;
}
.view-table td {
  color: var(--text-primary);
  font-weight: 550;
}
.date-col {
  font-weight: 600;
  white-space: nowrap;
}
.view-table tr.past td {
  opacity: 0.6;
  background: #f8fafc;
}
.view-table td.highlight {
  background-color: #ffe08a;
  font-weight: 700;
}
.empty-row {
  color: var(--text-secondary);
  padding: 32px;
}
.loading-message {
  text-align: center;
  color: var(--text-secondary);
  padding: 40px;
}
.error-page {
  text-align: center;
  padding: 80px 24px;
}
.error-page .error-icon {
  font-size: 64px;
  margin-bottom: 16px;
}
.error-page h2 {
  color: #dc2626;
  margin-bottom: 8px;
}
.error-page p {
  color: var(--text-secondary);
  margin-bottom: 24px;
}
</style>
