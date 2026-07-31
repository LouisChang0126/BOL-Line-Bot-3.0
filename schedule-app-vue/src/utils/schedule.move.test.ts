/**
 * 人名積木拖拉移動的測試。
 *
 * 背景：曾有 bug —— 同一列（同日期）內拖拉時，目標格會被算成「來源格移除後剩下的人」，
 * 導致同格的其他人被一起複製過去（例：音控[嘉瑩,佳柔] 拖走嘉瑩 → 貝斯變成[佳柔,嘉瑩]）。
 * 這裡對各種人數排列組合做窮舉，並同時涵蓋「同列」與「跨列」兩條寫入路徑。
 */
import { describe, expect, it } from 'vitest'
import { computeMove } from './schedule'
import type { ScheduleRow } from '@/types'

const SRC_POOL = ['甲', '乙', '丙']
const DST_POOL = ['子', '丑', '寅']

/** 模擬 store 在「同一列」的寫入：兩個欄位一起更新同一個 row */
function moveSameRow(row: ScheduleRow, fromSvc: string, toSvc: string, person: string): ScheduleRow {
  const outcome = computeMove(
    (row[fromSvc] as string[]) ?? [],
    (row[toSvc] as string[]) ?? [],
    person,
  )
  if (!outcome.ok) return { ...row }
  return { ...row, [fromSvc]: outcome.fromCell, [toSvc]: outcome.toCell }
}

/** 模擬 store 在「跨列」的寫入：兩個 row 各自更新 */
function moveCrossRow(
  fromRow: ScheduleRow,
  toRow: ScheduleRow,
  fromSvc: string,
  toSvc: string,
  person: string,
): [ScheduleRow, ScheduleRow] {
  const outcome = computeMove(
    (fromRow[fromSvc] as string[]) ?? [],
    (toRow[toSvc] as string[]) ?? [],
    person,
  )
  if (!outcome.ok) return [{ ...fromRow }, { ...toRow }]
  return [
    { ...fromRow, [fromSvc]: outcome.fromCell },
    { ...toRow, [toSvc]: outcome.toCell },
  ]
}

describe('computeMove — 所有人數排列組合', () => {
  // 來源 1~3 人 × 拖走其中第 idx 個 × 目標 0~3 人 = 24 種組合
  for (let srcN = 1; srcN <= 3; srcN++) {
    for (let idx = 0; idx < srcN; idx++) {
      for (let dstN = 0; dstN <= 3; dstN++) {
        const from = SRC_POOL.slice(0, srcN)
        const to = DST_POOL.slice(0, dstN)
        const person = from[idx]
        const label = `來源${srcN}人[${from}] 拖第${idx + 1}個(${person}) → 目標${dstN}人[${to}]`

        it(label, () => {
          const r = computeMove(from, to, person)
          expect(r.ok).toBe(true)
          if (!r.ok) return

          const expectedFrom = from.filter((_, i) => i !== idx)
          expect(r.fromCell).toEqual(expectedFrom)
          expect(r.toCell).toEqual([...to, person])

          // 總人數守恆 —— 沒有人被複製、也沒有人消失
          expect(r.fromCell.length + r.toCell.length).toBe(from.length + to.length)
          // 被拖的人只出現在目標格
          expect(r.fromCell).not.toContain(person)
          expect(r.toCell.filter((n) => n === person)).toHaveLength(1)
          // 來源格剩下的人不可以跑到目標格（就是原本那個 bug）
          for (const n of expectedFrom) expect(r.toCell).not.toContain(n)
          // 目標格原有的人全部留著、順序不變
          expect(r.toCell.slice(0, to.length)).toEqual(to)
          // 不可變更：不能改到傳入的陣列
          expect(from).toEqual(SRC_POOL.slice(0, srcN))
          expect(to).toEqual(DST_POOL.slice(0, dstN))
        })
      }
    }
  }
})

describe('computeMove — 邊界情況', () => {
  it('來源格沒有這個人 → not-found', () => {
    const r = computeMove(['甲'], ['子'], '丙')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  it('來源格是空的 → not-found', () => {
    const r = computeMove([], ['子'], '甲')
    expect(r).toEqual({ ok: false, reason: 'not-found' })
  })

  it('目標格已有同一人 → duplicate', () => {
    const r = computeMove(['甲', '乙'], ['甲'], '甲')
    expect(r).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('拖到同一格（來源=目標）→ duplicate，呼叫端會先擋掉', () => {
    const cell = ['甲', '乙']
    expect(computeMove(cell, cell, '甲')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('同名的人只移走被點到的那一個位置（重複名的防禦）', () => {
    const r = computeMove(['甲', '甲'], [], '甲')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.fromCell).toEqual(['甲'])
    expect(r.toCell).toEqual(['甲'])
  })
})

describe('同一列（同日期）拖拉 — 回歸原始 bug', () => {
  it('2 人格拖 1 個到空格：另一人不可以被複製過去', () => {
    const row: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'], 貝斯: [] }
    const after = moveSameRow(row, '音控', '貝斯', '嘉瑩')
    expect(after.音控).toEqual(['佳柔'])
    expect(after.貝斯).toEqual(['嘉瑩']) // 修好前這裡會是 ['佳柔','嘉瑩']
  })

  it('2 人格拖 1 個到 1 人格', () => {
    const row: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'], 貝斯: ['晨涓'] }
    const after = moveSameRow(row, '音控', '貝斯', '嘉瑩')
    expect(after.音控).toEqual(['佳柔'])
    expect(after.貝斯).toEqual(['晨涓', '嘉瑩'])
  })

  it('3 人格拖中間那個到 2 人格', () => {
    const row: ScheduleRow = { date: '2026.08.09', 音控: ['A', 'B', 'C'], 貝斯: ['X', 'Y'] }
    const after = moveSameRow(row, '音控', '貝斯', 'B')
    expect(after.音控).toEqual(['A', 'C'])
    expect(after.貝斯).toEqual(['X', 'Y', 'B'])
  })

  it('1 人格拖走 → 來源變空格', () => {
    const row: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩'], 貝斯: [] }
    const after = moveSameRow(row, '音控', '貝斯', '嘉瑩')
    expect(after.音控).toEqual([])
    expect(after.貝斯).toEqual(['嘉瑩'])
  })

  it('同列其他欄位完全不受影響', () => {
    const row: ScheduleRow = {
      date: '2026.08.09',
      音控: ['嘉瑩', '佳柔'],
      貝斯: [],
      主領: ['劉婕'],
      彩排: ['8/8(六)16:30PM'],
    }
    const after = moveSameRow(row, '音控', '貝斯', '嘉瑩')
    expect(after.主領).toEqual(['劉婕'])
    expect(after.彩排).toEqual(['8/8(六)16:30PM'])
    expect(after.date).toBe('2026.08.09')
  })

  it('連續拖兩次：兩個人分別移過去，不互相污染', () => {
    let row: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'], 貝斯: [] }
    row = moveSameRow(row, '音控', '貝斯', '嘉瑩')
    row = moveSameRow(row, '音控', '貝斯', '佳柔')
    expect(row.音控).toEqual([])
    expect(row.貝斯).toEqual(['嘉瑩', '佳柔'])
  })

  it('拖過去再拖回來 → 回到原狀', () => {
    const start: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'], 貝斯: ['晨涓'] }
    const moved = moveSameRow(start, '音控', '貝斯', '嘉瑩')
    const back = moveSameRow(moved, '貝斯', '音控', '嘉瑩')
    expect(back.貝斯).toEqual(['晨涓'])
    expect(back.音控).toEqual(['佳柔', '嘉瑩']) // 順序會變（附加在最後），內容一致
    expect([...(back.音控 as string[])].sort()).toEqual(['佳柔', '嘉瑩'])
  })
})

describe('跨列（不同日期）拖拉', () => {
  it('2 人格拖 1 個到別列空格', () => {
    const a: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'] }
    const b: ScheduleRow = { date: '2026.08.16', 音控: [] }
    const [fa, fb] = moveCrossRow(a, b, '音控', '音控', '嘉瑩')
    expect(fa.音控).toEqual(['佳柔'])
    expect(fb.音控).toEqual(['嘉瑩'])
  })

  it('跨列且換欄位', () => {
    const a: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'], 貝斯: [] }
    const b: ScheduleRow = { date: '2026.08.16', 音控: ['晨涓'], 貝斯: ['以諾'] }
    const [fa, fb] = moveCrossRow(a, b, '音控', '貝斯', '佳柔')
    expect(fa.音控).toEqual(['嘉瑩'])
    expect(fa.貝斯).toEqual([]) // 來源列的其他欄位不動
    expect(fb.貝斯).toEqual(['以諾', '佳柔'])
    expect(fb.音控).toEqual(['晨涓']) // 目標列的其他欄位不動
  })

  it('目標列已有同一人 → 兩列都不變', () => {
    const a: ScheduleRow = { date: '2026.08.09', 音控: ['嘉瑩', '佳柔'] }
    const b: ScheduleRow = { date: '2026.08.16', 音控: ['嘉瑩'] }
    const [fa, fb] = moveCrossRow(a, b, '音控', '音控', '嘉瑩')
    expect(fa.音控).toEqual(['嘉瑩', '佳柔'])
    expect(fb.音控).toEqual(['嘉瑩'])
  })
})
