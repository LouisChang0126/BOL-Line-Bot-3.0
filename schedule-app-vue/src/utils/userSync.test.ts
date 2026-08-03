/**
 * 「依班表補齊使用者」的測試。
 *
 * 自動化界線：既有同工補服事 → 自動寫入；新名字 → 只提醒，不自動建檔。
 * 這裡確認自動的那半不會弄壞既有使用者資料，手動的那半不會被偷偷執行。
 */
import { describe, expect, it } from 'vitest'
import { autoApplicableUpdates, planUserSync } from './userSync'
import { createEmptyUser } from '@/types'
import type { UserDoc } from '@/types'

const COL = '_service_1'
const token = () => 'TOKEN1234567890'

function user(overrides: Partial<UserDoc> = {}): UserDoc {
  return { ...createEmptyUser(), ...overrides }
}

describe('planUserSync — 新同工自動建檔', () => {
  it('沒建檔的名字 → 建新檔，帶入排到的服事與登入邀請碼', () => {
    const plan = planUserSync({ 嘉瑩: ['音控'] }, {}, COL, token)
    expect(plan.created).toEqual(['嘉瑩'])
    expect(plan.updated).toEqual([])
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控'])
    expect(plan.updates.嘉瑩.login_token).toBe('TOKEN1234567890')
    expect(plan.updates.嘉瑩.lineId).toBe('')
    expect(plan.updates.嘉瑩.line_bot_id).toBe(0)
    expect(plan.updates.嘉瑩.alarm_type).toEqual([false, false, false, false, false, false])
  })

  it('一個人身兼多項服事 → 一次全部帶入', () => {
    const plan = planUserSync({ 俱佳: ['主領', '鼓手', '司會'] }, {}, COL, token)
    expect(plan.updates.俱佳.serve_types[COL]).toEqual(['主領', '鼓手', '司會'])
  })

  it('多位新同工 → 全部列入 created', () => {
    const plan = planUserSync({ 甲: ['主領'], 乙: ['司琴'], 丙: ['鼓手'] }, {}, COL, token)
    expect(plan.created.sort()).toEqual(['丙', '乙', '甲'])
    expect(Object.keys(plan.updates)).toHaveLength(3)
  })

  it('每個新同工都拿到各自的邀請碼（不是共用同一組）', () => {
    let n = 0
    const plan = planUserSync({ 甲: ['主領'], 乙: ['司琴'] }, {}, COL, () => `TOKEN_${n++}`)
    expect(plan.updates.甲.login_token).not.toBe(plan.updates.乙.login_token)
  })
})

describe('planUserSync — 既有同工補服事', () => {
  it('被排到新服事 → 補上，且保留原有服事', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync({ 嘉瑩: ['音控', '貝斯'] }, users, COL, token)
    expect(plan.created).toEqual([])
    expect(plan.updated).toEqual(['嘉瑩'])
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控', '貝斯'])
  })

  it('服事已經齊全 → 完全不寫入（避免無謂的 Firestore 寫入）', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控', '貝斯'] } }) }
    const plan = planUserSync({ 嘉瑩: ['音控'] }, users, COL, token)
    expect(plan.updates).toEqual({})
    expect(plan.created).toEqual([])
    expect(plan.updated).toEqual([])
  })

  it('服事只增不減：這次沒排到的既有服事不會被移除', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控', '字幕'] } }) }
    const plan = planUserSync({ 嘉瑩: ['貝斯'] }, users, COL, token)
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控', '字幕', '貝斯'])
  })

  it('不會產生重複的服事項目', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync({ 嘉瑩: ['音控', '音控', '貝斯'] }, users, COL, token)
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控', '貝斯'])
  })

  it('既有使用者從未有這個崇拜的 serve_types → 直接建立該欄位', () => {
    const users = { 嘉瑩: user({ serve_types: {} }) }
    const plan = planUserSync({ 嘉瑩: ['音控'] }, users, COL, token)
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控'])
  })
})

describe('planUserSync — 不可破壞既有資料', () => {
  it('保留 lineId / alarm_type / usage_count / login_token', () => {
    const users = {
      嘉瑩: user({
        lineId: 'U123',
        line_bot_id: 2,
        login_token: 'ORIGINAL_TOKEN',
        alarm_type: [true, false, true, false, false, false],
        usage_count: { '2026.08': { 查看班表: 5 } },
        serve_types: { [COL]: ['音控'] },
      }),
    }
    const plan = planUserSync({ 嘉瑩: ['貝斯'] }, users, COL, token)
    const after = plan.updates.嘉瑩
    expect(after.lineId).toBe('U123')
    expect(after.line_bot_id).toBe(2)
    expect(after.login_token).toBe('ORIGINAL_TOKEN') // 不可以被重新產生
    expect(after.alarm_type).toEqual([true, false, true, false, false, false])
    expect(after.usage_count).toEqual({ '2026.08': { 查看班表: 5 } })
  })

  it('不影響其他崇拜的 serve_types', () => {
    const users = {
      嘉瑩: user({ serve_types: { [COL]: ['音控'], _service_2: ['主領', '司琴'] } }),
    }
    const plan = planUserSync({ 嘉瑩: ['貝斯'] }, users, COL, token)
    expect(plan.updates.嘉瑩.serve_types._service_2).toEqual(['主領', '司琴'])
  })

  it('不會就地修改傳入的使用者物件', () => {
    const original = user({ serve_types: { [COL]: ['音控'] } })
    const users = { 嘉瑩: original }
    planUserSync({ 嘉瑩: ['貝斯'] }, users, COL, token)
    expect(original.serve_types[COL]).toEqual(['音控'])
  })

  it('沒被排班的既有使用者完全不動', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }), 佳柔: user() }
    const plan = planUserSync({ 嘉瑩: ['音控'] }, users, COL, token)
    expect(plan.updates).toEqual({})
  })
})

describe('autoApplicableUpdates — 自動 / 手動的界線', () => {
  it('新名字不可以被自動寫入（必須等管理員按「自動加入使用者」）', () => {
    const plan = planUserSync({ 新人: ['鼓手'] }, {}, COL, token)
    expect(plan.created).toEqual(['新人'])
    expect(autoApplicableUpdates(plan)).toEqual({}) // 自動寫入的部分是空的
  })

  it('既有同工的服事更新可以自動寫入', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync({ 嘉瑩: ['音控', '貝斯'] }, users, COL, token)
    const auto = autoApplicableUpdates(plan)
    expect(Object.keys(auto)).toEqual(['嘉瑩'])
    expect(auto.嘉瑩.serve_types[COL]).toEqual(['音控', '貝斯'])
  })

  it('新名字與服事更新混在一起時，只有服事更新會被自動寫入', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync({ 嘉瑩: ['貝斯'], 新人甲: ['鼓手'], 新人乙: ['司琴'] }, users, COL, token)
    const auto = autoApplicableUpdates(plan)
    expect(Object.keys(auto)).toEqual(['嘉瑩'])
    expect(auto.新人甲).toBeUndefined()
    expect(auto.新人乙).toBeUndefined()
    // 但新名字仍要被回報，才能亮紅點
    expect(plan.created.sort()).toEqual(['新人乙', '新人甲'])
  })

  it('全部都已齊全 → 沒有任何自動寫入、也不亮紅點', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync({ 嘉瑩: ['音控'] }, users, COL, token)
    expect(autoApplicableUpdates(plan)).toEqual({})
    expect(plan.created).toEqual([])
  })

  it('新名字建檔後（已在 users 中）→ 紅點條件消失', () => {
    const before = planUserSync({ 新人: ['鼓手'] }, {}, COL, token)
    expect(before.created).toEqual(['新人'])
    // 模擬管理員按下「自動加入使用者」後，users 已有這個人
    const after = planUserSync({ 新人: ['鼓手'] }, { 新人: before.updates.新人 }, COL, token)
    expect(after.created).toEqual([])
    expect(autoApplicableUpdates(after)).toEqual({})
  })
})

describe('planUserSync — 邊界情況', () => {
  it('班表沒有任何人 → 空計畫', () => {
    const plan = planUserSync({}, {}, COL, token)
    expect(plan).toEqual({ updates: {}, created: [], updated: [] })
  })

  it('接受 Set 作為服事來源（store 內部就是用 Set）', () => {
    const plan = planUserSync({ 嘉瑩: new Set(['音控', '貝斯']) }, {}, COL, token)
    expect(plan.updates.嘉瑩.serve_types[COL]).toEqual(['音控', '貝斯'])
  })

  it('新建與更新混在一起時，created / updated 各自分類正確', () => {
    const users = { 嘉瑩: user({ serve_types: { [COL]: ['音控'] } }) }
    const plan = planUserSync(
      { 嘉瑩: ['貝斯'], 新人: ['鼓手'], 沒變的: [] },
      { ...users, 沒變的: user() },
      COL,
      token,
    )
    expect(plan.created).toEqual(['新人'])
    expect(plan.updated).toEqual(['嘉瑩'])
    expect(Object.keys(plan.updates).sort()).toEqual(['嘉瑩', '新人'])
  })
})
