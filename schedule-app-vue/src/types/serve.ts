/** 一場崇拜（= 一個 Firestore schedule collection，id 形如 `_service_1`） */
export interface Serve {
  id: string
  name: string
  emoji: string
}

/** `_config/serve-list` 文件 */
export interface ServeListDoc {
  serves: Serve[]
}

/** `_config/admins` 文件 —— 允許進入管理端的 Google 帳號 email 名單 */
export interface AdminsDoc {
  emails: string[]
}

export const AVAILABLE_EMOJIS = ['⛪', '🎸', '🧒', '👥', '🎵', '📖', '🙏', '✝️', '🕊️', '💒'] as const
export const MAX_SERVES = 5
