/**
 * 班表資料模型。
 *
 * 一筆班表 = 一個 Firestore document，doc id 為日期字串 `YYYY.MM.DD`。
 * 文件內的 key 是服事項目名稱（serviceItems），value 是字串陣列：
 *   - 一般服事欄位：人名陣列，如 ["劉婕", "家睿"]
 *   - 資訊欄位（nonUserColumns）：自由文字陣列，如 ["週六 14:00"]
 */

/** 單一儲存格內容（人名或資訊文字的陣列） */
export type ScheduleCell = string[]

/**
 * 一列班表。`date` 為日期字串；其餘動態 key 為服事項目 → ScheduleCell。
 * 由於 index signature 同時涵蓋 date，取服事內容時請用 utils/schedule.ts 的 `cellOf()`。
 */
export interface ScheduleRow {
  date: string
  [service: string]: ScheduleCell | string
}

/** displayConfig 的一個群組 */
export interface DisplayGroup {
  id: string
  name: string
  items: string[]
  defaultVisible?: boolean
}

/** 服事項目的分組顯示設定 */
export interface DisplayConfig {
  groups: DisplayGroup[]
  hidden: string[]
}

/** `<collection>/_metadata` 文件 */
export interface ScheduleMetadata {
  serviceItems: string[]
  /** 資訊欄位（不含人名、不納入使用者檢查），如「彩排」「備註」 */
  nonUserColumns: string[]
  displayConfig?: DisplayConfig
}
