/** 班表資料的純函式工具（無副作用，可單元測試） */
import type { ScheduleRow, DisplayConfig } from '@/types'

/** 安全取出某服事欄位的陣列內容（處理 index signature 的型別窄化） */
export function cellOf(row: ScheduleRow | undefined, service: string): string[] {
  if (!row) return []
  const v = row[service]
  return Array.isArray(v) ? v : []
}

/**
 * 計算「把某人從 A 格拖到 B 格」之後，兩格各自的新內容。
 *
 * 抽成純函式的原因：原本這段算在 store 裡，同列（同日期）時誤把「來源格移除後
 * 剩下的人」當成目標格內容，導致同列拖拉會把同格的其他人一起複製過去。
 * 純函式才能對各種人數排列組合做完整測試。
 *
 * 注意：來源與目標為「同一格」時會被判為 duplicate，呼叫端應先自行排除。
 */
export type MoveOutcome =
  | { ok: true; fromCell: string[]; toCell: string[] }
  | { ok: false; reason: 'not-found' | 'duplicate' }

export function computeMove(fromCell: string[], toCell: string[], person: string): MoveOutcome {
  const i = fromCell.indexOf(person)
  if (i === -1) return { ok: false, reason: 'not-found' }
  if (toCell.includes(person)) return { ok: false, reason: 'duplicate' }
  return {
    ok: true,
    fromCell: fromCell.slice(0, i).concat(fromCell.slice(i + 1)),
    // 一律以「目標格原有內容」為基底，與同列/跨列無關
    toCell: [...toCell, person],
  }
}

/** 該週是否有任何非空白服事內容 */
export function isWeekNonEmpty(row: ScheduleRow): boolean {
  return Object.entries(row).some(([k, v]) => {
    if (k === 'date') return false
    if (Array.isArray(v)) return v.length > 0
    if (typeof v === 'string') return v.trim().length > 0
    return false
  })
}

/** 從多列班表收集所有出現過的人名（略過資訊欄位） */
export function collectPersonNames(
  rows: ScheduleRow[],
  serviceItems: string[],
  nonUserColumns: string[],
): Set<string> {
  const nonUser = new Set(nonUserColumns)
  const names = new Set<string>()
  for (const row of rows) {
    for (const item of serviceItems) {
      if (nonUser.has(item)) continue
      for (const name of cellOf(row, item)) names.add(name)
    }
  }
  return names
}

/**
 * 依 displayConfig 計算「目前可見的服事項目」順序。
 * 與舊版 view.html getVisibleServiceItems 一致：可見群組依序 → 未分組最後 → 濾掉 hidden。
 * 無 displayConfig 時回傳全部 serviceItems。
 */
export function getVisibleServiceItems(
  serviceItems: string[],
  displayConfig: DisplayConfig | null | undefined,
  isGroupVisible: (groupId: string) => boolean,
): string[] {
  if (!displayConfig || !Array.isArray(displayConfig.groups)) return [...serviceItems]

  const hidden = new Set(displayConfig.hidden || [])
  const inSchedule = new Set(serviceItems)
  const ordered: string[] = []

  for (const group of displayConfig.groups) {
    if (group.id === 'ungrouped') continue
    if (!isGroupVisible(group.id)) continue
    for (const item of group.items) ordered.push(item)
  }
  const ungrouped = displayConfig.groups.find((g) => g.id === 'ungrouped')
  if (ungrouped) for (const item of ungrouped.items) ordered.push(item)

  // 防禦：serviceItems 中「不屬於任何群組」的孤兒項目，補在最後。
  // 注意必須比對「有沒有被任一群組收錄」，不能比對 ordered——否則被取消勾選的
  // 群組項目會在這裡又被補回來，導致群組過濾器完全失效（只會變成換順序）。
  const grouped = new Set<string>()
  for (const g of displayConfig.groups) for (const item of g.items) grouped.add(item)
  for (const item of serviceItems) {
    if (!grouped.has(item) && !ordered.includes(item)) ordered.push(item)
  }

  const seen = new Set<string>()
  return ordered.filter((s) => {
    if (!inSchedule.has(s) || hidden.has(s) || seen.has(s)) return false
    seen.add(s)
    return true
  })
}

/** displayConfig 中預設可見的群組 id（不含一律顯示的 ungrouped） */
export function defaultVisibleGroupIds(displayConfig: DisplayConfig | null | undefined): Set<string> {
  const ids = new Set<string>()
  if (!displayConfig) return ids
  for (const g of displayConfig.groups) {
    if (g.id === 'ungrouped') continue
    if (g.defaultVisible !== false) ids.add(g.id)
  }
  return ids
}
