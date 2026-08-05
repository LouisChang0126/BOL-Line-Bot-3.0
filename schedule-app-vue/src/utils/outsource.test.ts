/**
 * 排班外包：提示詞組裝與 LLM 回覆解析的測試。
 *
 * 解析器特別重要 —— 網頁版 LLM 沒有 tool calling，輸出格式完全不受控，
 * 使用者又是整段複製貼上，因此各種夾雜說明文字、圍欄、格式變體都要能吃下來。
 */
import { describe, expect, it } from 'vitest'
import { buildOutsourcePrompt, mergeWithCurrent, parseOutsourceReply, LLM_TARGETS } from './outsource'
import type { ActiveRules, ScheduleRow } from '@/types'

const RULES: ActiveRules = {
  consecutive: true,
  consecutiveWeeks: 2,
  maxRoles: true,
  maxRolesLimit: 2,
  serviceKnownPeople: true,
  frequencyParity: false,
}

const SCHEDULE: ScheduleRow[] = [
  { date: '2026.08.02', 主領: ['俱佳'], 音控: ['嘉瑩'] },
  { date: '2026.08.09', 主領: ['劉婕'], 音控: ['佳柔'] },
]

function build(over: Partial<Parameters<typeof buildOutsourcePrompt>[0]> = {}) {
  return buildOutsourcePrompt({
    schedule: SCHEDULE,
    generateWeeks: ['2026.08.16', '2026.08.23'],
    serviceItems: ['主領', '音控'],
    rules: RULES,
    ...over,
  })
}

describe('buildOutsourcePrompt', () => {
  it('包含服事欄位、參考班表、生成週次', () => {
    const p = build()
    expect(p).toContain('主領')
    expect(p).toContain('音控')
    expect(p).toContain('2026.08.02') // 參考班表內容
    expect(p).toContain('2026.08.16') // 生成週次
    expect(p).toContain('2026.08.23')
  })

  it('把啟用的規則寫成文字', () => {
    const p = build()
    expect(p).toContain('連續 2 週')
    expect(p).toContain('最多擔任 2 項')
    expect(p).toContain('做過該服事')
    expect(p).not.toContain('誤差控制在') // frequencyParity 關閉
  })

  it('全部規則關閉時會明講「沒有啟用額外規則」', () => {
    const p = build({
      rules: {
        consecutive: false,
        consecutiveWeeks: 2,
        maxRoles: false,
        maxRolesLimit: 3,
        serviceKnownPeople: false,
        frequencyParity: false,
      },
    })
    expect(p).toContain('沒有啟用額外的排班規則')
  })

  it('請假會 pivot 成「某人：日期」並標為硬性要求', () => {
    const p = build({
      leaveByDate: { '2026.08.16': ['嘉瑩', '佳柔'], '2026.08.23': ['嘉瑩'] },
    })
    expect(p).toContain('請假（硬性要求）')
    expect(p).toContain('嘉瑩：2026.08.16、2026.08.23')
    expect(p).toContain('佳柔：2026.08.16')
  })

  it('沒有請假時不出現請假段落', () => {
    expect(build()).not.toContain('請假（硬性要求）')
  })

  it('連續週 context 會標明唯讀且不可輸出', () => {
    const p = build({ consecutiveContextWeeks: ['2026.08.09'] })
    expect(p).toContain('唯讀')
    expect(p).toContain('2026.08.09')
  })

  it('明確要求輸出 JSON 且欄位為陣列', () => {
    const p = build()
    expect(p).toContain('```json')
    expect(p).toContain('scheduleData')
    expect(p).toContain('陣列')
    expect(p).toContain('YYYY.MM.DD')
  })

  it('附加使用者的額外需求', () => {
    expect(build({ userPrompt: '這週讓新人多上場' })).toContain('這週讓新人多上場')
  })

  it('沒有額外需求時不留空段落', () => {
    expect(build({ userPrompt: '   ' })).not.toContain('## 額外需求')
  })
})

describe('parseOutsourceReply — 正常情境', () => {
  const GOOD = `好的，以下是我的排班建議：

\`\`\`json
{
  "scheduleData": [
    { "date": "2026.08.16", "主領": ["俱佳"], "音控": ["嘉瑩"] },
    { "date": "2026.08.23", "主領": ["劉婕"], "音控": [] }
  ],
  "explanation": "避免連續兩週相同"
}
\`\`\`

希望對你有幫助！`

  it('能從夾雜說明文字的圍欄中取出 JSON', () => {
    const r = parseOutsourceReply(GOOD)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.scheduleData).toHaveLength(2)
    expect(r.scheduleData[0]).toEqual({ date: '2026.08.16', 主領: ['俱佳'], 音控: ['嘉瑩'] })
    expect(r.scheduleData[1].音控).toEqual([])
    expect(r.explanation).toBe('避免連續兩週相同')
  })

  it('沒有圍欄的純 JSON 也能解析', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.08.16","主領":["俱佳"]}]}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scheduleData[0].主領).toEqual(['俱佳'])
  })

  it('直接給陣列（沒有包 scheduleData）也接受', () => {
    const r = parseOutsourceReply('[{"date":"2026.08.16","主領":["俱佳"]}]')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scheduleData).toHaveLength(1)
  })

  it('沒有標 json 的圍欄也能解析', () => {
    const r = parseOutsourceReply('```\n{"scheduleData":[{"date":"2026.08.16"}]}\n```')
    expect(r.ok).toBe(true)
  })
})

describe('parseOutsourceReply — 格式容錯', () => {
  it('日期用斜線寫成 2026/08/16 會被正規化', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026/08/16","主領":["俱佳"]}]}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scheduleData[0].date).toBe('2026.08.16')
  })

  it('欄位寫成字串而非陣列時自動拆成陣列', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.08.16","主領":"俱佳/劉婕"}]}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.scheduleData[0].主領).toEqual(['俱佳', '劉婕'])
  })

  it('中文頓號分隔也能拆開', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.08.16","主領":"俱佳、劉婕"}]}')
    if (r.ok) expect(r.scheduleData[0].主領).toEqual(['俱佳', '劉婕'])
  })

  it('陣列中的空字串會被濾掉', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.08.16","主領":["俱佳","  ",""]}]}')
    if (r.ok) expect(r.scheduleData[0].主領).toEqual(['俱佳'])
  })

  it('日期格式錯誤的列會被略過', () => {
    const r = parseOutsourceReply(
      '{"scheduleData":[{"date":"下週日","主領":["A"]},{"date":"2026.08.16","主領":["B"]}]}',
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.scheduleData).toHaveLength(1)
      expect(r.scheduleData[0].主領).toEqual(['B'])
    }
  })

  it('沒有 explanation 時回傳空字串而非壞掉', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.08.16"}]}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.explanation).toBe('')
  })
})

describe('parseOutsourceReply — 限制在生成週次內', () => {
  const ALLOWED = ['2026.08.16', '2026.08.23']

  it('濾掉不在生成範圍內的日期（LLM 常多輸出鄰近週）', () => {
    const r = parseOutsourceReply(
      `{"scheduleData":[
        {"date":"2026.08.09","主領":["不該出現"]},
        {"date":"2026.08.16","主領":["俱佳"]}
      ]}`,
      ALLOWED,
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.scheduleData).toHaveLength(1)
      expect(r.scheduleData[0].date).toBe('2026.08.16')
    }
  })

  it('全部都在範圍外時給出明確錯誤', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.09.06","主領":["A"]}]}', ALLOWED)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('生成週次')
  })

  it('沒給 allowedDates 時不做過濾', () => {
    const r = parseOutsourceReply('{"scheduleData":[{"date":"2026.09.06","主領":["A"]}]}')
    expect(r.ok).toBe(true)
  })
})

describe('parseOutsourceReply — 錯誤處理', () => {
  it('空字串', () => {
    const r = parseOutsourceReply('   ')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('請先貼上')
  })

  it('完全沒有 JSON 的閒聊文字', () => {
    const r = parseOutsourceReply('抱歉，我需要更多資訊才能排班。')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('找不到 JSON')
  })

  it('JSON 壞掉（少了引號）', () => {
    const r = parseOutsourceReply('```json\n{scheduleData: [oops}\n```')
    expect(r.ok).toBe(false)
  })

  it('是合法 JSON 但沒有 scheduleData', () => {
    const r = parseOutsourceReply('{"foo":"bar"}')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('scheduleData')
  })

  it('scheduleData 是空陣列', () => {
    const r = parseOutsourceReply('{"scheduleData":[]}')
    expect(r.ok).toBe(false)
  })
})

describe('mergeWithCurrent — 保護 LLM 沒提到的欄位', () => {
  const SERVICES = ['主領', '副主領', '音控']
  const CURRENT: ScheduleRow[] = [
    { date: '2026.08.16', 主領: ['俱佳'], 副主領: ['恩謙'], 音控: ['嘉瑩'] },
  ]

  it('回覆只給部分欄位時，其餘沿用原值（不可以被清空）', () => {
    const merged = mergeWithCurrent([{ date: '2026.08.16', 主領: ['劉婕'] }], CURRENT, SERVICES)
    expect(merged[0].主領).toEqual(['劉婕']) // 有給 → 覆蓋
    expect(merged[0].副主領).toEqual(['恩謙']) // 沒給 → 保留
    expect(merged[0].音控).toEqual(['嘉瑩']) // 沒給 → 保留
  })

  it('明確給空陣列＝真的要清空，屬於有效變更', () => {
    const merged = mergeWithCurrent([{ date: '2026.08.16', 音控: [] }], CURRENT, SERVICES)
    expect(merged[0].音控).toEqual([])
    expect(merged[0].主領).toEqual(['俱佳'])
  })

  it('找不到對應日期時，未提供的欄位給空陣列而不是爆掉', () => {
    const merged = mergeWithCurrent([{ date: '2026.09.06', 主領: ['甲'] }], CURRENT, SERVICES)
    expect(merged[0].主領).toEqual(['甲'])
    expect(merged[0].副主領).toEqual([])
  })

  it('不會就地修改原本的班表資料', () => {
    const current: ScheduleRow[] = [{ date: '2026.08.16', 主領: ['俱佳'] }]
    const merged = mergeWithCurrent([{ date: '2026.08.16' }], current, ['主領'])
    ;(merged[0].主領 as string[]).push('亂入')
    expect(current[0].主領).toEqual(['俱佳'])
  })

  it('只處理傳入的服事欄位（資訊欄不會被帶進來）', () => {
    const merged = mergeWithCurrent(
      [{ date: '2026.08.16', 彩排: ['8/15 16:30'] }],
      CURRENT,
      SERVICES,
    )
    expect(merged[0].彩排).toBeUndefined()
  })
})

describe('LLM_TARGETS', () => {
  it('提供 Gemini / ChatGPT / Claude 三個入口且都是 https', () => {
    expect(LLM_TARGETS.map((t) => t.id)).toEqual(['gemini', 'chatgpt', 'claude'])
    for (const t of LLM_TARGETS) {
      expect(t.url).toMatch(/^https:\/\//)
      expect(t.name).toBeTruthy()
    }
  })
})
