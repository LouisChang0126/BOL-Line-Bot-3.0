/**
 * Firebase Web 設定。
 *
 * 這些值是「公開」設定（不是密鑰）—— Firebase 官方明確說明 web config 可公開，
 * 安全性由 Firestore Security Rules + App Check 把關。為了「開箱即跑」的開發體驗，
 * 這裡保留 bol-line-bot-3 專案的預設值；若 .env 有提供 VITE_FIREBASE_* 則優先使用。
 *
 * 換 Firebase 專案時，複製 .env.example 成 .env 並填入新值即可，不需要改 code。
 */
import type { FirebaseOptions } from 'firebase/app'

const env = import.meta.env

// 內建預設（= 舊版 schedule-app/firebase-config.js 的公開值）
const DEFAULTS = {
  apiKey: 'AIzaSyAkR6ZbLuTbmVsItNP42sH1-RKQs0k8Njo',
  authDomain: 'bol-line-bot-3.firebaseapp.com',
  projectId: 'bol-line-bot-3',
  storageBucket: 'bol-line-bot-3.firebasestorage.app',
  messagingSenderId: '651905438882',
  appId: '1:651905438882:web:bc3b2087925ce50c4db3fb',
  recaptchaSiteKey: '6LcrTEgsAAAAALHsL8i7xFOrUM4t4q5j1gVftmAx',
  agentApiUrl: 'https://bol-scheduler-agnet-129834734368.asia-east1.run.app',
} as const

export const firebaseConfig: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY || DEFAULTS.apiKey,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || DEFAULTS.authDomain,
  projectId: env.VITE_FIREBASE_PROJECT_ID || DEFAULTS.projectId,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET || DEFAULTS.storageBucket,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || DEFAULTS.messagingSenderId,
  appId: env.VITE_FIREBASE_APP_ID || DEFAULTS.appId,
}

export const RECAPTCHA_SITE_KEY = env.VITE_RECAPTCHA_SITE_KEY || DEFAULTS.recaptchaSiteKey

export const AGENT_API_URL = env.VITE_AGENT_API_URL || DEFAULTS.agentApiUrl

/** 本機開發時可關閉 App Check（避免 reCAPTCHA 網域限制擋住 localhost） */
export const DISABLE_APP_CHECK = String(env.VITE_DISABLE_APP_CHECK).toLowerCase() === 'true'
