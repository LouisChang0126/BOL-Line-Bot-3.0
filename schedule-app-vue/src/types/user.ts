/**
 * 使用者模型 —— `users/<使用者名稱>` 文件。
 * 名稱（中文姓名）即 doc id。
 */
export interface UserDoc {
  /** 週一至週六的服事提醒開關，長度 6 */
  alarm_type: boolean[]
  /** 綁定的 LINE user id（未綁定為空字串） */
  lineId: string
  /** 16 字元登入邀請碼 */
  login_token: string
  /** 使用的 LINE Bot：0=未連線，1-4=Bot 編號 */
  line_bot_id: number
  /** 各場崇拜的服事項目，key 為 collection id（如 `_service_1`） */
  serve_types: Record<string, string[]>
  /** 使用統計：月份（"YYYY.MM" 或 "YYYY_MM"）→ 功能名稱 → 次數 */
  usage_count?: Record<string, Record<string, number>>
}

/** 建立新使用者時的預設值 */
export function createEmptyUser(): UserDoc {
  return {
    alarm_type: [false, false, false, false, false, false],
    lineId: '',
    login_token: '',
    line_bot_id: 0,
    serve_types: {},
    usage_count: {},
  }
}
