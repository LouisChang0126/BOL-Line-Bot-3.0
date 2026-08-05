/**
 * 「排班外包」：把排班需求組成一段可直接貼進 Gemini / ChatGPT / Claude 網頁版的提示詞，
 * 再把使用者貼回來的回覆解析成班表資料。
 *
 * 為什麼需要這個模式：自架的 Cloud Function 走 API 是要付費的，
 * 已經訂閱 LLM 服務的人可以改用自己的額度，把班表排好再貼回來。
 *
 * 提示詞內容刻意對齊後端 agent_schedule_GCF/main.py 的 build_system_prompt()，
 * 差別在於網頁版 LLM 沒有 tool calling，因此改為要求輸出 JSON 程式碼區塊。
 */
import type { ActiveRules, ScheduleRow } from '@/types'

/** 與後端 FREQUENCY_PARITY_TOLERANCE 一致（0.25 → 25%） */
const FREQUENCY_PARITY_TOLERANCE_PCT = 25

export interface OutsourcePromptInput {
  /** 要給 LLM 參考的班表（已篩選過的參考週次 + 連續週 context） */
  schedule: ScheduleRow[]
  /** 要求 LLM 產生的週次 */
  generateWeeks: string[]
  /** 唯讀的鄰近週次，只用來判斷連續週違規 */
  consecutiveContextWeeks?: string[]
  /** date → 當天不可排的人 */
  leaveByDate?: Record<string, string[]>
  /** 服事欄位（不含資訊欄位） */
  serviceItems: string[]
  rules: ActiveRules
  /** 使用者額外的文字需求 */
  userPrompt?: string
}

/** 組出完整提示詞（角色說明 + 班表資料 + 規則 + 輸出格式 + 使用者需求） */
export function buildOutsourcePrompt(input: OutsourcePromptInput): string {
  const {
    schedule,
    generateWeeks,
    consecutiveContextWeeks = [],
    leaveByDate = {},
    serviceItems,
    rules,
    userPrompt = '',
  } = input

  const sections: string[] = []

  sections.push(
    '你是教會服事班表的排班助理。請依照以下資料與規則，為指定週次安排服事人員。',
  )

  // ── 服事欄位 ──
  sections.push(
    `## 服事欄位\n這份班表有以下服事項目，每一項都要排人：\n${serviceItems.map((s) => `- ${s}`).join('\n')}`,
  )

  // ── 參考班表 ──
  sections.push(
    '## 參考班表（僅供參考，不要修改）\n' +
      '以下是過去與現有的排班紀錄，請從中了解每個人做過哪些服事、出現頻率如何：\n' +
      '```json\n' +
      JSON.stringify({ scheduleData: schedule }, null, 1) +
      '\n```',
  )

  // ── 生成範圍 ──
  if (generateWeeks.length > 0) {
    const range =
      generateWeeks.length === 1
        ? generateWeeks[0]
        : `${generateWeeks[0]} ~ ${generateWeeks[generateWeeks.length - 1]}`
    let scope =
      `## 要排的週次（硬性要求）\n只能為以下日期排班，且必須全部排出：${range}\n` +
      generateWeeks.map((d) => `- ${d}`).join('\n') +
      '\n不可以輸出其他日期的資料。'
    if (consecutiveContextWeeks.length > 0) {
      scope +=
        `\n\n以下日期僅供你判斷「連續週」是否違規，屬於唯讀資料，` +
        `不可以修改、也不可以出現在你的輸出中：${consecutiveContextWeeks.join('、')}`
    }
    sections.push(scope)
  }

  // ── 請假 ──
  const personToDates: Record<string, string[]> = {}
  for (const [date, names] of Object.entries(leaveByDate)) {
    for (const n of names) (personToDates[n] ??= []).push(date)
  }
  const leaveNames = Object.keys(personToDates).sort()
  if (leaveNames.length > 0) {
    sections.push(
      '## 請假（硬性要求）\n以下人員在指定日期不可被排入「任何」服事：\n' +
        leaveNames
          .map((p) => `- ${p}：${[...new Set(personToDates[p])].sort().join('、')}`)
          .join('\n'),
    )
  }

  // ── 規則 ──
  const ruleLines: string[] = []
  if (rules.consecutive) {
    ruleLines.push(
      `- 同一個人不可以連續 ${Math.max(2, rules.consecutiveWeeks || 2)} 週擔任同一項服事。`,
    )
  }
  if (rules.maxRoles) {
    ruleLines.push(`- 每個人每週最多擔任 ${Math.max(1, rules.maxRolesLimit || 3)} 項服事。`)
  }
  if (rules.serviceKnownPeople) {
    ruleLines.push('- 每項服事只能排「在參考班表中做過該服事」的人，不可以自行創造新人選。')
  }
  if (rules.frequencyParity) {
    ruleLines.push(
      `- 盡量讓每個人的服事頻率與參考班表相稱，誤差控制在 ${FREQUENCY_PARITY_TOLERANCE_PCT}% 以內。`,
    )
  }
  sections.push(
    '## 排班規則\n' + (ruleLines.length ? ruleLines.join('\n') : '- 沒有啟用額外的排班規則。'),
  )

  // ── 輸出格式 ──
  sections.push(
    '## 輸出格式（務必遵守）\n' +
      '請「只」輸出一個 JSON 程式碼區塊，不要有其他說明文字在區塊之外。格式如下：\n' +
      '```json\n' +
      JSON.stringify(
        {
          scheduleData: [
            {
              date: generateWeeks[0] || 'YYYY.MM.DD',
              ...Object.fromEntries(serviceItems.slice(0, 3).map((s) => [s, ['人名']])),
            },
          ],
          explanation: '簡短說明你的排班考量',
        },
        null,
        1,
      ) +
      '\n```\n' +
      '注意事項：\n' +
      '- `date` 必須是 `YYYY.MM.DD` 格式，且必須是上面「要排的週次」其中之一。\n' +
      '- 每個服事欄位的值都要是「陣列」，即使只有一個人也要寫成 `["某人"]`。\n' +
      '- 沒有安排人的欄位請給空陣列 `[]`，不要省略該欄位。\n' +
      '- 人名請完全比照參考班表中的寫法，不要加註記或改字。',
  )

  if (userPrompt.trim()) {
    sections.push(`## 額外需求\n${userPrompt.trim()}`)
  }

  return sections.join('\n\n')
}

// ── 解析 LLM 回覆 ────────────────────────────────────────
export type OutsourceParseResult =
  | { ok: true; scheduleData: ScheduleRow[]; explanation: string }
  | { ok: false; error: string }

/**
 * 從 LLM 的回覆文字中抽出班表 JSON。
 * 容錯：允許有 ```json 圍欄、允許 JSON 前後有解說文字。
 *
 * @param allowedDates 若提供，會濾掉不在生成範圍內的日期（LLM 有時會多輸出鄰近週）
 */
export function parseOutsourceReply(
  text: string,
  allowedDates?: string[],
): OutsourceParseResult {
  const raw = (text ?? '').trim()
  if (!raw) return { ok: false, error: '請先貼上 AI 的回覆內容' }

  const candidates = extractJsonCandidates(raw)
  if (candidates.length === 0) {
    return { ok: false, error: '找不到 JSON 內容，請把 AI 回覆的程式碼區塊完整貼上' }
  }

  // 逐個候選解析，並「驗證結構後」才採用 —— 只看第一個解析成功的會出錯：
  // 例如純陣列 `[{...}]`，大括號候選會先切出內層物件並成功解析成單一 row。
  let rowsRaw: unknown = null
  let explanation = ''
  let anyParsed = false
  for (const c of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(c)
    } catch {
      continue
    }
    anyParsed = true
    // 允許直接給陣列，或包在 { scheduleData: [...] } 裡
    const obj = parsed as { scheduleData?: unknown; explanation?: unknown } | null
    const rows = Array.isArray(parsed) ? parsed : obj?.scheduleData
    if (Array.isArray(rows)) {
      rowsRaw = rows
      explanation = typeof obj?.explanation === 'string' ? obj.explanation : ''
      break
    }
  }
  if (!Array.isArray(rowsRaw)) {
    return {
      ok: false,
      error: anyParsed ? '回覆中找不到 scheduleData 陣列' : 'JSON 格式有誤，無法解析',
    }
  }

  const allowed = allowedDates && allowedDates.length ? new Set(allowedDates) : null
  const rows: ScheduleRow[] = []
  for (const item of rowsRaw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const date = typeof rec.date === 'string' ? rec.date.trim().replace(/\//g, '.') : ''
    if (!/^\d{4}\.\d{2}\.\d{2}$/.test(date)) continue
    if (allowed && !allowed.has(date)) continue

    const row: ScheduleRow = { date }
    for (const [key, value] of Object.entries(rec)) {
      if (key === 'date') continue
      row[key] = toNameArray(value)
    }
    rows.push(row)
  }

  if (rows.length === 0) {
    return {
      ok: false,
      error: allowed
        ? '回覆中沒有任何屬於「生成週次」的有效資料列'
        : '回覆中沒有任何有效的資料列（date 需為 YYYY.MM.DD）',
    }
  }

  return { ok: true, scheduleData: rows, explanation }
}

/**
 * 把 LLM 回覆的列與現有班表合併：**只有回覆中明確出現的服事欄位才會被覆蓋**，
 * 沒提到的一律沿用原本內容。
 *
 * 為什麼需要這層保護：網頁版 LLM 沒有 schema 驗證，很常只回傳它有調整的欄位。
 * 若直接拿去比對，缺少的欄位會被當成「清空」，一次審核就把整週其他服事洗掉。
 * 注意空陣列 `[]` 是「明確指定沒有人」，屬於有效變更，不在此保護範圍。
 */
export function mergeWithCurrent(
  replyRows: ScheduleRow[],
  currentRows: ScheduleRow[],
  serviceItems: string[],
): ScheduleRow[] {
  return replyRows.map((row) => {
    const current = currentRows.find((r) => r.date === row.date)
    const out: ScheduleRow = { date: row.date }
    for (const service of serviceItems) {
      if (service in row) {
        const v = row[service]
        out[service] = Array.isArray(v) ? v : []
      } else {
        const cur = current?.[service]
        out[service] = Array.isArray(cur) ? [...cur] : []
      }
    }
    return out
  })
}

/** 把各種可能的值正規化成人名陣列 */
function toNameArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v ?? '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    // 容錯：LLM 有時會寫成 "甲/乙" 或 "甲、乙" 而非陣列
    return value
      .split(/[/、,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return []
}

/** 依序回傳可能是 JSON 的片段：```json 圍欄 → 一般圍欄 → 最外層大括號 / 中括號 */
function extractJsonCandidates(text: string): string[] {
  const out: string[] = []

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)]
  for (const m of fenced) {
    const body = m[1].trim()
    if (body) out.push(body)
  }

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace > -1 && lastBrace > firstBrace) out.push(text.slice(firstBrace, lastBrace + 1))

  const firstBracket = text.indexOf('[')
  const lastBracket = text.lastIndexOf(']')
  if (firstBracket > -1 && lastBracket > firstBracket) {
    out.push(text.slice(firstBracket, lastBracket + 1))
  }

  return out
}

// ── LLM 網頁 ─────────────────────────────────────────────
export interface LlmTarget {
  id: 'gemini' | 'chatgpt' | 'claude'
  name: string
  url: string
}

/**
 * 三家網頁版入口。
 *
 * 注意：這裡只負責「開新分頁」，無法自動把提示詞貼進去並送出 ——
 * 瀏覽器的同源政策禁止跨網域操作其他分頁的 DOM，只有瀏覽器擴充功能做得到。
 * 因此流程一律是「複製到剪貼簿 → 開頁面 → 使用者自行 Ctrl+V 送出」，三家行為一致。
 */
export const LLM_TARGETS: LlmTarget[] = [
  { id: 'gemini', name: 'Gemini', url: 'https://gemini.google.com/app' },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/' },
  { id: 'claude', name: 'Claude', url: 'https://claude.ai/new' },
]
