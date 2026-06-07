/** 崇拜清單 (`_config/serve-list`) 的讀寫 */
import { collection, doc, getDoc, getDocs, setDoc, writeBatch } from 'firebase/firestore'
import { db } from '@/firebase'
import type { Serve, ServeListDoc, UserDoc } from '@/types'

function serveListRef() {
  return doc(db, '_config', 'serve-list')
}

export async function loadServeList(): Promise<Serve[]> {
  const snap = await getDoc(serveListRef())
  if (!snap.exists()) return []
  return (snap.data() as ServeListDoc).serves ?? []
}

export async function saveServeList(serves: Serve[]): Promise<void> {
  await setDoc(serveListRef(), { serves } satisfies ServeListDoc)
}

/** 依崇拜「名稱」找出對應的 collection id（公開端用 ?service=名稱） */
export function findServeByName(serves: Serve[], name: string): Serve | undefined {
  return serves.find((s) => s.name === name)
}

/** 依 id 找崇拜 */
export function findServeById(serves: Serve[], id: string): Serve | undefined {
  return serves.find((s) => s.id === id)
}

/** 取得下一個可用的 collection id（`_service_1` ~ `_service_5`） */
export function nextAvailableServeId(serves: Serve[]): string | null {
  const used = new Set(serves.map((s) => s.id))
  for (let i = 1; i <= 5; i++) {
    const id = `_service_${i}`
    if (!used.has(id)) return id
  }
  return null
}

/** 新增崇拜時建立空的 `_metadata` 文件 */
export async function initServeMetadata(id: string): Promise<void> {
  await setDoc(doc(db, id, '_metadata'), { serviceItems: [], nonUserColumns: [] })
}

/**
 * 刪除崇拜（連動清理），與舊版 edit-chart/index.html deleteServe 一致：
 *   1) 刪掉該班表 collection 的所有文件
 *   2) 清掉 users 中該崇拜的 serve_types
 *   3) 清掉 _edit_chart_log 中 serve-id = id 的記錄
 */
export async function deleteServeCascade(id: string): Promise<void> {
  // 1) 主 collection
  const mainDocs = await getDocs(collection(db, id))
  const batch1 = writeBatch(db)
  mainDocs.forEach((d) => batch1.delete(d.ref))
  await batch1.commit()

  // 2) users.serve_types
  const usersSnap = await getDocs(collection(db, 'users'))
  for (const u of usersSnap.docs) {
    const data = u.data() as UserDoc
    if (data.serve_types && data.serve_types[id]) {
      const updated = { ...data.serve_types }
      delete updated[id]
      await setDoc(doc(db, 'users', u.id), { ...data, serve_types: updated })
    }
  }

  // 3) _edit_chart_log
  const logsSnap = await getDocs(collection(db, '_edit_chart_log'))
  const logBatch = writeBatch(db)
  let count = 0
  logsSnap.forEach((l) => {
    if ((l.data() as { 'serve-id'?: string })['serve-id'] === id) {
      logBatch.delete(l.ref)
      count++
    }
  })
  if (count > 0) await logBatch.commit()
}
