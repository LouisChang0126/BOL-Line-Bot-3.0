/**
 * 認證狀態 —— Google 登入 + 管理員允許名單。
 *
 * 管理端路由透過 router guard 呼叫 `whenReady()` 等待 Firebase 回報初始登入狀態，
 * 再檢查 `user` 與 `isAdmin`。允許名單存在 Firestore `_config/admins`，
 * 並由 Firestore Security Rules 在伺服器端再把關一次（前後端雙重防護）。
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth'
import { auth, googleProvider } from '@/firebase'
import { isEmailAdmin } from '@/services/admins'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)
  const isAdmin = ref(false)
  const ready = ref(false)

  let resolveReady!: () => void
  const readyPromise = new Promise<void>((resolve) => {
    resolveReady = resolve
  })

  onAuthStateChanged(auth, async (u) => {
    user.value = u
    isAdmin.value = u ? await safeIsAdmin(u.email) : false
    if (!ready.value) {
      ready.value = true
      resolveReady()
    }
  })

  async function safeIsAdmin(email: string | null): Promise<boolean> {
    try {
      return await isEmailAdmin(email)
    } catch (e) {
      console.error('[auth] 檢查管理員名單失敗:', e)
      return false
    }
  }

  /** 跳出 Google 登入視窗 */
  async function signInWithGoogle(): Promise<void> {
    const cred = await signInWithPopup(auth, googleProvider)
    user.value = cred.user
    isAdmin.value = await safeIsAdmin(cred.user.email)
  }

  async function logout(): Promise<void> {
    await signOut(auth)
    user.value = null
    isAdmin.value = false
  }

  /** 等待 Firebase 回報初始登入狀態（router guard 用） */
  function whenReady(): Promise<void> {
    return readyPromise
  }

  return { user, isAdmin, ready, signInWithGoogle, logout, whenReady }
})
