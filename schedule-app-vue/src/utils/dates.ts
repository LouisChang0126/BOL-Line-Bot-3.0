/**
 * 日期工具 —— 與舊版 app.js / view.html 完全一致的邏輯。
 * 班表 doc id 格式固定為 `YYYY.MM.DD`（點分隔，可字典序排序）。
 */

/** 班表上限常數（與舊版一致） */
export const MAX_FUTURE_ROWS = 52
export const MAX_PAST_ROWS = 26

/**
 * 取得「當前週日」（UTC+8）。今天是週日 → 回傳今天；否則回傳下一個週日。
 * 用來界定「未來 / 過去」班表的分界點。
 */
export function getCurrentSunday(): Date {
  const now = new Date()
  const utc8Offset = 8 * 60 * 60 * 1000
  const utc8Now = new Date(now.getTime() + utc8Offset + now.getTimezoneOffset() * 60000)

  const dayOfWeek = utc8Now.getDay()
  const sunday = new Date(utc8Now)

  if (dayOfWeek === 0) {
    sunday.setHours(0, 0, 0, 0)
  } else {
    sunday.setDate(utc8Now.getDate() + (7 - dayOfWeek))
    sunday.setHours(0, 0, 0, 0)
  }
  return sunday
}

/** Date → `YYYY.MM.DD`（補零） */
export function formatDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}.${month}.${day}`
}

/** `YYYY.MM.DD` → Date */
export function parseDateString(dateStr: string): Date {
  const [y, m, d] = dateStr.split('.').map(Number)
  return new Date(y, m - 1, d)
}

/** `YYYY.MM.DD` → `YYYY/MM/DD`（顯示用） */
export function formatDisplayDate(dateStr: string): string {
  return dateStr.replaceAll('.', '/')
}

/** 在 dateStr 基礎上加 n 天，回傳新的 `YYYY.MM.DD` */
export function addDays(dateStr: string, days: number): string {
  const d = parseDateString(dateStr)
  d.setDate(d.getDate() + days)
  return formatDateString(d)
}

/**
 * 給定最後一個既有日期，產生其後 count 個週日候選（給「生成週次」下拉用）。
 * 與舊版 agent.js getFutureSundayCandidates 一致。
 */
export function getFutureSundayCandidates(latestExistingDate: string, count = 26): string[] {
  if (!latestExistingDate || !/^\d{4}\.\d{2}\.\d{2}$/.test(latestExistingDate)) return []
  const base = parseDateString(latestExistingDate)
  const out: string[] = []
  for (let i = 1; i <= count; i++) {
    const next = new Date(base)
    next.setDate(base.getDate() + 7 * i)
    out.push(formatDateString(next))
  }
  return out
}

/** 目前時間 → `YYYY.MM.DD.HH.MM.SS`（編輯記錄 doc id 用） */
export function formatTimestampId(date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}.${p(date.getMonth() + 1)}.${p(date.getDate())}.${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`
}

/** `YYYY.MM.DD.HH.MM.SS` → `YYYY/MM/DD HH:MM:SS`（顯示用） */
export function formatTimestampDisplay(id: string): string {
  const parts = id.split('.')
  if (parts.length < 6) return id
  return `${parts[0]}/${parts[1]}/${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
}
