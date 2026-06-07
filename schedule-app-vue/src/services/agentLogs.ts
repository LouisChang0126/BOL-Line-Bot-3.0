/**
 * AI 助手呼叫記錄（`agent_log`）的分頁讀取。
 *
 * 對應舊版 edit-chart/agent_log_dashboard.html 的 loadPage 邏輯：
 *   - 依 `wall_clock_utc` 倒序（最新在最前），每頁 `pageSize` 筆。
 *   - 用 `wall_clock_utc` 排序而非 `__name__`：Firestore 對 `__name__` desc 需要明確的
 *     composite index，但 `wall_clock_utc` 是一般字串欄位，預設就有自動建立的單欄位索引；
 *     兩者排出來結果相同（doc id 與 wall_clock_utc 都是 ISO 時間字串）。
 *   - 「載入更多」用 startAfter(cursor) 接續分頁；回傳 lastDoc 供下一頁使用。
 */
import {
  collection,
  query,
  orderBy,
  limit,
  startAfter,
  getDocs,
  type QueryConstraint,
  type QueryDocumentSnapshot,
} from 'firebase/firestore'
import { db } from '@/firebase'
import type { AgentLog } from '@/types'

const LOG_COLLECTION = 'agent_log'
export const DEFAULT_PAGE_SIZE = 200

export interface AgentLogsPage {
  logs: AgentLog[]
  /** 本頁最後一份文件快照；傳回給下一次 loadAgentLogsPage 當 cursor。null = 無資料。 */
  lastDoc: QueryDocumentSnapshot | null
  /** 是否可能還有更早的記錄（本頁筆數 === pageSize 時為 true）。 */
  hasMore: boolean
}

/**
 * 讀取一頁 agent_log。
 *
 * @param cursor   上一頁回傳的 lastDoc；省略時讀取第一頁（最新）。
 * @param pageSize 每頁筆數，預設 200。
 */
export async function loadAgentLogsPage(
  cursor?: QueryDocumentSnapshot | null,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Promise<AgentLogsPage> {
  const constraints: QueryConstraint[] = [orderBy('wall_clock_utc', 'desc')]
  if (cursor) constraints.push(startAfter(cursor))
  constraints.push(limit(pageSize))

  const snap = await getDocs(query(collection(db, LOG_COLLECTION), ...constraints))

  const logs: AgentLog[] = snap.docs.map((d) => ({
    ...(d.data() as Omit<AgentLog, 'id'>),
    id: d.id,
  }))

  return {
    logs,
    lastDoc: snap.docs.length > 0 ? snap.docs[snap.docs.length - 1] : null,
    hasMore: snap.size === pageSize,
  }
}
