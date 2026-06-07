/**
 * AI 排班助手 store（移植自舊版 agent.js 的功能核心）。
 *
 * 與舊版差異：規則引擎抽到 utils/ruleEngine.ts；資料操作走 editor store；
 * 匿名化實驗（預設關閉）與純裝飾的非線性進度條未移植，改用單純 loading 狀態。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { doc, setDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import { AGENT_API_URL } from '@/firebase/config'
import { useEditorStore } from '@/stores/editor'
import { buildChangedCellSet, computeConsecutiveContextDates, validateScopedChanges } from '@/utils/ruleEngine'
import { formatTimestampId, getFutureSundayCandidates } from '@/utils/dates'
import { cellOf } from '@/utils/schedule'
import type {
  ActiveRules,
  AgentMode,
  AgentRequestPayload,
  AgentResponse,
  ChatMessage,
  PendingAgentChanges,
  ScheduleRow,
} from '@/types'

export interface LeaveRow {
  person: string
  dates: string[]
}

/** 把 [start..end] 範圍依候選日期展開成完整日期陣列 */
function expandDateRange(start: string, end: string, candidates: string[]): string[] {
  if (!start || !end) return []
  const sorted = [...new Set(candidates)].sort()
  const s = sorted.indexOf(start)
  const e = sorted.indexOf(end)
  if (s < 0 || e < 0 || s > e) return []
  return sorted.slice(s, e + 1)
}

export const useAgentStore = defineStore('agent', () => {
  const editor = useEditorStore()

  const mode = ref<AgentMode>('edit_qa')
  const enableThinking = ref(false)
  const isLoading = ref(false)
  const pendingChanges = ref<PendingAgentChanges | null>(null)
  const attachedCsv = ref<{ text: string; name: string } | null>(null)

  // ── 排班模式非線性進度條（移植自舊版 agent.js）──────────
  interface ProgressSegment { end: number; startPct: number; endPct: number }
  const BASE_SEGMENTS: ProgressSegment[] = [
    { end: 60, startPct: 0, endPct: 50 },
    { end: 120, startPct: 50, endPct: 80 },
    { end: 180, startPct: 80, endPct: 100 },
  ]
  const progressActive = ref(false)
  const progressPct = ref(0)
  const progressElapsedSec = ref(0)
  let progressTimer: ReturnType<typeof setInterval> | null = null
  let progressStart = 0
  let progressTotalDuration = 180
  let progressSegments: ProgressSegment[] = [...BASE_SEGMENTS]

  function calcProgressPercent(elapsed: number): number {
    const segs = progressSegments
    if (elapsed <= 0) return 0
    if (elapsed >= segs[segs.length - 1].end) return 99.5
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      const segStart = i === 0 ? 0 : segs[i - 1].end
      if (elapsed <= seg.end) {
        const ratio = (elapsed - segStart) / (seg.end - segStart)
        return seg.startPct + ratio * (seg.endPct - seg.startPct)
      }
    }
    return 99.5
  }

  function startProgress() {
    progressActive.value = true
    progressStart = Date.now()
    progressTotalDuration = 180
    progressSegments = [...BASE_SEGMENTS]
    progressPct.value = 0
    progressElapsedSec.value = 0
    if (progressTimer) clearInterval(progressTimer)
    progressTimer = setInterval(() => {
      const elapsed = (Date.now() - progressStart) / 1000
      progressElapsedSec.value = elapsed
      progressPct.value = calcProgressPercent(elapsed)
    }, 1000)
  }

  function stopProgress() {
    if (progressTimer) {
      clearInterval(progressTimer)
      progressTimer = null
    }
    progressActive.value = false
  }

  /** 重試時延長總時長（從目前已過時間再加 extraSec 秒），對應舊版 extendProgressDuration */
  function extendProgress(extraSec: number) {
    if (!progressTimer) return
    const elapsed = (Date.now() - progressStart) / 1000
    const cur = calcProgressPercent(elapsed)
    progressTotalDuration = elapsed + extraSec
    const remaining = progressTotalDuration - elapsed
    progressSegments = [
      { end: elapsed, startPct: 0, endPct: cur },
      { end: elapsed + remaining / 3, startPct: cur, endPct: cur + (100 - cur) * 0.5 },
      { end: elapsed + (remaining * 2) / 3, startPct: cur + (100 - cur) * 0.5, endPct: cur + (100 - cur) * 0.85 },
      { end: progressTotalDuration, startPct: cur + (100 - cur) * 0.85, endPct: 100 },
    ]
  }

  const histories = reactive<Record<AgentMode, ChatMessage[]>>({ edit_qa: [], scheduling: [] })
  const messages = computed(() => histories[mode.value])

  const rules = reactive<ActiveRules>({
    consecutive: true,
    consecutiveWeeks: 2,
    maxRoles: true,
    maxRolesLimit: 2,
    serviceKnownPeople: true,
    frequencyParity: false,
  })

  const refStart = ref('')
  const refEnd = ref('')
  const genStart = ref('')
  const genEnd = ref('')
  const leaveRows = ref<LeaveRow[]>([{ person: '', dates: [] }])

  const isScheduling = computed(() => mode.value === 'scheduling')
  const hasPending = computed(() => !!pendingChanges.value && Object.keys(pendingChanges.value).length > 0)

  // ── 下拉候選 ──────────────────────────────────────────
  const existingDates = computed(() => editor.scheduleData.map((r) => r.date))
  const pastDates = computed(() => editor.pastData.map((r) => r.date))
  const futureCandidates = computed(() => {
    const latest = [...existingDates.value].sort().pop()
    return latest ? getFutureSundayCandidates(latest) : []
  })
  const refCandidates = computed(() => [...new Set([...pastDates.value, ...existingDates.value])].sort())
  const genCandidates = computed(() => [...existingDates.value, ...futureCandidates.value])
  const generateRangeDates = computed(() => expandDateRange(genStart.value, genEnd.value, genCandidates.value))

  function addMessage(text: string, role: ChatMessage['role'], m: AgentMode = mode.value) {
    histories[m].push({ role, content: text })
  }

  function attachCsv(name: string, text: string) {
    attachedCsv.value = { name, text }
  }
  function removeCsv() {
    attachedCsv.value = null
  }
  function addLeaveRow() {
    leaveRows.value.push({ person: '', dates: [] })
  }
  function removeLeaveRow(i: number) {
    leaveRows.value.splice(i, 1)
    if (leaveRows.value.length === 0) leaveRows.value.push({ person: '', dates: [] })
  }

  // ── 送出 ──────────────────────────────────────────────
  async function send(promptRaw: string): Promise<void> {
    if (isLoading.value) return
    if (!AGENT_API_URL) {
      addMessage('未設定 Agent API URL。', 'error')
      return
    }
    const selectedMode = mode.value
    const scheduling = selectedMode === 'scheduling'
    const prompt = promptRaw.trim() || (scheduling ? '請依參考範圍與規則排班' : '')
    if (!prompt) return

    const csvText = !scheduling && attachedCsv.value ? attachedCsv.value.text : ''
    if (csvText && attachedCsv.value) {
      addMessage(`[附件] ${attachedCsv.value.name}`, 'user', selectedMode)
      attachedCsv.value = null
    }
    addMessage(prompt, 'user', selectedMode)

    const activeRules: Partial<ActiveRules> = scheduling ? { ...rules } : {}

    // 參考 / 生成週次
    let referenceWeeks: string[] = []
    let generateWeeks: string[] = []
    if (scheduling) {
      if (!refStart.value || !refEnd.value) return addMessage('❌ 請選擇「參考週次」的起始與結束', 'error', selectedMode)
      if (!genStart.value || !genEnd.value) return addMessage('❌ 請選擇「生成週次」的起始與結束', 'error', selectedMode)
      referenceWeeks = expandDateRange(refStart.value, refEnd.value, refCandidates.value)
      generateWeeks = expandDateRange(genStart.value, genEnd.value, genCandidates.value)

      // 自動建立尚不存在的生成週次
      try {
        await editor.ensureWeeks(generateWeeks)
      } catch (e) {
        if (!editor.isTabLockError(e)) addMessage('❌ 新增週次失敗：' + msg(e), 'error', selectedMode)
        return
      }
    }

    // 整理請假
    const leaveByDate: Record<string, string[]> = {}
    if (scheduling) {
      const errs: string[] = []
      leaveRows.value.forEach((row, i) => {
        const p = (row.person || '').trim()
        const dates = (row.dates || []).filter(Boolean)
        if (!p && dates.length === 0) return
        if (!p) return errs.push(`第 ${i + 1} 列：人員未填`)
        if (dates.length === 0) return errs.push(`第 ${i + 1} 列：未選任何週次`)
        for (const d of dates) {
          ;(leaveByDate[d] ??= []).push(p)
        }
      })
      if (errs.length) return addMessage('❌ 請假區域格式錯誤：\n' + errs.join('\n'), 'error', selectedMode)
    }

    // 組 effective schedule（含 pending 套用 + pastData 前置）
    let effective: ScheduleRow[] = JSON.parse(JSON.stringify(editor.scheduleData))
    if (pendingChanges.value) {
      for (const [date, services] of Object.entries(pendingChanges.value)) {
        const row = effective.find((r) => r.date === date)
        if (row) for (const [service, change] of Object.entries(services)) row[service] = [...change.new]
      }
    }
    if (editor.pastData.length > 0) effective = [...JSON.parse(JSON.stringify(editor.pastData)), ...effective]

    let consecutiveContextWeeks: string[] = []
    if (scheduling && rules.consecutive) {
      consecutiveContextWeeks = computeConsecutiveContextDates(generateWeeks, rules.consecutiveWeeks, effective)
    }

    const included = new Set([...referenceWeeks, ...consecutiveContextWeeks])
    const toSend = scheduling ? effective.filter((r) => included.has(r.date)) : effective
    const nonUser = new Set(editor.nonUserColumns)
    const userColumns = editor.serviceItems.filter((s) => !nonUser.has(s))
    const clean = toSend.map((row) => {
      const out: ScheduleRow = { date: row.date }
      for (const s of userColumns) out[s] = cellOf(row, s)
      return out
    })

    const chatHistory = messages.value
      .filter((m2) => m2.content !== prompt && m2.role !== 'error')
      .map((m2) => ({ role: m2.role, content: m2.content }))

    const payload: AgentRequestPayload = {
      prompt,
      currentSchedule: JSON.stringify({ scheduleData: clean }),
      selectedMode,
      activeRules,
      chatHistory,
      enableThinking: enableThinking.value,
    }
    if (csvText) payload.attachedCsvText = csvText
    if (scheduling) {
      payload.generateWeeks = generateWeeks
      payload.suppressStructural = true
    }
    if (consecutiveContextWeeks.length) payload.consecutiveContextWeeks = consecutiveContextWeeks
    if (Object.keys(leaveByDate).length) payload.leaveByDate = leaveByDate

    isLoading.value = true
    if (scheduling) startProgress()
    const logStart = formatTimestampId()
    let retry = 0
    const MAX_RETRY = 1

    while (retry <= MAX_RETRY) {
      try {
        const resp = await fetch(AGENT_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const text = await resp.text()
        let result: AgentResponse & { _raw_text?: string }
        try {
          result = JSON.parse(text)
        } catch {
          result = { _raw_text: text }
        }
        const debug = (result as { _debug?: unknown })._debug ?? null
        delete (result as { _debug?: unknown })._debug
        void writeAgentLog(logStart, retry, resp.status, debug, result, selectedMode)

        if (!resp.ok) {
          const err = new Error(`API 錯誤 (${resp.status})`) as Error & { status?: number }
          err.status = resp.status
          throw err
        }

        // 問答型回覆
        if (result.answerOnly || result.mode === 'answer_only' || !Array.isArray(result.scheduleData)) {
          addMessage(result.answer || result.explanation || '已收到回覆。', 'assistant', selectedMode)
          break
        }

        const userServiceItems = editor.serviceItems.filter((s) => !nonUser.has(s))
        const changed = buildChangedCellSet(effective, result.scheduleData, userServiceItems, scheduling ? generateWeeks : null)
        const validation = validateScopedChanges({
          baseScheduleData: effective,
          nextScheduleData: result.scheduleData,
          serviceItems: editor.serviceItems,
          nonUserColumns: editor.nonUserColumns,
          activeRules,
          changedCells: changed,
          referenceWeeks,
          generateWeeks,
          leaveByDate,
          consecutiveContextWeeks,
        })

        const base = result.explanation || '已產生排班建議，請檢視表格中的變更。'
        if (!validation.valid) {
          addMessage(`${base}（但有 ${validation.warnings.length} 項規則警告）`, 'assistant', selectedMode)
          validation.warnings.forEach((w) => addMessage(w.message, 'error', selectedMode))
        } else {
          addMessage(base, 'assistant', selectedMode)
        }

        await editor.applyAgentStructuralChanges({
          addWeeks: result.addWeeks || 0,
          removeWeeks: result.removeWeeks || 0,
          addServiceColumns: result.addServiceColumns || [],
          removeServiceColumns: result.removeServiceColumns || [],
        })

        let next = result.scheduleData
        if (scheduling) {
          const allowed = new Set(generateWeeks)
          next = next.filter((r) => allowed.has(r.date))
        }
        setPendingChanges(next)
        break
      } catch (e) {
        const status = Number((e as { status?: number })?.status || 0)
        const message = String((e as Error)?.message || '')
        const retryable = [502, 503, 504].includes(status) || /Internal server error/i.test(message)
        if (retryable && retry < MAX_RETRY) {
          retry++
          extendProgress(120) // 連線錯誤重試：再延長 2 分鐘
          addMessage('伺服器暫時忙碌，正在自動重試一次...', 'assistant', selectedMode)
          await new Promise((r) => setTimeout(r, 1200 * retry))
          continue
        }
        console.error('Agent API 呼叫失敗:', e)
        addMessage(`❌ 發生錯誤：${msg(e)}`, 'error', selectedMode)
        break
      }
    }
    stopProgress()
    isLoading.value = false
  }

  // ── 待審核變更 ────────────────────────────────────────
  function setPendingChanges(next: ScheduleRow[]) {
    const changes: PendingAgentChanges = {}
    const nonUser = new Set(editor.nonUserColumns)
    for (const row of editor.scheduleData) {
      const newRow = next.find((r) => r.date === row.date)
      if (!newRow) continue
      for (const service of editor.serviceItems) {
        if (nonUser.has(service)) continue
        const oldV = JSON.stringify(cellOf(row, service))
        const newV = JSON.stringify(cellOf(newRow, service))
        if (oldV !== newV) {
          ;(changes[row.date] ??= {})[service] = { old: cellOf(row, service), new: cellOf(newRow, service) }
        }
      }
    }
    if (Object.keys(changes).length > 0) pendingChanges.value = changes
    else addMessage('沒有需要變更的內容。', 'assistant')
  }

  async function acceptCell(date: string, service: string): Promise<void> {
    const change = pendingChanges.value?.[date]?.[service]
    if (!change) return
    const ok = await editor.addPersonsExact(date, service, change.new)
    if (!ok) return
    delete pendingChanges.value![date][service]
    if (Object.keys(pendingChanges.value![date]).length === 0) delete pendingChanges.value![date]
    if (!hasPending.value) {
      pendingChanges.value = null
      addMessage('審核完成。', 'assistant')
    }
  }

  function rejectCell(date: string, service: string) {
    if (!pendingChanges.value?.[date]?.[service]) return
    delete pendingChanges.value[date][service]
    if (Object.keys(pendingChanges.value[date]).length === 0) delete pendingChanges.value[date]
    if (!hasPending.value) {
      pendingChanges.value = null
      addMessage('審核完成。', 'assistant')
    }
  }

  async function acceptAll(): Promise<void> {
    if (!pendingChanges.value) return
    const entries = Object.entries(pendingChanges.value)
    for (const [date, services] of entries) {
      for (const [service, change] of Object.entries(services)) {
        const ok = await editor.addPersonsExact(date, service, change.new, true)
        if (!ok) return // 分頁鎖等
      }
    }
    editor.commitAgentBatch()
    pendingChanges.value = null
    addMessage('✅ 已接受所有變更', 'assistant')
  }

  function rejectAll() {
    pendingChanges.value = null
    addMessage('❌ 已拒絕所有變更', 'assistant')
  }

  function msg(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  return {
    mode, enableThinking, isLoading, pendingChanges, attachedCsv, messages, rules,
    refStart, refEnd, genStart, genEnd, leaveRows,
    isScheduling, hasPending,
    progressActive, progressPct, progressElapsedSec,
    refCandidates, genCandidates, generateRangeDates,
    addMessage, attachCsv, removeCsv, addLeaveRow, removeLeaveRow,
    send, acceptCell, rejectCell, acceptAll, rejectAll,
  }
})

// ── Firestore agent_log（精簡版） ───────────────────────
const AGENT_LOG_MAX_BYTES = 500_000
function truncate(s: string): string {
  const bytes = new TextEncoder().encode(s)
  if (bytes.length <= AGENT_LOG_MAX_BYTES) return s
  return s.slice(0, AGENT_LOG_MAX_BYTES) + `\n[...truncated ${bytes.length} bytes]`
}

async function writeAgentLog(
  startTime: string,
  retry: number,
  statusCode: number,
  debug: unknown,
  responseBody: unknown,
  selectedMode: string,
): Promise<void> {
  try {
    const editor = useEditorStore()
    const dbg = (debug && typeof debug === 'object' ? (debug as Record<string, unknown>) : {}) ?? {}
    const docId = `${startTime}-${retry}`.replace(/[^0-9A-Za-z._-]/g, '_')
    let rb: unknown = responseBody
    try {
      const json = JSON.stringify(responseBody)
      if (new TextEncoder().encode(json).length > AGENT_LOG_MAX_BYTES) {
        rb = { _truncated: true, preview: truncate(json) }
      }
    } catch {
      rb = { _unserializable: true }
    }
    await setDoc(doc(db, 'agent_log', docId), {
      wall_clock_utc: new Date().toISOString(),
      start_time: startTime,
      retry_count: retry,
      'serve-id': editor.collection || '',
      mode: (dbg.mode as string) || selectedMode || '',
      provider: (dbg.provider as string) || '',
      model: (dbg.model as string) || '',
      enable_thinking: !!dbg.enable_thinking,
      status_code: statusCode,
      inference_time: typeof dbg.inference_time === 'number' ? dbg.inference_time : null,
      stop_reason: typeof dbg.stop_reason === 'string' ? dbg.stop_reason : '',
      system_prompt: truncate(String(dbg.system_prompt || '')),
      thinking: truncate(String(dbg.thinking || '')),
      messages: Array.isArray(dbg.messages) ? dbg.messages : [],
      response_body: rb,
    })
  } catch (e) {
    console.warn('[agent-log] write failed:', e)
  }
}
