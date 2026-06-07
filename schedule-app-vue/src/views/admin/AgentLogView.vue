<script setup lang="ts">
/**
 * AI 助手記錄儀表板（移植自舊版 edit-chart/agent_log_dashboard.html）。
 *
 * 功能：
 *   - 分頁讀取 agent_log（依 wall_clock_utc 倒序），「載入更多」接續分頁。
 *   - 統計卡片：總呼叫數 / 成功率 / 平均推論時間 / 估計總花費 / 模式分布 / Provider 分布。
 *   - 篩選：模式 tabs（全部 / 排班 / 問答 / 失敗）＋ 崇拜下拉。
 *   - 模型定價面板：可編輯各模型 input/output 單價與 USD→TWD 匯率，存於 localStorage。
 *   - 每筆記錄可展開看 system prompt / thinking / messages / response_body /
 *     scheduleData（表格 / JSON 切換）。
 *
 * 所有使用者可控文字一律走 Vue template 文字插值自動跳脫，不使用 v-html。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { loadAgentLogsPage } from '@/services/agentLogs'
import { loadServeList } from '@/services/serves'
import type { AgentLog, AgentLogMessage } from '@/types'
import type { QueryDocumentSnapshot } from 'firebase/firestore'

// ===== 模型定價（localStorage 持久化） =====
// 預設參考值（USD / 1M tokens）。若合約價不同，按「模型定價」按鈕修改。
const PRICING_STORAGE_KEY = 'agent_log_pricing_v1'
const EXCHANGE_STORAGE_KEY = 'agent_log_exchange_rate_v1'
const DEFAULT_EXCHANGE_RATE = 31.5

interface ModelPrice {
  input: number
  output: number
}
type PricingTable = Record<string, ModelPrice>

const DEFAULT_PRICING: PricingTable = {
  // Anthropic
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  // Gemini
  'gemini-3.1-pro-preview': { input: 2, output: 12 },
  'gemini-3.5-flash': { input: 1.5, output: 9 },
  'gemini-3-flash': { input: 0.5, output: 3 },
  // DeepSeek
  'deepseek-v4-pro': { input: 0.43, output: 0.87 },
  'deepseek-v4-flash': { input: 0.11, output: 0.22 },
}

function loadPricing(): PricingTable {
  try {
    const raw = localStorage.getItem(PRICING_STORAGE_KEY)
    if (!raw) return { ...DEFAULT_PRICING }
    const parsed = JSON.parse(raw) as PricingTable
    // 與預設合併（保留自訂的同時也撿到新加入的預設模型）
    return { ...DEFAULT_PRICING, ...parsed }
  } catch {
    return { ...DEFAULT_PRICING }
  }
}

function savePricing(p: PricingTable): void {
  try {
    localStorage.setItem(PRICING_STORAGE_KEY, JSON.stringify(p))
  } catch (err) {
    console.warn('pricing save failed:', err)
  }
}

function loadExchangeRate(): number {
  try {
    const raw = localStorage.getItem(EXCHANGE_STORAGE_KEY)
    if (!raw) return DEFAULT_EXCHANGE_RATE
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_EXCHANGE_RATE
  } catch {
    return DEFAULT_EXCHANGE_RATE
  }
}

function saveExchangeRate(rate: number): void {
  try {
    localStorage.setItem(EXCHANGE_STORAGE_KEY, String(rate))
  } catch (err) {
    console.warn('exchange rate save failed:', err)
  }
}

// ===== 響應式狀態 =====
const allLogs = ref<AgentLog[]>([])
const lastDoc = ref<QueryDocumentSnapshot | null>(null)
const hasMore = ref(true)
const loading = ref(true) // 第一頁載入中
const loadingMore = ref(false)
const errorMsg = ref('')

type FilterKey = 'all' | 'scheduling' | 'edit_qa' | 'failed'
const currentFilter = ref<FilterKey>('all')
const currentServeFilter = ref('all')

// serve-id → { name, emoji }
const serveMap = reactive<Record<string, { name: string; emoji: string }>>({})

const pricing = ref<PricingTable>(loadPricing())
const exchangeRate = ref<number>(loadExchangeRate())

// 定價面板（編輯草稿，按「儲存」才套用）
const pricingPanelOpen = ref(false)
const draftPrices = reactive<Record<string, { input: string; output: string }>>({})
const draftExchangeRate = ref<string>(String(exchangeRate.value))

// 展開詳情的 log id 集合
const expandedIds = reactive<Set<string>>(new Set())
// 每筆 scheduleData 的檢視模式：table | json（預設 table）
const scheduleViewMode = reactive<Record<string, 'table' | 'json'>>({})

const filterTabs: { key: FilterKey; label: string; cls: string }[] = [
  { key: 'all', label: '全部', cls: '' },
  { key: 'scheduling', label: '📋 排班', cls: 'tab-scheduling' },
  { key: 'edit_qa', label: '💬 問答', cls: 'tab-edit_qa' },
  { key: 'failed', label: '⚠️ 失敗', cls: 'tab-failed' },
]

// ===== 載入 =====
onMounted(async () => {
  await loadServes()
  await reloadAll()
})

async function loadServes(): Promise<void> {
  try {
    const serves = await loadServeList()
    for (const s of serves) {
      if (s && s.id) {
        serveMap[s.id] = { name: s.name || s.id, emoji: s.emoji || '' }
      }
    }
  } catch (err) {
    console.warn('載入 _config/serve-list 失敗:', err)
  }
}

async function reloadAll(): Promise<void> {
  allLogs.value = []
  lastDoc.value = null
  hasMore.value = true
  errorMsg.value = ''
  loading.value = true
  try {
    const page = await loadAgentLogsPage(null)
    allLogs.value = page.logs
    lastDoc.value = page.lastDoc
    hasMore.value = page.hasMore
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loadingMore.value || !lastDoc.value) return
  loadingMore.value = true
  try {
    const page = await loadAgentLogsPage(lastDoc.value)
    allLogs.value = [...allLogs.value, ...page.logs]
    lastDoc.value = page.lastDoc
    hasMore.value = page.hasMore
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err)
  } finally {
    loadingMore.value = false
  }
}

// ===== serve 顯示 / 篩選選項 =====
function formatServe(id: string | undefined): string {
  if (!id) return '(未指定)'
  const info = serveMap[id]
  if (!info) return id
  return `${info.emoji ? info.emoji + ' ' : ''}${info.name}`
}

// 把 logs 中出現過的 serve-id（即使 _config 沒登記也列出）合進選項
const serveOptions = computed<{ id: string; label: string }[]>(() => {
  const seen = new Set<string>()
  for (const l of allLogs.value) {
    const sid = l['serve-id']
    if (sid) seen.add(sid)
  }
  const ids = Array.from(new Set<string>([...Object.keys(serveMap), ...seen]))
  return ids.map((id) => ({ id, label: formatServe(id) }))
})

// ===== 篩選 =====
const filteredLogs = computed<AgentLog[]>(() => {
  let out = allLogs.value
  if (currentServeFilter.value !== 'all') {
    out = out.filter((l) => (l['serve-id'] || '') === currentServeFilter.value)
  }
  if (currentFilter.value === 'all') return out
  if (currentFilter.value === 'failed') return out.filter((l) => (l.status_code ?? 0) !== 200)
  return out.filter((l) => l.mode === currentFilter.value)
})

function setFilter(key: FilterKey): void {
  currentFilter.value = key
}

// ===== 花費估算 =====
/** 從 response_body（型別為 unknown 聯集）安全取出 usage。 */
function getUsage(log: AgentLog): { input: number; output: number } | null {
  const body = log.response_body
  if (!body || typeof body !== 'object') return null
  const usage = (body as Record<string, unknown>).usage
  if (!usage || typeof usage !== 'object') return null
  const u = usage as Record<string, unknown>
  const input = Number(u.input_tokens) || 0
  const output = Number(u.output_tokens) || 0
  if (input === 0 && output === 0) return null
  return { input, output }
}

/** 回傳該筆 log 的估計花費（USD），無 usage 或無定價時為 null。 */
function estimateCostUSD(log: AgentLog): number | null {
  const usage = getUsage(log)
  if (!usage) return null
  const model = log.model || ''
  const price = pricing.value[model]
  if (!price) return null
  return (usage.input * (Number(price.input) || 0) + usage.output * (Number(price.output) || 0)) / 1_000_000
}

/** 顯示用：USD → TWD 並格式化（NT$x.xx）。<0.01 → ≈NT$0；<100 → 2 位小數；else 0 位。 */
function formatCost(usd: number | null): string | null {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return null
  const twd = usd * exchangeRate.value
  if (twd < 0.01) return '≈NT$0'
  if (twd < 100) return `NT$${twd.toFixed(2)}`
  return `NT$${twd.toFixed(0)}`
}

function formatTwdTotal(twd: number): string {
  if (twd < 100) return `NT$${twd.toFixed(2)}`
  return `NT$${twd.toFixed(0)}`
}

// ===== 統計 =====
interface StatsResult {
  total: number
  todayCount: number
  weekCount: number
  successRate: string
  okCount: number
  avgTime: string
  timeN: number
  costLabel: string
  costSub: string
  modeDist: { key: string; n: number; pct: number }[]
  providerDist: { key: string; n: number; pct: number }[]
}

const stats = computed<StatsResult | null>(() => {
  const logs = filteredLogs.value
  if (logs.length === 0) return null

  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  // 週一作為一週起點
  const startOfWeek = new Date(startOfToday)
  const dayOfWeek = (startOfToday.getDay() + 6) % 7 // 週一 = 0
  startOfWeek.setDate(startOfToday.getDate() - dayOfWeek)

  let todayCount = 0
  let weekCount = 0
  let okCount = 0
  let timeSum = 0
  let timeN = 0
  let costSum = 0
  let costN = 0
  const costMissingModels = new Set<string>()
  const modeDistMap: Record<string, number> = {}
  const providerDistMap: Record<string, number> = {}

  for (const l of logs) {
    const ts = l.wall_clock_utc ? new Date(l.wall_clock_utc) : null
    if (ts && !Number.isNaN(ts.getTime())) {
      if (ts >= startOfToday) todayCount++
      if (ts >= startOfWeek) weekCount++
    }
    if ((l.status_code ?? 0) === 200) okCount++
    if (typeof l.inference_time === 'number') {
      timeSum += l.inference_time
      timeN++
    }
    const modeKey = l.mode || '(unknown)'
    modeDistMap[modeKey] = (modeDistMap[modeKey] || 0) + 1
    const providerKey = l.provider || '(unknown)'
    providerDistMap[providerKey] = (providerDistMap[providerKey] || 0) + 1

    const cost = estimateCostUSD(l)
    if (cost !== null) {
      costSum += cost
      costN++
    } else if (l.model && !pricing.value[l.model]) {
      costMissingModels.add(l.model)
    }
  }

  const total = logs.length
  const successRate = total > 0 ? ((okCount / total) * 100).toFixed(1) : '0.0'
  const avgTime = timeN > 0 ? (timeSum / timeN).toFixed(2) : '—'
  const costTwd = costSum * exchangeRate.value
  const costLabel = costN > 0 ? formatTwdTotal(costTwd) : '—'
  const costSubBase =
    costMissingModels.size > 0
      ? `缺少定價：${Array.from(costMissingModels).join(', ')}`
      : `基於 ${costN} 筆有 usage 與定價的記錄`
  const costSub =
    costN > 0
      ? `${costSubBase}（≈ $${costSum.toFixed(4)} USD，匯率 ${exchangeRate.value}）`
      : costSubBase

  const toDist = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([key, n]) => ({ key, n, pct: total > 0 ? (n / total) * 100 : 0 }))

  return {
    total,
    todayCount,
    weekCount,
    successRate,
    okCount,
    avgTime,
    timeN,
    costLabel,
    costSub,
    modeDist: toDist(modeDistMap),
    providerDist: toDist(providerDistMap),
  }
})

/** distribution bar fill 用的安全 class 名（與舊版 .stat-bar-fill.xxx 對齊）。 */
function distFillClass(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '_')
}

// ===== 每筆 log 的衍生顯示資料 =====
function isFailed(log: AgentLog): boolean {
  return (log.status_code ?? 0) !== 200
}

function modeBadgeClass(log: AgentLog): string {
  const modeKey = log.mode || 'unknown'
  return `badge-mode-${modeKey === 'scheduling' || modeKey === 'edit_qa' ? modeKey : 'edit_qa'}`
}

function modeKeyOf(log: AgentLog): string {
  return log.mode || 'unknown'
}

function truncatedCount(log: AgentLog): number {
  return log.truncated_fields?.length ?? 0
}

function formatTwTime(iso: string | undefined): string {
  if (!iso) return '(無時間)'
  try {
    return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })
  } catch {
    return iso
  }
}

function extractLastUserPrompt(messages: AgentLogMessage[] | undefined): string {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const c = messages[i].content
      return typeof c === 'string' ? c : JSON.stringify(c)
    }
  }
  return ''
}

function promptPreview(log: AgentLog): string {
  return extractLastUserPrompt(log.messages).slice(0, 200)
}

// stop_reason 各家命名不同；正常結束的隱藏，異常的醒目顯示
const STOP_NORMAL = ['', 'end_turn', 'stop', 'STOP', 'tool_use', 'tool_calls', 'tool_use_or_tool_calls']
const STOP_BAD = ['max_tokens', 'length', 'MAX_TOKENS', 'max_output_tokens']

interface StopBadge {
  text: string
  bad: boolean
}
function stopBadge(log: AgentLog): StopBadge | null {
  const stop = (log.stop_reason || '').toString()
  if (!stop || STOP_NORMAL.includes(stop)) return null
  const bad = STOP_BAD.map((s) => s.toLowerCase()).includes(stop.toLowerCase())
  return { text: stop, bad }
}

function messageContent(m: AgentLogMessage): string {
  return typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2)
}

// ===== 展開詳情 =====
function toggleDetail(id: string): void {
  if (expandedIds.has(id)) expandedIds.delete(id)
  else expandedIds.add(id)
}

// ===== response_body / scheduleData =====
function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

interface ScheduleRowLike {
  [k: string]: unknown
}

/** 從 response_body 取出 scheduleData（必須是陣列），否則 null。 */
function extractScheduleData(log: AgentLog): ScheduleRowLike[] | null {
  const body = log.response_body
  if (!body || typeof body !== 'object') return null
  const sd = (body as Record<string, unknown>).scheduleData
  if (!Array.isArray(sd)) return null
  return sd as ScheduleRowLike[]
}

/** 顯示用 response_body：若有 scheduleData 則換成 "..."，避免上方 JSON 塞滿整片。 */
function responseBodyForDisplay(log: AgentLog): unknown {
  const body = log.response_body
  if (!body || typeof body !== 'object') return body
  const rec = body as Record<string, unknown>
  if (!Array.isArray(rec.scheduleData)) return body
  return { ...rec, scheduleData: '...' }
}

function responseBodyText(log: AgentLog): string {
  return safeJsonStringify(responseBodyForDisplay(log))
}

function scheduleJsonText(log: AgentLog): string {
  return safeJsonStringify(extractScheduleData(log))
}

/** scheduleData 表格的欄位順序：date 永遠第一欄，其餘以第一筆出現順序保留。 */
function scheduleColumns(rows: ScheduleRowLike[]): string[] {
  const colOrder: string[] = []
  const colSet = new Set<string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    for (const k of Object.keys(row)) {
      if (k === 'date') continue
      if (!colSet.has(k)) {
        colSet.add(k)
        colOrder.push(k)
      }
    }
  }
  return ['date', ...colOrder]
}

/** 單一儲存格的顯示字串（陣列以「、」串接；物件轉 JSON；空值空字串）。 */
function scheduleCell(row: ScheduleRowLike, col: string): string {
  const v = row[col]
  if (Array.isArray(v)) return v.map((x) => String(x)).join('、')
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function isValidRow(row: ScheduleRowLike): boolean {
  return !!row && typeof row === 'object'
}

function setScheduleView(id: string, mode: 'table' | 'json'): void {
  scheduleViewMode[id] = mode
}
function getScheduleView(id: string): 'table' | 'json' {
  return scheduleViewMode[id] || 'table'
}

// ===== 定價面板 =====
/** 面板中要顯示的模型清單：預設清單 ∪ 已載入 logs 出現過的模型。 */
const pricingModels = computed<string[]>(() => {
  const seen = new Set<string>(Object.keys(pricing.value))
  for (const l of allLogs.value) {
    if (l.model) seen.add(l.model)
  }
  return Array.from(seen).sort()
})

function openPricingPanel(): void {
  pricingPanelOpen.value = !pricingPanelOpen.value
  if (pricingPanelOpen.value) syncDraftFromPricing()
}

/** 用目前生效中的 pricing / exchangeRate 重置草稿輸入。 */
function syncDraftFromPricing(): void {
  for (const k of Object.keys(draftPrices)) delete draftPrices[k]
  for (const m of pricingModels.value) {
    const p = pricing.value[m] || { input: 0, output: 0 }
    draftPrices[m] = { input: String(Number(p.input) || 0), output: String(Number(p.output) || 0) }
  }
  draftExchangeRate.value = String(exchangeRate.value)
}

function savePricingPanel(): void {
  const next: PricingTable = {}
  for (const m of Object.keys(draftPrices)) {
    const inVal = Number(draftPrices[m].input)
    const outVal = Number(draftPrices[m].output)
    if (Number.isFinite(inVal) && Number.isFinite(outVal) && (inVal > 0 || outVal > 0)) {
      next[m] = { input: inVal, output: outVal }
    }
  }
  pricing.value = { ...DEFAULT_PRICING, ...next }
  savePricing(next)

  // 匯率：非正數 → 退回預設值（避免被打成 0 害除錯困難）
  const rateVal = Number(draftExchangeRate.value)
  exchangeRate.value = Number.isFinite(rateVal) && rateVal > 0 ? rateVal : DEFAULT_EXCHANGE_RATE
  saveExchangeRate(exchangeRate.value)

  pricingPanelOpen.value = false
}

function resetPricingPanel(): void {
  if (!confirm('確定要回復所有模型的預設定價與匯率？你目前的自訂值會被清除。')) return
  try {
    localStorage.removeItem(PRICING_STORAGE_KEY)
    localStorage.removeItem(EXCHANGE_STORAGE_KEY)
  } catch (err) {
    console.warn('pricing reset failed:', err)
  }
  pricing.value = { ...DEFAULT_PRICING }
  exchangeRate.value = DEFAULT_EXCHANGE_RATE
  syncDraftFromPricing()
}
</script>

<template>
  <div class="admin-page">
    <div class="page-header">
      <router-link to="/admin" class="btn btn-secondary back-btn">← 返回</router-link>
      <h1>🤖 AI 助手記錄</h1>
      <button class="refresh-btn pricing-toggle" @click="openPricingPanel">💵 模型定價</button>
      <button class="refresh-btn" @click="reloadAll">🔄 刷新</button>
    </div>

    <!-- 模型定價面板 -->
    <div class="pricing-panel" :class="{ open: pricingPanelOpen }">
      <div class="pricing-header">
        <h2>💵 模型定價（USD / 1M tokens）</h2>
      </div>
      <div class="pricing-hint">
        估計花費 = (input_tokens × input 單價 + output_tokens × output 單價) / 1,000,000，再以匯率換算成台幣。<br />
        資料儲存於瀏覽器 localStorage，僅你本機可見。
      </div>
      <div class="exchange-rate-row">
        <label for="exchangeRateInput">USD → TWD 匯率</label>
        <input id="exchangeRateInput" v-model="draftExchangeRate" type="number" step="0.01" min="0" />
        <span class="hint">預設 31.5；改動後按下方「儲存」生效</span>
      </div>
      <div class="pricing-table-wrap">
        <table v-if="pricingModels.length" class="pricing-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Input ($/MTok)</th>
              <th>Output ($/MTok)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in pricingModels" :key="m">
              <td><code>{{ m }}</code></td>
              <td>
                <input
                  v-if="draftPrices[m]"
                  v-model="draftPrices[m].input"
                  type="number"
                  step="0.01"
                  min="0"
                />
              </td>
              <td>
                <input
                  v-if="draftPrices[m]"
                  v-model="draftPrices[m].output"
                  type="number"
                  step="0.01"
                  min="0"
                />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else class="pricing-empty">尚無模型資料</div>
      </div>
      <div class="pricing-actions">
        <button class="btn btn-secondary" @click="resetPricingPanel">回復預設值</button>
        <button class="btn btn-primary" @click="savePricingPanel">儲存</button>
      </div>
    </div>

    <!-- 統計卡片 -->
    <div class="stats-grid">
      <div v-if="loading" class="no-logs span-all">載入中...</div>
      <div v-else-if="errorMsg" class="no-logs span-all">載入失敗：{{ errorMsg }}</div>
      <div v-else-if="!stats" class="no-logs span-all">沒有符合的記錄</div>
      <template v-else>
        <div class="stat-card">
          <div class="stat-card-title">總呼叫數（已載入）</div>
          <div class="stat-card-value">{{ stats.total }}</div>
          <div class="stat-card-sub">今日 {{ stats.todayCount }} / 本週 {{ stats.weekCount }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">成功率</div>
          <div class="stat-card-value">{{ stats.successRate }}%</div>
          <div class="stat-card-sub">成功 {{ stats.okCount }} / 失敗 {{ stats.total - stats.okCount }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">平均推論時間</div>
          <div class="stat-card-value">{{ stats.avgTime }}{{ stats.avgTime === '—' ? '' : ' s' }}</div>
          <div class="stat-card-sub">基於 {{ stats.timeN }} 筆有計時的記錄</div>
        </div>
        <div class="stat-card">
          <div class="stat-card-title">💵 估計總花費</div>
          <div class="stat-card-value">{{ stats.costLabel }}</div>
          <div class="stat-card-sub">{{ stats.costSub }}</div>
        </div>
        <div class="stat-card wide">
          <div class="stat-card-title">模式分布</div>
          <div v-if="stats.modeDist.length" class="stat-bar-list">
            <div v-for="d in stats.modeDist" :key="d.key" class="stat-bar-row">
              <span class="stat-bar-label">{{ d.key }}</span>
              <div class="stat-bar-track">
                <div class="stat-bar-fill" :class="distFillClass(d.key)" :style="{ width: d.pct + '%' }"></div>
              </div>
              <span class="stat-bar-count">{{ d.n }}</span>
            </div>
          </div>
          <div v-else class="stat-card-sub">無資料</div>
        </div>
        <div class="stat-card wide">
          <div class="stat-card-title">Provider 分布</div>
          <div v-if="stats.providerDist.length" class="stat-bar-list">
            <div v-for="d in stats.providerDist" :key="d.key" class="stat-bar-row">
              <span class="stat-bar-label">{{ d.key }}</span>
              <div class="stat-bar-track">
                <div class="stat-bar-fill" :class="distFillClass(d.key)" :style="{ width: d.pct + '%' }"></div>
              </div>
              <span class="stat-bar-count">{{ d.n }}</span>
            </div>
          </div>
          <div v-else class="stat-card-sub">無資料</div>
        </div>
      </template>
    </div>

    <!-- 篩選列 -->
    <div class="filter-row">
      <div class="filter-tabs">
        <button
          v-for="t in filterTabs"
          :key="t.key"
          class="filter-tab"
          :class="[t.cls, { active: currentFilter === t.key }]"
          @click="setFilter(t.key)"
        >
          {{ t.label }}
        </button>
      </div>
      <div class="serve-filter">
        <label for="serveFilter">崇拜：</label>
        <select id="serveFilter" v-model="currentServeFilter">
          <option value="all">全部崇拜</option>
          <option v-for="opt in serveOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
        </select>
      </div>
    </div>

    <!-- 列表 -->
    <div class="log-list">
      <div v-if="loading" class="no-logs">載入中...</div>
      <div v-else-if="errorMsg" class="no-logs">載入失敗：{{ errorMsg }}</div>
      <div v-else-if="filteredLogs.length === 0" class="no-logs">沒有符合的 AI 互動記錄</div>

      <template v-else>
        <div v-for="log in filteredLogs" :key="log.id" class="log-card" :class="{ failed: isFailed(log) }">
        <div class="log-header">
          <div class="log-header-main">
            <div class="log-title">
              <span class="badge badge-serve">
                {{ log['serve-id'] ? formatServe(log['serve-id']) : '(未指定崇拜)' }}
              </span>
              <span class="badge" :class="modeBadgeClass(log)">{{ modeKeyOf(log) }}</span>
              <span class="badge badge-provider">{{ log.provider || '?' }} / {{ log.model || '?' }}</span>
              <span class="badge" :class="isFailed(log) ? 'badge-status-fail' : 'badge-status-ok'">
                {{ log.status_code ?? '?' }}
              </span>
              <span v-if="typeof log.inference_time === 'number'" class="badge badge-provider">
                {{ log.inference_time.toFixed(2) }}s
              </span>
              <span v-if="log.enable_thinking" class="badge badge-thinking">🧠 思考</span>
              <span
                v-if="stopBadge(log)"
                class="badge"
                :class="stopBadge(log)!.bad ? 'badge-stop-bad' : 'badge-stop-info'"
              >
                ⛔ {{ stopBadge(log)!.text }}
              </span>
              <span v-if="formatCost(estimateCostUSD(log))" class="badge badge-cost">
                💵 {{ formatCost(estimateCostUSD(log)) }}
              </span>
              <span v-if="truncatedCount(log) > 0" class="badge badge-truncated">
                ⚠️ {{ truncatedCount(log) }} 欄位被截斷
              </span>
            </div>
            <div class="log-meta">{{ formatTwTime(log.wall_clock_utc) }} · doc id <code>{{ log.id }}</code></div>
            <div class="log-prompt-preview">
              <span v-if="promptPreview(log)">{{ promptPreview(log) }}</span>
              <em v-else>(無 user prompt)</em>
            </div>
          </div>
          <button class="toggle-btn" @click="toggleDetail(log.id)">
            {{ expandedIds.has(log.id) ? '收起詳情' : '展開詳情' }}
          </button>
        </div>

        <!-- 詳情 -->
        <div v-if="expandedIds.has(log.id)" class="detail-section open">
          <div v-if="truncatedCount(log) > 0" class="truncate-warning">
            ⚠️ 此筆 {{ (log.truncated_fields || []).join('、') }} 欄位已截斷，完整內容請查 Firestore Console（doc id
            <code>{{ log.id }}</code>）
          </div>

          <div class="detail-block">
            <div class="detail-block-title">System Prompt</div>
            <pre>{{ log.system_prompt || '(空)' }}</pre>
          </div>

          <div v-if="(log.thinking || '').trim()" class="detail-block">
            <div class="detail-block-title">🧠 Thinking</div>
            <pre class="thinking-pre">{{ (log.thinking || '').trim() }}</pre>
          </div>

          <div class="detail-block">
            <div class="detail-block-title">Messages（{{ (log.messages || []).length }} 則）</div>
            <template v-if="(log.messages || []).length">
              <div v-for="(m, idx) in log.messages" :key="idx" class="message-row">
                <div class="message-role">{{ m.role || '?' }}</div>
                <div class="message-content">{{ messageContent(m) }}</div>
              </div>
            </template>
            <em v-else>(無 messages)</em>
          </div>

          <div class="detail-block">
            <div class="detail-block-title">Response Body</div>
            <pre>{{ responseBodyText(log) }}</pre>
          </div>

          <div v-if="extractScheduleData(log)" class="detail-block schedule-block">
            <div class="detail-block-title">
              Schedule Data（{{ extractScheduleData(log)!.length }} 列）
              <span class="view-toggle">
                <button
                  type="button"
                  :class="{ active: getScheduleView(log.id) === 'table' }"
                  @click="setScheduleView(log.id, 'table')"
                >
                  表格
                </button>
                <button
                  type="button"
                  :class="{ active: getScheduleView(log.id) === 'json' }"
                  @click="setScheduleView(log.id, 'json')"
                >
                  JSON
                </button>
              </span>
            </div>

            <div v-if="getScheduleView(log.id) === 'table'">
              <div v-if="extractScheduleData(log)!.length === 0" class="schedule-empty">(空)</div>
              <div v-else class="schedule-table-wrap">
                <table class="schedule-table">
                  <thead>
                    <tr>
                      <th v-for="c in scheduleColumns(extractScheduleData(log)!)" :key="c">{{ c }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <template v-for="(row, ri) in extractScheduleData(log)" :key="ri">
                      <tr v-if="isValidRow(row)">
                        <td
                          v-for="c in scheduleColumns(extractScheduleData(log)!)"
                          :key="c"
                          :class="{ 'date-cell': c === 'date' }"
                        >
                          {{ scheduleCell(row, c) }}
                        </td>
                      </tr>
                      <tr v-else>
                        <td :colspan="scheduleColumns(extractScheduleData(log)!).length"><em>(invalid row)</em></td>
                      </tr>
                    </template>
                  </tbody>
                </table>
              </div>
            </div>
            <pre v-else>{{ scheduleJsonText(log) }}</pre>
          </div>
        </div>
        </div>
      </template>
    </div>

    <!-- 載入更多 -->
    <div v-if="!loading && !errorMsg && filteredLogs.length > 0" class="load-more-wrap">
      <button class="load-more-btn" :disabled="!hasMore || loadingMore" @click="loadMore">
        {{ loadingMore ? '載入中...' : hasMore ? '載入更早的記錄' : '已經是全部記錄了' }}
      </button>
    </div>
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
  margin-bottom: 24px;
  flex-wrap: wrap;
}

.page-header h1 {
  font-size: 28px;
  font-weight: 700;
  flex: 1;
}

.back-btn {
  padding: 6px 12px;
}

.refresh-btn {
  background: var(--primary-color);
  color: white;
  border: none;
  padding: 8px 16px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.refresh-btn:hover {
  background: var(--primary-hover);
}

.pricing-toggle {
  background: #fbbf24;
}

.pricing-toggle:hover {
  background: #f59e0b;
}

/* ===== 統計卡片 ===== */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.span-all {
  grid-column: 1 / -1;
}

.stat-card {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px;
  box-shadow: var(--shadow-sm);
}

.stat-card.wide {
  grid-column: span 2;
}

.stat-card-title {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.stat-card-value {
  font-size: 28px;
  font-weight: 700;
  color: var(--primary-color);
  font-family: 'Segoe UI', system-ui;
}

.stat-card-sub {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.stat-bar-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.stat-bar-row {
  display: flex;
  align-items: center;
  font-size: 12px;
  gap: 8px;
}

.stat-bar-label {
  min-width: 80px;
  color: var(--text-primary);
}

.stat-bar-track {
  flex: 1;
  height: 8px;
  background: #f1f5f9;
  border-radius: 4px;
  overflow: hidden;
}

.stat-bar-fill {
  height: 100%;
  background: var(--primary-color);
  border-radius: 4px;
}

.stat-bar-fill.scheduling {
  background: #3b82f6;
}
.stat-bar-fill.edit_qa {
  background: #8b5cf6;
}
.stat-bar-fill.anthropic {
  background: #d97706;
}
.stat-bar-fill.openai_compatible {
  background: #10b981;
}
.stat-bar-fill.gemini {
  background: #06b6d4;
}

.stat-bar-count {
  min-width: 36px;
  text-align: right;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ===== 篩選列 ===== */
.filter-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 20px;
  flex-wrap: wrap;
}

.filter-tabs {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.serve-filter {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.serve-filter select {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  background: white;
  cursor: pointer;
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

.filter-tab.active.tab-scheduling {
  background: #3b82f6;
  border-color: #3b82f6;
}

.filter-tab.active.tab-edit_qa {
  background: #8b5cf6;
  border-color: #8b5cf6;
}

.filter-tab.active.tab-failed {
  background: #ef4444;
  border-color: #ef4444;
}

/* ===== 列表 ===== */
.log-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.log-card {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 20px;
  box-shadow: var(--shadow-sm);
}

.log-card.failed {
  border-left: 4px solid #ef4444;
}

.log-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.log-header-main {
  min-width: 0;
  flex: 1;
}

.log-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.log-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 500;
  margin-right: 6px;
}

.badge-serve {
  background: #ecfdf5;
  color: #047857;
}
.badge-mode-scheduling {
  background: #dbeafe;
  color: #2563eb;
}
.badge-mode-edit_qa {
  background: #f3e8ff;
  color: #7c3aed;
}
.badge-status-ok {
  background: #dcfce7;
  color: #16a34a;
}
.badge-status-fail {
  background: #fee2e2;
  color: #dc2626;
}
.badge-provider {
  background: #f1f5f9;
  color: #475569;
}
.badge-truncated {
  background: #fef3c7;
  color: #b45309;
}
.badge-thinking {
  background: #ede9fe;
  color: #6d28d9;
}
.badge-stop-bad {
  background: #fee2e2;
  color: #b91c1c;
}
.badge-stop-info {
  background: #e0f2fe;
  color: #075985;
}
.badge-cost {
  background: #fffbeb;
  color: #b45309;
}

.log-prompt-preview {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toggle-btn {
  background: transparent;
  border: 1px solid var(--border-color);
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.toggle-btn:hover {
  background: var(--bg-hover);
}

.detail-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--border-color);
}

.detail-block {
  margin-bottom: 16px;
}

.detail-block-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 6px;
}

.detail-block pre {
  background: #0f172a;
  color: #e2e8f0;
  padding: 12px;
  border-radius: 8px;
  overflow-x: auto;
  font-size: 12px;
  line-height: 1.5;
  max-height: 360px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.message-row {
  background: #f8fafc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}

.message-role {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--primary-color);
  margin-bottom: 4px;
}

.message-content {
  font-size: 13px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-primary);
}

.truncate-warning {
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 8px;
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 13px;
  color: #92400e;
}

.no-logs {
  text-align: center;
  color: var(--text-secondary);
  padding: 60px 20px;
}

.load-more-wrap {
  display: flex;
  justify-content: center;
  margin-top: 20px;
}

.load-more-btn {
  padding: 10px 24px;
  border-radius: 10px;
  background: white;
  border: 1px solid var(--border-color);
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== 模型定價面板 ===== */
.pricing-panel {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 24px;
  box-shadow: var(--shadow-sm);
  display: none;
}

.pricing-panel.open {
  display: block;
}

.pricing-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.pricing-header h2 {
  font-size: 16px;
  font-weight: 600;
}

.pricing-hint {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 12px;
}

.pricing-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.pricing-table th,
.pricing-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-color);
  text-align: left;
}

.pricing-table th {
  font-weight: 600;
  color: var(--text-secondary);
  background: #f8fafc;
}

.pricing-table input[type='number'] {
  width: 90px;
  padding: 4px 6px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.pricing-empty {
  text-align: center;
  color: var(--text-secondary);
  padding: 16px;
}

.exchange-rate-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 10px 12px;
  background: #f8fafc;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  font-size: 13px;
}

.exchange-rate-row label {
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.exchange-rate-row input[type='number'] {
  width: 100px;
  padding: 4px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
}

.exchange-rate-row .hint {
  color: var(--text-secondary);
  font-size: 12px;
  margin-left: auto;
}

.pricing-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 12px;
}

/* ===== Schedule Data 區塊 / 表格 / Thinking ===== */
.schedule-block {
  margin-top: 12px;
}

.schedule-empty {
  padding: 12px;
  color: var(--text-secondary);
}

.view-toggle {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
}

.view-toggle button {
  padding: 4px 10px;
  border: 1px solid var(--border-color);
  background: white;
  cursor: pointer;
  font-size: 12px;
  border-radius: 6px;
  color: var(--text-secondary);
}

.view-toggle button.active {
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.schedule-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  max-height: 420px;
}

.schedule-table {
  border-collapse: collapse;
  font-size: 12px;
  min-width: 100%;
}

.schedule-table th,
.schedule-table td {
  border: 1px solid var(--border-color);
  padding: 6px 8px;
  text-align: left;
  vertical-align: top;
  white-space: nowrap;
}

.schedule-table th {
  background: #f1f5f9;
  position: sticky;
  top: 0;
  z-index: 1;
  font-weight: 600;
}

.schedule-table td.date-cell {
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
  background: #fafafa;
}

.thinking-pre {
  background: #1e1b4b !important;
  color: #ddd6fe !important;
}
</style>
