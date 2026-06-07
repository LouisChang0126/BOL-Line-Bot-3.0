/** 班表資料 (`<collection>/<date>` 與 `<collection>/_metadata`) 的讀取 */
import {
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  where,
} from 'firebase/firestore'
import { db } from '@/firebase'
import {
  MAX_FUTURE_ROWS,
  MAX_PAST_ROWS,
  formatDateString,
  getCurrentSunday,
} from '@/utils/dates'
import type { ScheduleMetadata, ScheduleRow } from '@/types'

export async function loadMetadata(col: string): Promise<ScheduleMetadata | null> {
  const snap = await getDoc(doc(db, col, '_metadata'))
  if (!snap.exists()) return null
  const data = snap.data() as Partial<ScheduleMetadata>
  return {
    serviceItems: data.serviceItems ?? [],
    nonUserColumns: data.nonUserColumns ?? [],
    displayConfig: data.displayConfig,
  }
}

/** 當前週日（含）以後的班表，最多 MAX_FUTURE_ROWS 筆，依日期排序 */
export async function loadFutureRows(col: string): Promise<ScheduleRow[]> {
  const currentSunday = formatDateString(getCurrentSunday())
  const q = query(
    collection(db, col),
    where(documentId(), '>=', currentSunday),
    orderBy(documentId()),
    limit(MAX_FUTURE_ROWS),
  )
  return rowsFromSnapshot(await getDocs(q))
}

/** 當前週日之前的歷史班表（最多 weeks 週），依日期排序 */
export async function loadPastRows(col: string, weeks = MAX_PAST_ROWS): Promise<ScheduleRow[]> {
  const currentSundayDate = getCurrentSunday()
  const currentSunday = formatDateString(currentSundayDate)
  const minDate = new Date(currentSundayDate)
  minDate.setDate(minDate.getDate() - weeks * 7)
  const q = query(
    collection(db, col),
    where(documentId(), '>=', formatDateString(minDate)),
    where(documentId(), '<', currentSunday),
    orderBy(documentId()),
  )
  return rowsFromSnapshot(await getDocs(q))
}

function rowsFromSnapshot(
  snap: Awaited<ReturnType<typeof getDocs>>,
): ScheduleRow[] {
  const rows: ScheduleRow[] = []
  snap.forEach((d) => {
    if (d.id === '_metadata') return
    rows.push({ date: d.id, ...(d.data() as Record<string, string[]>) })
  })
  return rows
}
