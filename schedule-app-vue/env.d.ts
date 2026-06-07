/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Firebase Web 設定 — 這些值為公開值（安全性由 Security Rules + App Check 把關），可留空使用內建預設 */
  readonly VITE_FIREBASE_API_KEY?: string
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string
  readonly VITE_FIREBASE_PROJECT_ID?: string
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string
  readonly VITE_FIREBASE_APP_ID?: string
  /** reCAPTCHA v3 site key（App Check 用） */
  readonly VITE_RECAPTCHA_SITE_KEY?: string
  /** AI 排班 Cloud Function URL */
  readonly VITE_AGENT_API_URL?: string
  /** 開發時關閉 App Check（true 時不初始化 reCAPTCHA），預設關閉 */
  readonly VITE_DISABLE_APP_CHECK?: string
  /** 本機 App Check debug token（'true' 產生新 token，或填已註冊的 token 值） */
  readonly VITE_APPCHECK_DEBUG_TOKEN?: string
  /** 僅 dev：略過管理端登入檢查（給本機截圖/比對用，正式 build 無效） */
  readonly VITE_DEV_BYPASS_AUTH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
