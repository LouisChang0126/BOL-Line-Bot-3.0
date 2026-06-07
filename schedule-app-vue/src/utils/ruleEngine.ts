/**
 * AI 排班規則引擎（純函式，無副作用、可測試）。
 * 由舊版 agent.js 的 buildChangedCellSet / validateScopedChanges 移植而來。
 */
import type { ActiveRules, RuleWarning } from '@/types'
import type { ScheduleRow } from '@/types'
import { cellOf } from './schedule'

function buildScheduleIndex(rows: ScheduleRow[]): Map<string, ScheduleRow> {
  const index = new Map<string, ScheduleRow>()
  for (const row of rows) if (row?.date) index.set(row.date, row)
  return index
}

/** 比對前後班表，找出有變更的格子（key = `date|service`）。allowedDates 限定偵測範圍。 */
export function buildChangedCellSet(
  base: ScheduleRow[],
  next: ScheduleRow[],
  userServiceItems: string[],
  allowedDates: string[] | null,
): Set<string> {
  const changed = new Set<string>()
  const baseIndex = buildScheduleIndex(base)
  const nextIndex = buildScheduleIndex(next)
  const allDates = new Set([...baseIndex.keys(), ...nextIndex.keys()])
  const allow = allowedDates && allowedDates.length > 0 ? new Set(allowedDates) : null

  for (const date of allDates) {
    if (allow && !allow.has(date)) continue
    const baseRow = baseIndex.get(date)
    const nextRow = nextIndex.get(date)
    for (const service of userServiceItems) {
      const a = JSON.stringify(cellOf(baseRow, service))
      const b = JSON.stringify(cellOf(nextRow, service))
      if (a !== b) changed.add(`${date}|${service}`)
    }
  }
  return changed
}

/**
 * 計算「禁止連續 N 週」需要 LLM 看到的相鄰邊界週次。
 * 對應舊版 _computeConsecutiveContextDates。
 */
export function computeConsecutiveContextDates(
  generateWeeks: string[],
  n: number,
  schedRows: ScheduleRow[],
): string[] {
  if (!Array.isArray(generateWeeks) || generateWeeks.length === 0) return []
  const N = Math.max(0, parseInt(String(n), 10) || 0)
  if (N <= 1) return []
  const allDates = schedRows.map((r) => r.date).filter(Boolean).sort()
  const genSet = new Set(generateWeeks)
  const sortedGen = [...generateWeeks].sort()
  const firstIdx = allDates.indexOf(sortedGen[0])
  const lastIdx = allDates.indexOf(sortedGen[sortedGen.length - 1])
  const out = new Set<string>()
  if (firstIdx > 0) {
    for (let i = 1; i <= N - 1; i++) {
      const idx = firstIdx - i
      if (idx < 0) break
      if (!genSet.has(allDates[idx])) out.add(allDates[idx])
    }
  }
  if (lastIdx >= 0 && lastIdx < allDates.length - 1) {
    for (let i = 1; i <= N - 1; i++) {
      const idx = lastIdx + i
      if (idx >= allDates.length) break
      if (!genSet.has(allDates[idx])) out.add(allDates[idx])
    }
  }
  return [...out].sort()
}

export interface ValidateArgs {
  baseScheduleData: ScheduleRow[]
  nextScheduleData: ScheduleRow[]
  serviceItems: string[]
  nonUserColumns: string[]
  activeRules: Partial<ActiveRules>
  changedCells: Set<string>
  referenceWeeks?: string[]
  generateWeeks?: string[]
  leaveByDate?: Record<string, string[]>
  consecutiveContextWeeks?: string[]
}

export interface ValidationResult {
  valid: boolean
  warnings: RuleWarning[]
}

/** 服事頻率一致性規則的相對誤差容忍度（±50%） */
const FREQUENCY_PARITY_TOLERANCE = 0.5

/**
 * 對 AI 產生的變更套用規則檢查，回傳警告清單（對應舊版 validateScopedChanges）。
 * 只檢查有變更的格子所涉及的視窗，效能與舊版一致。
 */
export function validateScopedChanges({
  baseScheduleData,
  nextScheduleData,
  serviceItems,
  nonUserColumns,
  activeRules,
  changedCells,
  referenceWeeks = [],
  generateWeeks = [],
  leaveByDate = {},
  consecutiveContextWeeks = [],
}: ValidateArgs): ValidationResult {
  const warnings: RuleWarning[] = []
  const userServiceItems = serviceItems.filter((s) => !nonUserColumns.includes(s))
  if (!changedCells || changedCells.size === 0) return { valid: true, warnings: [] }

  const nextIndex = buildScheduleIndex(nextScheduleData)
  const changedByDate = new Map<string, Set<string>>()
  for (const key of changedCells) {
    const [date, service] = key.split('|')
    if (!date || !service) continue
    if (!changedByDate.has(date)) changedByDate.set(date, new Set())
    changedByDate.get(date)!.add(service)
  }

  // 規則1：禁止連續 N 週同服事
  if (activeRules?.consecutive) {
    const consecutiveWeeks = Math.max(2, parseInt(String(activeRules?.consecutiveWeeks), 10) || 2)
    const baseIdx = buildScheduleIndex(baseScheduleData)
    const nextDateSet = new Set(nextScheduleData.map((r) => r.date))
    const augmented = [...nextScheduleData]
    for (const d of consecutiveContextWeeks) {
      if (nextDateSet.has(d)) continue
      const baseRow = baseIdx.get(d)
      if (baseRow) augmented.push(baseRow)
    }
    const rows = augmented.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    const dateToIndex = new Map<string, number>()
    rows.forEach((row, idx) => dateToIndex.set(row.date, idx))
    const seen = new Set<string>()

    changedByDate.forEach((services, date) => {
      const changedIdx = dateToIndex.get(date)
      if (changedIdx === undefined) return
      services.forEach((service) => {
        if (!userServiceItems.includes(service)) return
        const startMin = Math.max(0, changedIdx - consecutiveWeeks + 1)
        const startMax = Math.min(changedIdx, rows.length - consecutiveWeeks)
        for (let start = startMin; start <= startMax; start++) {
          const windowRows = rows.slice(start, start + consecutiveWeeks)
          let common = new Set(cellOf(windowRows[0], service))
          for (let w = 1; w < windowRows.length; w++) {
            const cur = new Set(cellOf(windowRows[w], service))
            common = new Set([...common].filter((n) => cur.has(n)))
            if (common.size === 0) break
          }
          const startDate = windowRows[0].date
          const endDate = windowRows[windowRows.length - 1].date
          common.forEach((name) => {
            const key = `${service}|${name}|${startDate}|${endDate}`
            if (seen.has(key)) return
            seen.add(key)
            warnings.push({
              type: 'consecutive',
              message: `⚠️ ${name} 連續${consecutiveWeeks}週擔任「${service}」（${startDate} → ${endDate}）`,
              date: endDate,
              service,
              person: name,
            })
          })
        }
      })
    })
  }

  // 規則2：每人每週最多 N 項
  if (activeRules?.maxRoles) {
    const maxRoles = Math.max(1, parseInt(String(activeRules?.maxRolesLimit), 10) || 3)
    changedByDate.forEach((_services, date) => {
      const row = nextIndex.get(date)
      if (!row) return
      const counts: Record<string, number> = {}
      for (const service of userServiceItems) {
        for (const name of cellOf(row, service)) counts[name] = (counts[name] || 0) + 1
      }
      Object.entries(counts).forEach(([name, count]) => {
        if (count > maxRoles) {
          warnings.push({
            type: 'maxRoles',
            message: `⚠️ ${name} 在 ${date} 擔任了 ${count} 項服事（上限 ${maxRoles}）`,
            date,
            person: name,
            count,
          })
        }
      })
    })
  }

  // 規則3：僅使用該服事歷史人員
  if (activeRules?.serviceKnownPeople) {
    const allowedByService: Record<string, Set<string>> = {}
    for (const service of userServiceItems) allowedByService[service] = new Set()
    for (const row of baseScheduleData) {
      for (const service of userServiceItems) {
        for (const name of cellOf(row, service)) allowedByService[service].add(name)
      }
    }
    const seen = new Set<string>()
    changedByDate.forEach((services, date) => {
      const row = nextIndex.get(date)
      if (!row) return
      services.forEach((service) => {
        if (!userServiceItems.includes(service)) return
        for (const name of cellOf(row, service)) {
          if (allowedByService[service].has(name)) continue
          const key = `${date}|${service}|${name}`
          if (seen.has(key)) return
          seen.add(key)
          warnings.push({
            type: 'serviceKnownPeople',
            message: `⚠️ ${name} 不在 ${service} 的歷史名單`,
            date,
            service,
            person: name,
          })
        }
      })
    })
  }

  // 規則4：服事頻率與參考班表一致
  if (activeRules?.frequencyParity) {
    const refSet = new Set(referenceWeeks)
    const genSet = new Set(generateWeeks)
    const countByName = (rows: ScheduleRow[], dateSet: Set<string>) => {
      const counts = new Map<string, number>()
      for (const row of rows) {
        if (!dateSet.has(row.date)) continue
        for (const service of userServiceItems) {
          for (const name of cellOf(row, service)) counts.set(name, (counts.get(name) || 0) + 1)
        }
      }
      return counts
    }
    const refCounts = countByName(baseScheduleData, refSet)
    const genCounts = countByName(nextScheduleData, genSet)
    const refLen = referenceWeeks.length
    const genLen = generateWeeks.length
    const allNames = new Set([...refCounts.keys(), ...genCounts.keys()])
    const tolPct = Math.round(FREQUENCY_PARITY_TOLERANCE * 100)
    const seen = new Set<string>()
    for (const name of allNames) {
      const refC = refCounts.get(name) || 0
      const genC = genCounts.get(name) || 0
      const expected = refLen > 0 ? (refC / refLen) * genLen : 0
      if (expected <= 0) continue
      const relDiff = Math.abs(genC - expected) / expected
      if (relDiff > FREQUENCY_PARITY_TOLERANCE && !seen.has(name)) {
        seen.add(name)
        warnings.push({
          type: 'frequencyParity',
          message: `⚠️ ${name} 服事頻率偏離參考（參考 ${refC}/${refLen} 週 → 生成 ${genC}/${genLen} 週，期望約 ${expected.toFixed(1)}，誤差 ${(relDiff * 100).toFixed(0)}% 超過 ${tolPct}%）`,
          person: name,
        })
      }
    }
  }

  // 規則5：請假 — 該週指定的人不應出現在任何服事
  if (leaveByDate && Object.keys(leaveByDate).length > 0) {
    const seen = new Set<string>()
    Object.entries(leaveByDate).forEach(([date, names]) => {
      const row = nextIndex.get(date)
      if (!row || !Array.isArray(names) || names.length === 0) return
      const nameSet = new Set(names)
      for (const service of userServiceItems) {
        for (const n of cellOf(row, service)) {
          if (!nameSet.has(n)) continue
          const key = `${date}|${service}|${n}`
          if (seen.has(key)) return
          seen.add(key)
          warnings.push({
            type: 'personUnavailability',
            message: `⚠️ ${n} 在 ${date} 請假，但仍被排了「${service}」`,
            date,
            service,
            person: n,
          })
        }
      }
    })
  }

  return { valid: warnings.length === 0, warnings }
}
