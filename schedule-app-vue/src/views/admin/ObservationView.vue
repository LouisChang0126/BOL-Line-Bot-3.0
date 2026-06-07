<script setup lang="ts">
/**
 * 使用數據觀察（LINE Bot 使用數據儀表板，舊版 edit-chart/observation.html）。
 *
 * 載入全部使用者的 `usage_count`，依所選月份彙整：
 *  - Push Message 用量（依 line_bot_id 分組，每支 Bot 額度 200）
 *  - 指令使用分布（doughnut）
 *  - 調班通知分布（doughnut）
 *  - 活躍用戶排行（Top 10，前三名獎牌）
 *  - 最近 6 個月分類趨勢（多折線）
 *  - 統計卡片：有使用人數、活躍人數(≥5)、活躍率、調班成功率
 * Chart.js 圖表透過 UsageChart 包裝元件渲染，月份切換時自動銷毀重建。
 */
import { computed, onMounted, ref } from 'vue'
import type { ChartData, ChartOptions } from 'chart.js'
import UsageChart from '@/components/admin/UsageChart.vue'
import { loadAllUsers } from '@/services/users'
import type { UserDoc } from '@/types'

// ── 常數 ──────────────────────────────────────────────
const PUSH_QUOTA = 200
const COMMAND_TYPES = ['全部班表', '當週班表', '換班', '代班', '設定提醒', '目錄'] as const
const PUSH_KEYS = ['調班/代班成功通知', '調班/代班失敗通知', '調班/代班請求', '服事提醒'] as const
const TREND_CATEGORIES = ['全部班表', '當週班表', '換班', '代班', '設定提醒', 'Push Message'] as const

const COMMAND_COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4']
const SHIFT_COLORS = ['#10b981', '#ef4444', '#3b82f6']
const TREND_COLORS: Record<string, string> = {
  全部班表: '#3b82f6',
  當週班表: '#8b5cf6',
  換班: '#ec4899',
  代班: '#f59e0b',
  設定提醒: '#10b981',
  'Push Message': '#ef4444',
}

// ── 狀態 ──────────────────────────────────────────────
const loading = ref(true)
const errorMsg = ref('')
const users = ref<Record<string, UserDoc>>({})
const selectedMonth = ref('')

// ── 月份工具 ──────────────────────────────────────────
/** 把 "YYYY_MM" 或 "YYYY.MM" 拆成 [year, month]（month 去除前導 0 的數字字串由呼叫端處理） */
function splitMonthKey(key: string): [string, string] {
  const parts = key.split(/[_.]/)
  return [parts[0] ?? '', parts[1] ?? '']
}
/** 正規化成可排序字串 "YYYY-MM"（兩種分隔符一致化） */
function normalizeMonthKey(key: string): string {
  const [y, m] = splitMonthKey(key)
  return `${y}-${m.padStart(2, '0')}`
}
/** 選單顯示：YYYY 年 M 月 */
function formatMonthLabel(key: string): string {
  const [y, m] = splitMonthKey(key)
  return `${y} 年 ${parseInt(m, 10)} 月`
}
/** 趨勢圖座標：YYYY/MM */
function formatTrendLabel(key: string): string {
  const [y, m] = splitMonthKey(key)
  return `${y}/${m}`
}

// ── 可用月份（所有用戶 usage_count 有資料的月份聯集，最新在前）──
const availableMonths = computed<string[]>(() => {
  const set = new Set<string>()
  for (const user of Object.values(users.value)) {
    const usage = user.usage_count ?? {}
    for (const month of Object.keys(usage)) {
      if (Object.keys(usage[month] ?? {}).length > 0) set.add(month)
    }
  }
  const sorted = Array.from(set).sort((a, b) =>
    normalizeMonthKey(b).localeCompare(normalizeMonthKey(a)),
  )
  if (sorted.length === 0) {
    const now = new Date()
    sorted.push(`${now.getFullYear()}_${String(now.getMonth() + 1).padStart(2, '0')}`)
  }
  return sorted
})

// ── 彙整當前月份資料 ──────────────────────────────────
interface AggregatedData {
  pushMessageUsageByBot: Record<number, number>
  commandStats: Record<string, number>
  shiftStats: { success: number; failure: number; request: number }
  userRankings: { name: string; count: number }[]
  activeUsers: number
  veryActiveUsers: number
  monthlyTrends: Record<string, Record<string, number>>
}

const aggregated = computed<AggregatedData>(() => {
  const month = selectedMonth.value
  const data: AggregatedData = {
    pushMessageUsageByBot: {},
    commandStats: {},
    shiftStats: { success: 0, failure: 0, request: 0 },
    userRankings: [],
    activeUsers: 0,
    veryActiveUsers: 0,
    monthlyTrends: {},
  }

  const commandSet: ReadonlyArray<string> = COMMAND_TYPES
  const pushSet: ReadonlyArray<string> = PUSH_KEYS

  for (const [name, user] of Object.entries(users.value)) {
    const usageCount = user.usage_count ?? {}
    const lineBotId = user.line_bot_id ?? 0

    const addPush = (count: number) => {
      if (lineBotId > 0) {
        data.pushMessageUsageByBot[lineBotId] =
          (data.pushMessageUsageByBot[lineBotId] ?? 0) + count
      }
    }

    // 當前選擇月份
    const monthData = usageCount[month] ?? {}
    let userTotal = 0
    for (const [key, count] of Object.entries(monthData)) {
      userTotal += count
      if (commandSet.includes(key)) {
        data.commandStats[key] = (data.commandStats[key] ?? 0) + count
      } else if (key === '調班/代班成功通知') {
        data.shiftStats.success += count
        addPush(count)
      } else if (key === '調班/代班失敗通知') {
        data.shiftStats.failure += count
        addPush(count)
      } else if (key === '調班/代班請求') {
        data.shiftStats.request += count
        addPush(count)
      } else if (key === '服事提醒') {
        addPush(count)
      }
    }

    if (userTotal > 0) {
      data.activeUsers++
      if (userTotal >= 5) data.veryActiveUsers++
      data.userRankings.push({ name, count: userTotal })
    }

    // 月份趨勢（分類統計，跨所有月份累積）
    for (const [m, md] of Object.entries(usageCount)) {
      const bucket =
        data.monthlyTrends[m] ??
        (data.monthlyTrends[m] = {
          全部班表: 0,
          當週班表: 0,
          換班: 0,
          代班: 0,
          設定提醒: 0,
          'Push Message': 0,
        })
      for (const [key, count] of Object.entries(md)) {
        if (commandSet.includes(key)) {
          bucket[key] += count
        } else if (pushSet.includes(key)) {
          bucket['Push Message'] += count
        }
      }
    }
  }

  data.userRankings.sort((a, b) => b.count - a.count)
  data.userRankings = data.userRankings.slice(0, 10)
  return data
})

// ── 衍生顯示值 ────────────────────────────────────────
const sortedBotIds = computed(() =>
  Object.keys(aggregated.value.pushMessageUsageByBot)
    .map(Number)
    .sort((a, b) => a - b),
)

const pushSummary = computed(() =>
  sortedBotIds.value.map((id) => {
    const count = aggregated.value.pushMessageUsageByBot[id]
    return {
      id,
      count,
      pct: ((count / PUSH_QUOTA) * 100).toFixed(1),
    }
  }),
)

const shiftSuccessRate = computed(() => {
  const { success, request } = aggregated.value.shiftStats
  return request > 0 ? Math.round((success / request) * 100) : 0
})

const engagementRate = computed(() => {
  const { activeUsers, veryActiveUsers } = aggregated.value
  return activeUsers > 0 ? Math.round((veryActiveUsers / activeUsers) * 100) : 0
})

const rankingMedal = (index: number): string =>
  index === 0 ? 'gold' : index === 1 ? 'silver' : index === 2 ? 'bronze' : 'normal'

// ── Chart.js 設定（computed → 月份切換自動重建）──────────

// 1. Push Message 用量（水平堆疊長條：已用 vs 剩餘）
const pushChartData = computed<ChartData<'bar'>>(() => {
  const ids = sortedBotIds.value
  const usages = ids.map((id) => aggregated.value.pushMessageUsageByBot[id])
  const remainings = usages.map((u) => Math.max(0, PUSH_QUOTA - u))
  const colors = usages.map((u) => {
    const p = u / PUSH_QUOTA
    return p > 0.8 ? '#ef4444' : p > 0.6 ? '#f59e0b' : '#10b981'
  })
  return {
    labels: ids.map((id) => `LINE Bot ${id}`),
    datasets: [
      { label: '已使用', data: usages, backgroundColor: colors, borderRadius: 8 },
      { label: '剩餘', data: remainings, backgroundColor: '#e5e7eb', borderRadius: 8 },
    ],
  }
})
const pushChartOptions: ChartOptions<'bar'> = {
  indexAxis: 'y',
  responsive: true,
  maintainAspectRatio: false,
  scales: {
    x: {
      stacked: true,
      max: PUSH_QUOTA,
      ticks: { callback: (value) => `${value} 次` },
    },
    y: { stacked: true },
  },
  plugins: {
    legend: { display: true, position: 'bottom' },
    tooltip: {
      callbacks: {
        label: (ctx) => `${ctx.dataset.label}: ${ctx.parsed.x} 次`,
      },
    },
  },
}

// 2. 指令使用分布（doughnut）
const commandChartData = computed<ChartData<'doughnut'>>(() => {
  const labels = Object.keys(aggregated.value.commandStats)
  return {
    labels,
    datasets: [
      {
        data: labels.map((l) => aggregated.value.commandStats[l]),
        backgroundColor: COMMAND_COLORS,
        borderWidth: 2,
        borderColor: '#fff',
      },
    ],
  }
})

// 3. 調班通知分布（doughnut）
const shiftChartData = computed<ChartData<'doughnut'>>(() => {
  const s = aggregated.value.shiftStats
  return {
    labels: ['調班成功通知', '調班失敗通知', '調班請求'],
    datasets: [
      {
        data: [s.success, s.failure, s.request],
        backgroundColor: SHIFT_COLORS,
        borderWidth: 2,
        borderColor: '#fff',
      },
    ],
  }
})

const doughnutOptions: ChartOptions<'doughnut'> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { position: 'bottom' } },
}

// 4. 使用趨勢（最近 6 個月，多折線）
const trendMonths = computed(() =>
  Object.keys(aggregated.value.monthlyTrends)
    .sort((a, b) => normalizeMonthKey(a).localeCompare(normalizeMonthKey(b)))
    .slice(-6),
)
const trendChartData = computed<ChartData<'line'>>(() => {
  const months = trendMonths.value
  return {
    labels: months.map(formatTrendLabel),
    datasets: TREND_CATEGORIES.map((category) => ({
      label: category,
      data: months.map((m) => aggregated.value.monthlyTrends[m]?.[category] ?? 0),
      borderColor: TREND_COLORS[category],
      backgroundColor: TREND_COLORS[category] + '33',
      tension: 0.4,
      fill: false,
      pointRadius: 4,
      pointHoverRadius: 6,
    })),
  }
})
const trendChartOptions: ChartOptions<'line'> = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: true, position: 'bottom' } },
  scales: {
    y: { beginAtZero: true, ticks: { callback: (value) => `${value} 次` } },
  },
}

// ── 載入 ──────────────────────────────────────────────
async function loadData() {
  loading.value = true
  errorMsg.value = ''
  try {
    users.value = await loadAllUsers()
    // 若尚未選月份，或所選月份已不存在，預設為最新月份
    if (!selectedMonth.value || !availableMonths.value.includes(selectedMonth.value)) {
      selectedMonth.value = availableMonths.value[0] ?? ''
    }
  } catch (e) {
    console.error('載入數據失敗:', e)
    errorMsg.value = '載入失敗，請檢查網路連線後重試'
  } finally {
    loading.value = false
  }
}

onMounted(loadData)
</script>

<template>
  <div class="observation-page">
    <div class="page-header">
      <div class="header-left">
        <router-link to="/admin" class="btn btn-secondary back-btn">← 返回</router-link>
        <h1>📊 使用數據觀察</h1>
      </div>
      <div class="header-controls">
        <div class="month-selector">
          <label for="monthSelect">選擇月份：</label>
          <select id="monthSelect" v-model="selectedMonth" :disabled="loading">
            <option v-for="m in availableMonths" :key="m" :value="m">
              {{ formatMonthLabel(m) }}
            </option>
          </select>
        </div>
        <button class="btn btn-primary refresh-btn" :disabled="loading" @click="loadData">
          🔄 刷新
        </button>
      </div>
    </div>

    <!-- 載入中 -->
    <div v-if="loading" class="state-box">
      <div class="spinner"></div>
      <div>載入數據中...</div>
    </div>

    <!-- 錯誤 -->
    <div v-else-if="errorMsg" class="state-box error">
      <div class="error-icon">⚠️</div>
      <div>{{ errorMsg }}</div>
      <button class="btn btn-primary" @click="loadData">重試</button>
    </div>

    <!-- 儀表板 -->
    <div v-else class="dashboard-grid">
      <!-- Push Message 使用量 -->
      <div class="dashboard-card full-width">
        <div class="card-header">
          <h2 class="card-title">📮 Push Message 使用量（依 Line Bot）</h2>
          <span class="card-icon">📊</span>
        </div>
        <div class="chart-container small">
          <UsageChart
            v-if="sortedBotIds.length"
            type="bar"
            :data="pushChartData"
            :options="pushChartOptions"
          />
          <p v-else class="empty-hint">本月份無 Push Message 資料</p>
        </div>
        <p v-if="pushSummary.length" class="push-summary">
          <template v-for="(b, i) in pushSummary" :key="b.id">
            <span v-if="i > 0"> | </span>Bot {{ b.id }}: {{ b.count }} / {{ PUSH_QUOTA }} 次
            ({{ b.pct }}%)
          </template>
        </p>
      </div>

      <!-- 指令使用分布 -->
      <div class="dashboard-card">
        <div class="card-header">
          <h2 class="card-title">⌨️ 指令使用分布</h2>
          <span class="card-icon">📈</span>
        </div>
        <div class="chart-container">
          <UsageChart
            v-if="commandChartData.labels?.length"
            type="doughnut"
            :data="commandChartData"
            :options="doughnutOptions"
          />
          <p v-else class="empty-hint">本月份無指令資料</p>
        </div>
      </div>

      <!-- 調班通知分布 -->
      <div class="dashboard-card">
        <div class="card-header">
          <h2 class="card-title">🔄 調班通知分布</h2>
          <span class="card-icon">📊</span>
        </div>
        <div class="chart-container">
          <UsageChart type="doughnut" :data="shiftChartData" :options="doughnutOptions" />
        </div>
      </div>

      <!-- 活躍用戶排行榜 -->
      <div class="dashboard-card double-height">
        <div class="card-header">
          <h2 class="card-title">🏆 活躍用戶排行榜 (Top 10)</h2>
          <span class="card-icon">👑</span>
        </div>
        <div class="chart-container ranking">
          <ul v-if="aggregated.userRankings.length" class="ranking-list">
            <li
              v-for="(user, index) in aggregated.userRankings"
              :key="user.name"
              class="ranking-item"
            >
              <div class="ranking-left">
                <span class="ranking-badge" :class="rankingMedal(index)">{{ index + 1 }}</span>
                <span class="ranking-name">{{ user.name }}</span>
              </div>
              <span class="ranking-count">{{ user.count }} 次</span>
            </li>
          </ul>
          <p v-else class="empty-hint">本月份無使用者活動</p>
        </div>
      </div>

      <!-- 調班成功率 -->
      <div class="dashboard-card stat-card">
        <div class="card-header">
          <h2 class="card-title">✅ 調班成功率</h2>
          <span class="card-icon">📈</span>
        </div>
        <div class="stat-value">{{ shiftSuccessRate }}%</div>
        <div class="stat-label">
          成功 {{ aggregated.shiftStats.success }} / 請求 {{ aggregated.shiftStats.request }}
        </div>
      </div>

      <!-- 用戶活躍度統計 -->
      <div class="dashboard-card">
        <div class="card-header">
          <h2 class="card-title">👥 用戶活躍度</h2>
          <span class="card-icon">📊</span>
        </div>
        <div class="stat-grid">
          <div class="stat-item">
            <div class="stat-item-value">{{ aggregated.activeUsers }}</div>
            <div class="stat-item-label">有使用人數</div>
          </div>
          <div class="stat-item">
            <div class="stat-item-value">{{ aggregated.veryActiveUsers }}</div>
            <div class="stat-item-label">活躍人數<br />(≥5次)</div>
          </div>
          <div class="stat-item">
            <div class="stat-item-value">{{ engagementRate }}%</div>
            <div class="stat-item-label">活躍率</div>
          </div>
        </div>
      </div>

      <!-- 使用趨勢圖 -->
      <div class="dashboard-card full-width">
        <div class="card-header">
          <h2 class="card-title">📈 使用趨勢 (最近 6 個月)</h2>
          <span class="card-icon">📊</span>
        </div>
        <div class="chart-container tall">
          <UsageChart type="line" :data="trendChartData" :options="trendChartOptions" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.observation-page {
  max-width: 1400px;
  margin: 0 auto;
  padding: 32px;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  flex-wrap: wrap;
  gap: 16px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 16px;
}

.back-btn {
  padding: 6px 12px;
}

.page-header h1 {
  font-size: 28px;
  font-weight: 700;
  color: var(--text-primary);
}

.header-controls {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.month-selector {
  display: flex;
  align-items: center;
  gap: 8px;
  background: white;
  padding: 8px 16px;
  border-radius: 12px;
  box-shadow: var(--shadow-sm);
  font-size: 14px;
}

.month-selector select {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 14px;
  cursor: pointer;
  font-family: inherit;
}

.refresh-btn {
  padding: 8px 16px;
}

/* 載入 / 錯誤狀態 */
.state-box {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.state-box .error-icon {
  font-size: 48px;
}

.spinner {
  border: 3px solid var(--gray-100);
  border-top: 3px solid var(--primary-color);
  border-radius: 50%;
  width: 40px;
  height: 40px;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* 儀表板格線 */
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}

.dashboard-card {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 24px;
  box-shadow: var(--shadow-sm);
  transition: transform 0.2s, box-shadow 0.2s;
}

.dashboard-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.dashboard-card.full-width {
  grid-column: 1 / -1;
}

.dashboard-card.double-height {
  grid-row: span 2;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.card-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.card-icon {
  font-size: 24px;
}

.chart-container {
  position: relative;
  height: 300px;
}

.chart-container.small {
  height: 150px;
}

.chart-container.tall {
  height: 400px;
}

.chart-container.ranking {
  height: 100%;
  max-height: 600px;
  overflow-y: auto;
}

.empty-hint {
  text-align: center;
  color: var(--text-light);
  font-size: 14px;
  padding-top: 40px;
}

.push-summary {
  text-align: center;
  margin-top: 12px;
  color: var(--text-secondary);
  font-size: 13px;
}

/* 統計卡 */
.stat-card {
  text-align: center;
}

.stat-value {
  font-size: 48px;
  font-weight: 700;
  color: var(--primary-color);
  margin: 16px 0;
}

.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 16px;
  margin-top: 20px;
}

.stat-item {
  background: #f8fafc;
  padding: 16px;
  border-radius: 12px;
  text-align: center;
}

.stat-item-value {
  font-size: 32px;
  font-weight: 700;
  color: var(--primary-color);
}

.stat-item-label {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* 排行榜 */
.ranking-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.ranking-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  margin-bottom: 8px;
  background: #f8fafc;
  border-radius: 8px;
  transition: background 0.2s;
}

.ranking-item:hover {
  background: #e2e8f0;
}

.ranking-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.ranking-badge {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 14px;
}

.ranking-badge.gold {
  background: linear-gradient(135deg, #ffd700, #ffed4e);
  color: #92400e;
}

.ranking-badge.silver {
  background: linear-gradient(135deg, #c0c0c0, #e8e8e8);
  color: #374151;
}

.ranking-badge.bronze {
  background: linear-gradient(135deg, #cd7f32, #e8a87c);
  color: #78350f;
}

.ranking-badge.normal {
  background: #e2e8f0;
  color: #64748b;
}

.ranking-name {
  font-weight: 600;
  color: var(--text-primary);
}

.ranking-count {
  font-size: 18px;
  font-weight: 700;
  color: var(--primary-color);
}

/* 響應式 */
@media (max-width: 1024px) {
  .dashboard-grid {
    grid-template-columns: 1fr;
  }

  .dashboard-card.double-height {
    grid-row: span 1;
  }
}

@media (max-width: 768px) {
  .observation-page {
    padding: 16px;
  }

  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
</style>
