/**
 * 編輯記錄（`_edit_chart_log`）的讀取與還原。
 *
 * 對應舊版 edit-chart/difference.html 的 loadLogs / restoreChart 邏輯：
 *   - loadEditLogs：讀取所有編輯記錄，僅保留指定 serve-id 的，依 doc id（時間字串）倒序。
 *   - restoreLatestLog：將該記錄 difference 中各服事的 old 值寫回班表，再刪除此記錄。
 *
 * 注意：還原僅應對「最新」一筆記錄執行，呼叫端（DifferenceView）負責把關此前置條件。
 */
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import type { CellDiff, EditChartLog } from '@/types'

const LOG_COLLECTION = '_edit_chart_log'

/** 後端文件的原始型別（source 可能缺漏，因此這裡不直接用 EditChartLog） */
interface RawLogData {
  'serve-id'?: string
  source?: EditChartLog['source']
  difference?: EditChartLog['difference']
  'last-edited-time'?: string
}

/** 把 Firestore 原始資料正規化成 EditChartLog（補上預設 source / 欄位） */
function normalizeLog(id: string, data: RawLogData): EditChartLog {
  return {
    id,
    'serve-id': data['serve-id'] ?? '',
    // 與舊版一致：缺漏的 source 一律視為管理員編輯。
    source: data.source ?? 'admin',
    difference: data.difference ?? {},
    'last-edited-time': data['last-edited-time'] ?? id,
  }
}

/**
 * 讀取某崇拜的所有編輯記錄，依 doc id（`YYYY.MM.DD.HH.MM.SS`）字典序倒序（最新在最前）。
 */
export async function loadEditLogs(serveId: string): Promise<EditChartLog[]> {
  const snapshot = await getDocs(collection(db, LOG_COLLECTION))

  const logs: EditChartLog[] = []
  snapshot.forEach((d) => {
    const data = d.data() as RawLogData
    if (data['serve-id'] === serveId) {
      logs.push(normalizeLog(d.id, data))
    }
  })

  // 字典序即時間序：倒序排列，最新的在最上面。
  logs.sort((a, b) => b.id.localeCompare(a.id))
  return logs
}

/** 取出某筆變更前後值，支援舊格式（純陣列 = new 值，old 視為空） */
function readCellDiff(value: CellDiff | boolean): CellDiff {
  if (Array.isArray(value)) {
    // 舊格式：difference[date][service] 直接是新值陣列。
    return { old: [], new: value as unknown as string[] }
  }
  if (value && typeof value === 'object') {
    const cell = value as CellDiff
    return { old: cell.old ?? [], new: cell.new ?? [] }
  }
  return { old: [], new: [] }
}

/**
 * 還原一筆編輯記錄（倒推：將 difference 中各服事的 old 值寫回班表），完成後刪除該記錄。
 *
 * 與舊版 restoreChart 一致：
 *   - 跳過底線前綴 metadata（例如 _deleted），避免被當成服事欄位寫回。
 *   - 逐日 setDoc 合併，僅覆蓋有變更的欄位。
 *
 * 呼叫端須先確認此為最新一筆記錄。
 */
export async function restoreLatestLog(serveId: string, log: EditChartLog): Promise<void> {
  const difference = log.difference ?? {}

  for (const [date, services] of Object.entries(difference)) {
    const updates: Record<string, string[]> = {}

    for (const [service, value] of Object.entries(services)) {
      // 跳過底線前綴的內部 metadata（例如 _deleted）。
      if (service.startsWith('_')) continue
      updates[service] = readCellDiff(value).old
    }

    // 沒有實際欄位要更新時略過（整週只含 metadata 的情況）。
    if (Object.keys(updates).length === 0) continue

    const docRef = doc(db, serveId, date)
    const currentDoc = await getDoc(docRef)
    if (currentDoc.exists()) {
      await setDoc(docRef, { ...currentDoc.data(), ...updates })
    } else {
      await setDoc(docRef, updates)
    }
  }

  // 刪除此編輯記錄。
  await deleteDoc(doc(db, LOG_COLLECTION, log.id))
}
