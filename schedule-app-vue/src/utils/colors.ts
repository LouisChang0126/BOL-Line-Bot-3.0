/** 人名積木顏色 —— 30 種固定色，依「排序後的索引」決定，確保跨畫面一致。 */

export const PERSON_CHIP_COLORS = [
  '#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C', '#E91E63', '#00BCD4',
  '#8BC34A', '#FF5722', '#673AB7', '#009688', '#3949AB', '#795548', '#7CB342', '#FF9800',
  '#4CAF50', '#2196F3', '#F44336', '#9C27B0', '#00ACC1', '#AD1457', '#C0392B', '#D35400',
  '#16A085', '#8E44AD', '#27AE60', '#2980B9', '#283593', '#34495E',
] as const

/**
 * 由所有人名建立「人名 → 顏色」對應表。
 * 與舊版 rebuildPersonColorMap 一致：先排序，再依索引取色，保證同一批人名永遠同色。
 */
export function buildPersonColorMap(names: Iterable<string>): Map<string, string> {
  const sorted = Array.from(new Set(names)).sort()
  const map = new Map<string, string>()
  sorted.forEach((name, index) => {
    map.set(name, PERSON_CHIP_COLORS[index % PERSON_CHIP_COLORS.length])
  })
  return map
}

/** 從對應表取色；未知人名 fallback 用 hash 決定（不污染既有對應） */
export function colorOf(map: Map<string, string>, name: string): string {
  const c = map.get(name)
  if (c) return c
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return PERSON_CHIP_COLORS[hash % PERSON_CHIP_COLORS.length]
}
