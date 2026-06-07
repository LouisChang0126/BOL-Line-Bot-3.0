/**
 * Firebase 初始化 —— 單一入口。
 *
 * 舊版用 `window.db` / `window.firestore` 注入到全域；新版改成直接 import 這裡的
 * `db` / `auth`，並從 'firebase/firestore' 直接 import 需要的函式。型別更完整、無全域汙染。
 */
import { initializeApp } from 'firebase/app'
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check'
import { getFirestore } from 'firebase/firestore'
import { GoogleAuthProvider, getAuth } from 'firebase/auth'
import { firebaseConfig, RECAPTCHA_SITE_KEY, DISABLE_APP_CHECK } from './config'

export const firebaseApp = initializeApp(firebaseConfig)

// 本機開發：若提供 App Check debug token，註冊後即可在 localhost 讀取受 App Check 保護的資料。
// 用法：到 Firebase Console → App Check → 管理 debug token 新增，再把值放進 .env 的
// VITE_APPCHECK_DEBUG_TOKEN（或設為 'true' 讓 SDK 產生一組印在 console 再去註冊）。
const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN
if (debugToken) {
  ;(globalThis as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
    debugToken === 'true' ? true : debugToken
}

// App Check（reCAPTCHA v3）。本機開發可用 VITE_DISABLE_APP_CHECK=true 關閉。
if (!DISABLE_APP_CHECK) {
  try {
    initializeAppCheck(firebaseApp, {
      provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
      isTokenAutoRefreshEnabled: true,
    })
  } catch (err) {
    console.warn('[firebase] App Check 初始化失敗（開發環境可忽略）:', err)
  }
}

export const db = getFirestore(firebaseApp)
export const auth = getAuth(firebaseApp)
export const googleProvider = new GoogleAuthProvider()
