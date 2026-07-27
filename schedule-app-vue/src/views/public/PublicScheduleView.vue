<script setup lang="ts">
/**
 * 大眾班表查看（舊版 view.html 對應頁）。
 * query: ?service=崇拜名稱（必填）&user=名字（可選，標示該人名所在格）
 *
 * DOM 結構與 class 刻意與舊版 view.html 一致（app-container / header-section /
 * group-filter / table-container / schedule-table …），直接沿用 main.css 的共用樣式，
 * 才能和舊站長得一模一樣；本檔只補上舊版 view.html 內嵌的那幾條「唯讀」樣式。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { loadServeList } from '@/services/serves'
import { loadFutureRows, loadMetadata, loadPastRows } from '@/services/schedule'
import { cellOf, defaultVisibleGroupIds, getVisibleServiceItems } from '@/utils/schedule'
import { formatDisplayDate } from '@/utils/dates'
import type { DisplayConfig, ScheduleRow, Serve } from '@/types'

/** 舊版 view.html 的顯示上限（未來 26 筆、歷史 5 週） */
const MAX_DISPLAY_ROWS = 26
const MAX_PAST_ROWS = 5

const route = useRoute()
const serviceName = computed(() => (route.query.service as string) || '')
const highlightUser = computed(() => (route.query.user as string) || '')

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

// 群組可見性（key = group id）
const groupVisible = reactive<Record<string, boolean>>({})

const filterGroups = computed(() =>
  (displayConfig.value?.groups ?? []).filter((g) => g.id !== 'ungrouped' && g.items.length > 0),
)

const visibleServiceItems = computed(() =>
  getVisibleServiceItems(serviceItems.value, displayConfig.value, (id) => groupVisible[id] !== false),
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

/** 回首頁連結（沿用舊版：帶著 user 參數回選擇頁） */
const homeHref = computed(() =>
  highlightUser.value ? `/?user=${encodeURIComponent(highlightUser.value)}` : '/',
)

async function onTogglePast() {
  if (showPast.value && !pastLoaded.value) {
    pastLoaded.value = true
    try {
      pastRows.value = await loadPastRows(collectionName.value, MAX_PAST_ROWS)
    } catch (e) {
      console.log('無過去資料或載入失敗:', e)
      pastRows.value = []
    }
  }
}

function showError(title: string, message: string) {
  errorTitle.value = title
  errorMsg.value = message
}

onMounted(async () => {
  try {
    const serves = await loadServeList()
    if (serves.length === 0) {
      showError('尚未設定', '請先到管理頁面新增崇拜')
      return
    }
    const found = serves.find((s) => s.name === serviceName.value)
    if (!found) {
      showError('找不到班表', `無效的崇拜名稱: ${serviceName.value || '(未指定)'}`)
      return
    }
    serve.value = found
    collectionName.value = found.id
    document.title = `${found.name}班表`

    const [meta, rows] = await Promise.all([loadMetadata(found.id), loadFutureRows(found.id)])
    serviceItems.value = meta?.serviceItems ?? []
    displayConfig.value = meta?.displayConfig ?? null
    futureRows.value = rows.slice(0, MAX_DISPLAY_ROWS)

    for (const id of defaultVisibleGroupIds(displayConfig.value)) groupVisible[id] = true
    for (const g of filterGroups.value) if (!(g.id in groupVisible)) groupVisible[g.id] = false
  } catch (e) {
    console.error('初始化失敗:', e)
  }
})
</script>

<template>
  <div class="app-container">
    <!-- 錯誤頁（與舊版 showError 一致） -->
    <div v-if="errorTitle" class="view-error">
      <h1>⚠️</h1>
      <h2>{{ errorTitle }}</h2>
      <p>{{ errorMsg }}</p>
      <a :href="homeHref" class="btn btn-primary">返回選擇頁面</a>
    </div>

    <template v-else>
      <div class="header-section">
        <div class="app-title">
          <!-- 兩個 span 寫在同一行，中間的空格才不會被 Vue 的 whitespace condense 吃掉 -->
          <h1 style="display: inline">
            <span>{{ serve?.emoji || '⛪' }}</span> <span>{{ serve ? `${serve.name}班表` : '教會服事班表' }}</span>
          </h1>
        </div>

        <div class="group-filter">
          <label v-for="g in filterGroups" :key="g.id" class="group-filter-item">
            <input v-model="groupVisible[g.id]" type="checkbox" />
            {{ g.name }}
          </label>
          <label
            class="group-filter-item"
            :style="filterGroups.length ? 'margin-left:16px;border-left:1px solid #ddd;padding-left:16px' : ''"
          >
            <input v-model="showPast" type="checkbox" @change="onTogglePast" />
            顯示前5週
          </label>
        </div>

        <div class="status-indicator"></div>
      </div>

      <div class="table-container">
        <div class="table-scroll">
          <table class="schedule-table">
            <thead>
              <tr>
                <th class="date-header">日期</th>
                <th v-for="item in visibleServiceItems" :key="item" class="service-header">
                  {{ item }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="{ row, isPast } in renderRows"
                :key="row.date"
                :style="isPast ? 'opacity: 0.6; background: #f8fafc;' : ''"
              >
                <td>
                  <div class="date-cell">{{ formatDisplayDate(row.date) }}</div>
                </td>
                <td
                  v-for="item in visibleServiceItems"
                  :key="item"
                  class="service-cell"
                  :style="isHighlighted(row, item) ? 'background-color: #ffe08a;' : ''"
                >
                  <span v-if="cellText(row, item)" style="font-weight: 550">
                    {{ cellText(row, item) }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 舊版 view.html 內嵌的唯讀樣式，逐條照搬 */
.service-cell {
  cursor: default !important;
}
.service-cell:hover {
  background: white !important;
}
.schedule-table th.service-header {
  cursor: default;
}
.header-section {
  justify-content: center;
}

/* 錯誤頁：等同舊版 showError 的 inline style */
.view-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 50vh;
  text-align: center;
}
.view-error h1 {
  color: #ef4444;
  font-size: 48px;
  margin-bottom: 16px;
}
.view-error h2 {
  color: #ef4444;
  margin-bottom: 8px;
}
.view-error p {
  color: #64748b;
}
.view-error .btn {
  margin-top: 24px;
}
</style>
