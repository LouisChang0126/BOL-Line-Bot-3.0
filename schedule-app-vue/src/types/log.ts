/** 編輯記錄 —— `_edit_chart_log/<時間字串>` 文件 */

/** 單格變更前後值 */
export interface CellDiff {
  old: string[]
  new: string[]
}

/** 編輯來源 */
export type EditSource = 'admin' | 'ai' | 'ai-assistant' | 'admin+ai' | 'linebot'

/** 某日期下各服事的變更；`_deleted` 為整週刪除標記 */
export interface DateDiff {
  [service: string]: CellDiff | boolean
}

/** date → DateDiff */
export type EditDifference = Record<string, DateDiff>

export interface EditChartLog {
  /** doc id，格式 `YYYY.MM.DD.HH.MM.SS`（字典序即時間序） */
  id: string
  'serve-id': string
  source: EditSource
  difference: EditDifference
  'last-edited-time': string
}
