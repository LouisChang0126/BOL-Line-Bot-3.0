/**
 * 「依班表補齊使用者」的計算邏輯（純函式，無副作用、可測試）。
 *
 * 自動化程度刻意分成兩級：
 *   - 既有同工被排到新服事 → 系統「自動」補上（低風險，只是補資料）
 *   - 出現沒建檔的新名字   → 只亮紅點提醒，等管理員自己按「自動加入使用者」
 *     （避免打錯字就立刻在 users 建出一筆錯誤資料）
 */
import { createEmptyUser } from '@/types'
import type { UserDoc } from '@/types'

export interface UserSyncPlan {
  /** 要寫回 Firestore 的使用者（新建 + 更新） */
  updates: Record<string, UserDoc>
  /** 這次新建檔的名字（決定要不要亮紅點） */
  created: string[]
  /** 這次補了服事的既有使用者 */
  updated: string[]
}

/**
 * 比對「班表上每個人被排到的服事」與「現有使用者資料」，算出需要寫入的異動。
 *
 * 規則：
 *   - 名字不存在 → 建新檔，serve_types[col] = 排到的服事，並產生登入邀請碼
 *   - 名字存在但缺服事 → 只「補上」缺的，不動既有的（服事只增不減）
 *   - 已經齊全 → 不列入 updates，避免無謂寫入
 *   - 其他崇拜的 serve_types 與使用者其餘欄位一律原樣保留
 *
 * @param makeToken 產生登入邀請碼的函式（可注入以便測試）
 */
export function planUserSync(
  personServes: Record<string, Iterable<string>>,
  users: Record<string, UserDoc>,
  col: string,
  makeToken: () => string,
): UserSyncPlan {
  const updates: Record<string, UserDoc> = {}
  const created: string[] = []
  const updated: string[] = []

  for (const [name, servesIter] of Object.entries(personServes)) {
    const serves = [...servesIter]
    const existing = users[name]

    if (!existing) {
      const data = createEmptyUser()
      data.login_token = makeToken()
      data.serve_types[col] = [...serves]
      updates[name] = data
      created.push(name)
      continue
    }

    const current = existing.serve_types?.[col] ?? []
    const missing = serves.filter((s) => !current.includes(s))
    if (missing.length === 0) continue

    updates[name] = {
      ...existing,
      serve_types: { ...(existing.serve_types ?? {}), [col]: [...current, ...missing] },
    }
    updated.push(name)
  }

  return { updates, created, updated }
}

/**
 * 從計畫中取出「可以自動寫入」的部分 —— 只有既有同工的服事更新。
 * 新名字（created）一律排除，必須由管理員在使用者管理頁確認後才建檔。
 */
export function autoApplicableUpdates(plan: UserSyncPlan): Record<string, UserDoc> {
  const out: Record<string, UserDoc> = {}
  for (const name of plan.updated) out[name] = plan.updates[name]
  return out
}
