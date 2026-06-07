/** 班表資料的純函式工具（無副作用，可單元測試） */
import type { ScheduleRow, DisplayConfig } from '@/types'

/** 安全取出某服事欄位的陣列內容（處理 index signature 的型別窄化） */
export function cellOf(row: ScheduleRow | undefined, service: string): string[] {
  if (!row) return []
  const v = row[service]
  return Array.isArray(v) ? v : []
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

  // 防禦：serviceItems 中未被任何群組涵蓋者，補在最後
  for (const item of serviceItems) if (!ordered.includes(item)) ordered.push(item)

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
