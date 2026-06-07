/**
 * 班表「寫入」操作（管理端編輯器用）。
 * 純 Firestore 副作用；分頁鎖檢查由 editor store 在呼叫前負責（assertEditing）。
 */
import { collection, deleteDoc, doc, getDocs, setDoc, writeBatch } from 'firebase/firestore'
import { db } from '@/firebase'
import type { DisplayConfig, ScheduleRow } from '@/types'

export interface MetadataWrite {
  serviceItems: string[]
  nonUserColumns: string[]
  displayConfig?: DisplayConfig
}

export interface BulkWriteArgs {
  collection: string
  rowUpdates?: { date: string; data: ScheduleRow | Record<string, unknown> }[]
  rowDeletes?: string[]
  metadata?: MetadataWrite | null
}

/** 多文件批次寫入（對應舊版 _bulkWrite） */
export async function bulkWrite({
  collection: col,
  rowUpdates = [],
  rowDeletes = [],
  metadata = null,
}: BulkWriteArgs): Promise<void> {
  const batch = writeBatch(db)

  for (const { date, data } of rowUpdates) {
    const clean: Record<string, unknown> = { ...data }
    delete clean.date
    batch.set(doc(db, col, date), clean)
  }
  for (const date of rowDeletes) {
    batch.delete(doc(db, col, date))
  }
  if (metadata) {
    batch.set(doc(db, col, '_metadata'), { ...metadata })
  }
  await batch.commit()
}

/** 單列寫入（date 欄位會被剔除） */
export async function saveScheduleRow(
  col: string,
  date: string,
  data: Record<string, unknown>,
): Promise<void> {
  const clean = { ...data }
  delete clean.date
  await setDoc(doc(db, col, date), clean)
}

export async function saveMetadata(col: string, metadata: MetadataWrite): Promise<void> {
  const payload: Record<string, unknown> = {
    serviceItems: metadata.serviceItems,
    nonUserColumns: metadata.nonUserColumns,
  }
  if (metadata.displayConfig) payload.displayConfig = metadata.displayConfig
  await setDoc(doc(db, col, '_metadata'), payload)
}

export async function deleteScheduleRow(col: string, date: string): Promise<void> {
  await deleteDoc(doc(db, col, date))
}

/**
 * 重新命名服事項目時，同步更新歷史班表（最多 100 週）。回傳被更新的歷史 date 清單。
 * （對應舊版 saveServiceBtn handler 內的歷史同步段落）
 */
export async function renameServiceInPast(
  col: string,
  oldName: string,
  newName: string,
  minPastDate: string,
  currentSunday: string,
): Promise<void> {
  const snap = await getDocs(collection(db, col))
  const batch = writeBatch(db)
  let count = 0
  snap.forEach((d) => {
    if (d.id === '_metadata') return
    if (d.id < minPastDate || d.id >= currentSunday) return
    const data = d.data() as Record<string, unknown>
    if (!(oldName in data)) return
    const next = { ...data }
    next[newName] = data[oldName]
    delete next[oldName]
    batch.set(d.ref, next)
    count++
  })
  if (count > 0) await batch.commit()
}
