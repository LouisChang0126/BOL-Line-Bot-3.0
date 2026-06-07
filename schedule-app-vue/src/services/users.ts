/** 使用者 (`users/<name>`) 的讀寫 */
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, writeBatch } from 'firebase/firestore'
import { db } from '@/firebase'
import { loadFutureRows, loadMetadata } from '@/services/schedule'
import { cellOf } from '@/utils/schedule'
import type { UserDoc } from '@/types'

export async function loadUser(name: string): Promise<UserDoc | null> {
  const snap = await getDoc(doc(db, 'users', name))
  return snap.exists() ? (snap.data() as UserDoc) : null
}

/** 載入全部使用者，回傳 name → UserDoc 對應表 */
export async function loadAllUsers(): Promise<Record<string, UserDoc>> {
  const snap = await getDocs(collection(db, 'users'))
  const out: Record<string, UserDoc> = {}
  snap.forEach((d) => {
    out[d.id] = d.data() as UserDoc
  })
  return out
}

export async function saveUser(name: string, data: UserDoc): Promise<void> {
  await setDoc(doc(db, 'users', name), data)
}

export async function deleteUser(name: string): Promise<void> {
  await deleteDoc(doc(db, 'users', name))
}

/** 一次寫入多位使用者（自動加入 / 批次更新服事用） */
export async function saveUsers(users: Record<string, UserDoc>): Promise<void> {
  const entries = Object.entries(users)
  if (entries.length === 0) return
  const batch = writeBatch(db)
  for (const [name, data] of entries) {
    batch.set(doc(db, 'users', name), data)
  }
  await batch.commit()
}

/**
 * 從某崇拜「當前週日（含）以後」的班表中，擷取每個人被排到的服事項目。
 * 略過資訊欄位（nonUserColumns）。回傳 name → 該人被排到的服事陣列（去重）。
 * 與舊版 edit-user.html loadSchedulePersons 一致。
 */
export async function loadSchedulePersonServes(col: string): Promise<Record<string, string[]>> {
  const [metadata, rows] = await Promise.all([loadMetadata(col), loadFutureRows(col)])
  const serviceItems = metadata?.serviceItems ?? []
  const nonUser = new Set(metadata?.nonUserColumns ?? [])
  const userItems = serviceItems.filter((item) => !nonUser.has(item))

  const out: Record<string, Set<string>> = {}
  for (const row of rows) {
    for (const item of userItems) {
      for (const name of cellOf(row, item)) {
        const set = out[name] ?? (out[name] = new Set())
        set.add(item)
      }
    }
  }
  const result: Record<string, string[]> = {}
  for (const [name, set] of Object.entries(out)) {
    result[name] = Array.from(set)
  }
  return result
}

/** 產生 16 字元登入邀請碼（與舊版 edit-user.html 一致的字元集） */
export function generateLoginToken(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  let token = ''
  for (let i = 0; i < length; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return token
}
