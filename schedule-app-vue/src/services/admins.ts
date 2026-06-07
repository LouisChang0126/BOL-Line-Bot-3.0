/** 管理員允許名單 (`_config/admins`) */
import { doc, getDoc } from 'firebase/firestore'
import { db } from '@/firebase'
import type { AdminsDoc } from '@/types'

export async function loadAdminEmails(): Promise<string[]> {
  const snap = await getDoc(doc(db, '_config', 'admins'))
  if (!snap.exists()) return []
  const emails = (snap.data() as AdminsDoc).emails ?? []
  return emails.map((e) => e.trim().toLowerCase()).filter(Boolean)
}

export async function isEmailAdmin(email: string | null | undefined): Promise<boolean> {
  if (!email) return false
  const emails = await loadAdminEmails()
  return emails.includes(email.toLowerCase())
}
