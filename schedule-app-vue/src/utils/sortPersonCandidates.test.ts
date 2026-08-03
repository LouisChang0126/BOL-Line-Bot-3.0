/**
 * 格子就地編輯時「可點選人員」的排序測試。
 *
 * 優先序：跟打的字有關 > 其他週做過同一個服事（老手）> 其他。
 */
import { describe, expect, it } from 'vitest'
import { sortPersonCandidates } from './schedule'

const ALL = ['嘉瑩', '佳柔', '劉婕', '劉箴', '德惟', '嘉恩']

describe('沒有輸入時', () => {
  it('老手排前面，其餘依中文筆順', () => {
    const out = sortPersonCandidates(ALL, { veterans: new Set(['劉婕', '德惟']) })
    expect(out.slice(0, 2).sort()).toEqual(['劉婕', '德惟'])
    expect(out).toHaveLength(ALL.length)
  })

  it('沒有老手時就是單純排序', () => {
    const out = sortPersonCandidates(['丙', '甲', '乙'], {})
    expect(out).toEqual(['丙', '甲', '乙'].sort((a, b) => a.localeCompare(b, 'zh-TW')))
  })

  it('空字串 / 只有空白的輸入視同沒有輸入', () => {
    const v = new Set(['德惟'])
    expect(sortPersonCandidates(ALL, { query: '', veterans: v })[0]).toBe('德惟')
    expect(sortPersonCandidates(ALL, { query: '   ', veterans: v })[0]).toBe('德惟')
  })
})

describe('有輸入時', () => {
  it('以輸入開頭的人排最前面', () => {
    const out = sortPersonCandidates(ALL, { query: '嘉' })
    expect(out.slice(0, 2).sort()).toEqual(['嘉恩', '嘉瑩'])
  })

  it('開頭相符 > 中間相符', () => {
    const out = sortPersonCandidates(['王小明', '小明', '陳大華'], { query: '小明' })
    expect(out[0]).toBe('小明') // 開頭
    expect(out[1]).toBe('王小明') // 中間
  })

  it('相符者即使不是老手，也排在老手前面', () => {
    const out = sortPersonCandidates(ALL, { query: '嘉', veterans: new Set(['德惟', '劉婕']) })
    expect(out.slice(0, 2).sort()).toEqual(['嘉恩', '嘉瑩'])
    expect(out.slice(2, 4).sort()).toEqual(['劉婕', '德惟'])
  })

  it('同樣相符時，老手排前面', () => {
    const out = sortPersonCandidates(['嘉瑩', '嘉恩'], { query: '嘉', veterans: new Set(['嘉恩']) })
    expect(out).toEqual(['嘉恩', '嘉瑩'])
  })

  it('完整三級順序：相符 → 老手 → 其他', () => {
    const out = sortPersonCandidates(['其他人', '老手甲', '嘉瑩'], {
      query: '嘉',
      veterans: new Set(['老手甲']),
    })
    expect(out).toEqual(['嘉瑩', '老手甲', '其他人'])
  })

  it('輸入完整名字時該人排第一', () => {
    const out = sortPersonCandidates(ALL, { query: '劉箴' })
    expect(out[0]).toBe('劉箴')
  })
})

describe('只排序、不過濾', () => {
  it('沒有任何人相符時，名單仍然完整（只是回到老手優先）', () => {
    const out = sortPersonCandidates(ALL, { query: 'zzz', veterans: new Set(['德惟']) })
    expect(out).toHaveLength(ALL.length)
    expect(out[0]).toBe('德惟')
    expect([...out].sort()).toEqual([...ALL].sort())
  })

  it('有相符時也不會丟掉不相符的人', () => {
    const out = sortPersonCandidates(ALL, { query: '嘉' })
    expect(out).toHaveLength(ALL.length)
    expect([...out].sort()).toEqual([...ALL].sort())
  })

  it('空名單不會出錯', () => {
    expect(sortPersonCandidates([], { query: '嘉' })).toEqual([])
  })

  it('不會就地修改傳入的陣列', () => {
    const input = ['丙', '甲', '乙']
    sortPersonCandidates(input, { query: '甲' })
    expect(input).toEqual(['丙', '甲', '乙'])
  })
})
