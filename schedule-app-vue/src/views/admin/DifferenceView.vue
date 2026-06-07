<script setup lang="ts">
/**
 * 編輯記錄檢視與還原（舊版 edit-chart/difference.html）。需管理員登入。
 *
 * 路由：/admin/difference?collection=<serveId>
 *   - 載入崇拜顯示名稱（標題用）與該崇拜的所有編輯記錄（倒序，最新在最前）。
 *   - 篩選 tab：全部 / 管理員 / AI / LINE Bot。
 *   - 每筆記錄可展開查看變更內容；僅「最新」一筆可還原（倒推寫回 old 值並刪除記錄）。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import BaseModal from '@/components/common/BaseModal.vue'
import { loadServeList } from '@/services/serves'
import { loadEditLogs, restoreLatestLog } from '@/services/editLogs'
import { formatDisplayDate, formatTimestampDisplay } from '@/utils/dates'
import type { CellDiff, EditChartLog } from '@/types'

const route = useRoute()
const collectionId = ((route.query.collection as string) || '').trim()

const loading = ref(true)
const errorMsg = ref('')
const displayName = ref(collectionId)
const logs = ref<EditChartLog[]>([])

// 篩選 tab
type FilterKey = 'all' | 'admin' | 'ai' | 'linebot'
const currentFilter = ref<FilterKey>('all')
const filterTabs: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'admin', label: '✏️ 管理員編輯' },
  { key: 'ai', label: '🤖 AI助手編輯' },
  { key: 'linebot', label: '📲 LINE Bot 調班' },
]

// 哪些卡片已展開詳情（以 log id 為 key）
const expanded = ref<Record<string, boolean>>({})

// 還原確認 modal
const restoreModalOpen = ref(false)
const restoreTarget = ref<EditChartLog | null>(null)
const restoring = ref(false)

onMounted(load)

async function load() {
  if (!collectionId) {
    errorMsg.value = '缺少崇拜名稱，請從班表頁面進入此頁面'
    loading.value = false
    return
  }
  loading.value = true
  errorMsg.value = ''
  try {
    // 標題用的崇拜顯示名稱（emoji + name）。讀取失敗時退回 collection id。
    try {
      const serves = await loadServeList()
      const matched = serves.find((s) => s.id === collectionId)
      if (matched) {
        displayName.value = matched.emoji ? `${matched.emoji} ${matched.name}` : matched.name
      }
    } catch (e) {
      console.error('載入崇拜名稱失敗:', e)
    }

    logs.value = await loadEditLogs(collectionId)
  } catch (e) {
    console.error('載入記錄失敗:', e)
    errorMsg.value = '載入失敗'
  } finally {
    loading.value = false
  }
}

/** 該記錄是否為全域最新一筆（僅最新可還原） */
function isLatest(log: EditChartLog): boolean {
  return logs.value.length > 0 && logs.value[0].id === log.id
}

/** 依目前 tab 過濾記錄（比對規則與舊版一致） */
const filteredLogs = computed(() => {
  const f = currentFilter.value
  if (f === 'all') return logs.value
  if (f === 'ai') {
    return logs.value.filter((log) => {
      const src = log.source || ''
      return src === 'ai' || src === 'ai-assistant' || src === 'admin+ai'
    })
  }
  if (f === 'admin') {
    return logs.value.filter((log) => {
      const src = log.source || 'admin'
      return src === 'admin' || src === 'admin+ai'
    })
  }
  // linebot：精確比對（缺漏視為 admin）
  return logs.value.filter((log) => (log.source || 'admin') === f)
})

/** 空清單時的提示文字 */
const emptyLabel = computed(() => {
  const map: Record<string, string> = {
    admin: '管理員編輯',
    ai: 'AI助手編輯',
    linebot: 'LINE Bot 調班',
  }
  return map[currentFilter.value] || ''
})

interface SourceBadge {
  cls: string
  style?: Record<string, string>
  text: string
}

/** 來源徽章樣式（admin=藍 / ai=紫 / linebot=橘 / admin+ai=靛） */
function sourceBadge(log: EditChartLog): SourceBadge {
  const source = log.source || 'admin'
  if (source === 'linebot') return { cls: 'linebot', text: '📲 LINE Bot 調班' }
  if (source === 'admin+ai') {
    return {
      cls: 'mixed',
      style: { background: '#e0e7ff', color: '#4338ca' },
      text: '✏️🤖 管理員+AI助手編輯',
    }
  }
  if (source === 'ai' || source === 'ai-assistant') return { cls: 'ai', text: '🤖 AI助手編輯' }
  return { cls: 'admin', text: '✏️ 管理員編輯' }
}

interface DiffRow {
  date: string
  changes: { service: string; oldDisplay: string; newDisplay: string }[]
}

/** 取出某筆變更前後值，支援舊格式（純陣列 = new 值） */
function readCellDiff(value: CellDiff | boolean): CellDiff {
  if (Array.isArray(value)) return { old: [], new: value as unknown as string[] }
  if (value && typeof value === 'object') {
    const cell = value as CellDiff
    return { old: cell.old ?? [], new: cell.new ?? [] }
  }
  return { old: [], new: [] }
}

function joinDisplay(arr: string[]): string {
  return Array.isArray(arr) && arr.length > 0 ? arr.join(', ') : '(空)'
}

/**
 * 把一筆記錄的 difference 整理成「依日期分組、日期正序」的列表（與舊版 renderDifference 一致）。
 * 跳過底線前綴的內部 metadata（例如 _deleted）。
 */
function diffRows(log: EditChartLog): DiffRow[] {
  const difference = log.difference || {}
  const dateGroups: Record<string, DiffRow['changes']> = {}

  for (const [date, services] of Object.entries(difference)) {
    for (const [service, value] of Object.entries(services)) {
      if (service.startsWith('_')) continue
      const cell = readCellDiff(value)
      if (!dateGroups[date]) dateGroups[date] = []
      dateGroups[date].push({
        service,
        oldDisplay: joinDisplay(cell.old),
        newDisplay: joinDisplay(cell.new),
      })
    }
  }

  return Object.keys(dateGroups)
    .sort((a, b) => a.localeCompare(b))
    .map((date) => ({ date, changes: dateGroups[date] }))
}

function toggleDiff(log: EditChartLog) {
  expanded.value[log.id] = !expanded.value[log.id]
}

function openRestore(log: EditChartLog) {
  if (!isLatest(log)) return
  restoreTarget.value = log
  restoreModalOpen.value = true
}

async function confirmRestore() {
  const target = restoreTarget.value
  // 再次確認確實是最新一筆，避免狀態在開窗期間變動。
  if (!target || !isLatest(target)) {
    restoreModalOpen.value = false
    return
  }
  if (!target.difference || Object.keys(target.difference).length === 0) {
    alert('此記錄沒有變更資料')
    restoreModalOpen.value = false
    return
  }

  restoring.value = true
  try {
    await restoreLatestLog(collectionId, target)
    restoreModalOpen.value = false
    expanded.value = {}
    await load()
    alert('還原成功！記錄已刪除。')
  } catch (e) {
    alert('還原失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    restoring.value = false
  }
}
</script>

<template>
  <div class="admin-page">
    <div class="page-header">
      <router-link
        :to="{ name: 'editor', query: { collection: collectionId } }"
        class="btn btn-secondary back-btn"
      >
        ← 返回
      </router-link>
      <h1>🔧 {{ displayName }} 編輯記錄</h1>
    </div>

    <div class="order-notice">
      ⚠️ 還原必須按照時間順序：請從最新的記錄開始還原，才能確保資料一致性。
    </div>

    <div class="filter-tabs">
      <button
        v-for="tab in filterTabs"
        :key="tab.key"
        class="filter-tab"
        :class="[`tab-${tab.key}`, { active: currentFilter === tab.key }]"
        @click="currentFilter = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <div class="log-list">
      <div v-if="loading" class="no-logs">載入中...</div>
      <div v-else-if="errorMsg" class="no-logs">{{ errorMsg }}</div>
      <div v-else-if="logs.length === 0" class="no-logs">目前沒有編輯記錄</div>
      <div v-else-if="filteredLogs.length === 0" class="no-logs">
        目前沒有「{{ emptyLabel }}」的編輯記錄
      </div>

      <template v-else>
        <div
          v-for="log in filteredLogs"
          :key="log.id"
          class="log-card"
          :class="isLatest(log) ? 'latest' : 'disabled'"
        >
          <div class="log-header">
            <div>
              <h3>
                編輯記錄 {{ formatTimestampDisplay(log.id) }}
                <span v-if="isLatest(log)" class="latest-badge">最新</span>
                <span
                  class="source-badge"
                  :class="sourceBadge(log).cls"
                  :style="sourceBadge(log).style"
                  >{{ sourceBadge(log).text }}</span
                >
              </h3>
              <div class="log-meta">
                最後編輯：{{ formatTimestampDisplay(log['last-edited-time'] || log.id) }}
              </div>
            </div>
            <div class="log-actions">
              <button class="toggle-btn" @click="toggleDiff(log)">
                {{ expanded[log.id] ? '收起詳情' : '展開詳情' }}
              </button>
              <button
                class="restore-btn"
                :disabled="!isLatest(log)"
                @click="openRestore(log)"
              >
                {{ isLatest(log) ? '還原' : '請先還原較新記錄' }}
              </button>
            </div>
          </div>

          <div v-if="expanded[log.id]" class="diff-section">
            <div class="diff-title">變更內容</div>
            <div v-if="diffRows(log).length === 0" class="diff-empty">無變更</div>
            <div v-for="row in diffRows(log)" v-else :key="row.date" class="diff-item">
              <span class="diff-date">{{ formatDisplayDate(row.date) }}</span>
              <span class="diff-value">
                <template v-for="(c, i) in row.changes" :key="c.service">
                  <span v-if="i > 0" class="diff-gap">&nbsp;&nbsp;</span>
                  <span class="diff-service">{{ c.service }}</span>
                  {{ c.oldDisplay }} → {{ c.newDisplay }}
                </template>
              </span>
            </div>
          </div>
        </div>
      </template>
    </div>

    <!-- 還原確認 -->
    <BaseModal v-model="restoreModalOpen" title="⚠️ 還原編輯記錄" max-width="500px">
      <div class="warning-text">
        確定要還原到此編輯之前的狀態嗎？<br /><br />
        這將覆蓋目前的班表資料，並刪除此編輯記錄。
      </div>
      <p v-if="restoreTarget">
        即將還原：<strong>{{ formatTimestampDisplay(restoreTarget.id) }}</strong>
      </p>
      <template #footer="{ close }">
        <button class="btn btn-secondary" :disabled="restoring" @click="close">取消</button>
        <button class="btn btn-danger" :disabled="restoring" @click="confirmRestore">
          {{ restoring ? '還原中...' : '確認還原' }}
        </button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.admin-page {
  max-width: 1200px;
  margin: 0 auto;
  padding: 32px;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 32px;
}
.page-header h1 {
  font-size: 28px;
  font-weight: 700;
}
.back-btn {
  padding: 6px 12px;
  text-decoration: none;
}

.order-notice {
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 14px;
  color: #92400e;
}

/* ===== 篩選 Tab ===== */
.filter-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.filter-tab {
  padding: 6px 16px;
  border-radius: 20px;
  border: 1.5px solid var(--border-color);
  background: white;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.18s;
}
.filter-tab:hover {
  background: var(--bg-hover);
}
.filter-tab.active {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: white;
}
.filter-tab.active.tab-admin {
  background: #2563eb;
  border-color: #2563eb;
}
.filter-tab.active.tab-ai {
  background: #7c3aed;
  border-color: #7c3aed;
}
.filter-tab.active.tab-linebot {
  background: #d97706;
  border-color: #d97706;
}

/* ===== 記錄卡片 ===== */
.log-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.log-card {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  box-shadow: var(--shadow-sm);
}
.log-card.disabled {
  opacity: 0.6;
}
.log-card.latest {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 2px var(--primary-light);
}
.log-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
.log-header h3 {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}
.log-meta {
  font-size: 13px;
  color: var(--text-secondary);
}
.log-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.latest-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  background: #dcfce7;
  color: #16a34a;
  margin-left: 8px;
}
.source-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  margin-left: 8px;
}
.source-badge.admin {
  background: #dbeafe;
  color: #2563eb;
}
.source-badge.linebot {
  background: #fef3c7;
  color: #d97706;
}
.source-badge.ai {
  background: #f3e8ff;
  color: #7c3aed;
}

/* ===== 變更內容 ===== */
.diff-section {
  margin-top: 16px;
  padding: 16px;
  background: #f8fafc;
  border-radius: 8px;
}
.diff-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
}
.diff-empty {
  color: #94a3b8;
}
.diff-item {
  display: flex;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid #e2e8f0;
}
.diff-item:last-child {
  border-bottom: none;
}
.diff-date {
  font-weight: 500;
  min-width: 100px;
}
.diff-service {
  color: var(--primary-color);
  min-width: 80px;
}
.diff-value {
  color: var(--text-primary);
}

/* ===== 還原按鈕 ===== */
.restore-btn {
  background: #f97316;
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: background 0.2s;
}
.restore-btn:hover:not(:disabled) {
  background: #ea580c;
}
.restore-btn:disabled {
  background: #d1d5db;
  cursor: not-allowed;
}

.toggle-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
}
.toggle-btn:hover {
  background: var(--bg-hover);
}

.no-logs {
  text-align: center;
  color: var(--text-secondary);
  padding: 60px 20px;
}

.warning-text {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  color: #991b1b;
}
</style>
