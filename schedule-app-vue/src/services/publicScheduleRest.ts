/**
 * 公開查看頁專用的 Firestore 存取層 —— 走 REST API + fetch，「刻意不使用 Firebase SDK」。
 *
 * 為什麼：查看頁只是公開唯讀，用不到 SDK 的即時監聽 / 離線快取 / 認證，
 * 但載入整包 SDK 要 90KB gzip（實測 Fast 3G 光下載就 855ms）。改用 REST 後
 * 這一頁完全不碰 firebase chunk。Firestore 規則對班表與 serve-list 開放公開讀，
 * 因此只帶 apiKey 即可（已實測 200 OK）。
 *
 * 注意：若日後要對這頁啟用 App Check，REST 需自行帶上 App Check token。
 */
import { firebaseConfig } from '@/firebase/config'
import type { ScheduleMetadata, ScheduleRow, Serve } from '@/types'

const PROJECT_ID = firebaseConfig.projectId as string
const API_KEY = firebaseConfig.apiKey as string
const DOCS = `projects/${PROJECT_ID}/databases/(default)/documents`
const BASE = `https://firestore.googleapis.com/v1/${DOCS}`

// ── Firestore REST 值轉換 ──────────────────────────────
type FsValue = Record<string, unknown>

function fromValue(v: FsValue): unknown {
  if ('stringValue' in v) return v.stringValue
  if ('arrayValue' in v) {
    const arr = (v.arrayValue as { values?: FsValue[] })?.values ?? []
    return arr.map(fromValue)
  }
  if ('mapValue' in v) {
    const fields = (v.mapValue as { fields?: Record<string, FsValue> })?.fields ?? {}
    return fromFields(fields)
  }
  if ('booleanValue' in v) return v.booleanValue
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('nullValue' in v) return null
  return undefined
}

function fromFields(fields: Record<string, FsValue>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) out[k] = fromValue(v)
  return out
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, init)
  if (!res.ok) throw new Error(`Firestore REST ${res.status}: ${await res.text()}`)
  return res.json()
}

/** 取單一文件；不存在回傳 null */
async function getDocument(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${BASE}/${path}?key=${API_KEY}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Firestore REST ${res.status}`)
  const json = (await res.json()) as { fields?: Record<string, FsValue> }
  return fromFields(json.fields ?? {})
}

// ── index.html 的預抓結果（early fetch）─────────────────
/**
 * index.html 的 inline script 會在 HTML 解析階段就發出查詢，把 Promise 掛在
 * `window.__preload`，好讓網路請求與 JS 下載並行。這裡負責「取用一次就丟棄」，
 * 並在條件不符（collection 不同、日期不同）時回傳 null，讓呼叫端走正常流程。
 */
interface Preload {
  serveList?: Promise<{ fields?: Record<string, FsValue> }>
  meta?: Promise<{ fields?: Record<string, FsValue> }>
  rows?: Promise<{ document?: { name: string; fields?: Record<string, FsValue> } }[]>
  id?: string
  from?: string
}

function preload(): Preload | null {
  return (window as unknown as { __preload?: Preload }).__preload ?? null
}

/** 用掉某個預抓欄位（只用一次，避免重整資料時拿到過期結果） */
function takePreload<K extends keyof Preload>(key: K): Preload[K] | null {
  const p = preload()
  if (!p || !p[key]) return null
  const value = p[key]
  delete p[key]
  return value
}

/** 依 doc id（`__name__`）範圍查詢，回傳已排序的班表列 */
async function runRangeQuery(
  col: string,
  startInclusive: string,
  endExclusive: string | null,
  limit?: number,
): Promise<ScheduleRow[]> {
  const ref = (id: string) => ({ referenceValue: `${DOCS}/${col}/${id}` })
  const filters: unknown[] = [
    { fieldFilter: { field: { fieldPath: '__name__' }, op: 'GREATER_THAN_OR_EQUAL', value: ref(startInclusive) } },
  ]
  if (endExclusive) {
    filters.push({
      fieldFilter: { field: { fieldPath: '__name__' }, op: 'LESS_THAN', value: ref(endExclusive) },
    })
  }

  const structuredQuery: Record<string, unknown> = {
    from: [{ collectionId: col }],
    where:
      filters.length === 1 ? filters[0] : { compositeFilter: { op: 'AND', filters } },
    orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }],
  }
  if (limit) structuredQuery.limit = limit

  const json = (await getJson(`${BASE}:runQuery?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery }),
  })) as QueryResult
  return rowsFromQueryResult(json)
}

type QueryResult = { document?: { name: string; fields?: Record<string, FsValue> } }[]

function rowsFromQueryResult(json: QueryResult): ScheduleRow[] {
  const rows: ScheduleRow[] = []
  for (const entry of json) {
    if (!entry.document) continue // 查無結果時 REST 會回一筆只有 readTime 的空物件
    const id = entry.document.name.split('/').pop() as string
    // `_metadata` 的字典序排在日期之後，會落進 >= 查詢範圍，需濾掉
    if (id === '_metadata') continue
    rows.push({ date: id, ...(fromFields(entry.document.fields ?? {}) as Record<string, string[]>) })
  }
  return rows
}

// ── 對外 API ──────────────────────────────────────────
export async function fetchServeList(): Promise<Serve[]> {
  const pre = takePreload('serveList')
  let data: Record<string, unknown> | null
  if (pre) {
    try {
      data = fromFields((await pre).fields ?? {})
    } catch {
      data = await getDocument('_config/serve-list') // 預抓失敗 → 重來一次
    }
  } else {
    data = await getDocument('_config/serve-list')
  }
  return ((data?.serves as Serve[]) ?? []).filter((s) => s && s.id && s.name)
}

export async function fetchMetadata(col: string): Promise<ScheduleMetadata | null> {
  let data: Record<string, unknown> | null = null
  const pre = preload()?.id === col ? takePreload('meta') : null
  if (pre) {
    try {
      data = fromFields((await pre).fields ?? {})
    } catch {
      data = null
    }
  }
  if (!data) data = await getDocument(`${col}/_metadata`)
  if (!data) return null
  return {
    serviceItems: (data.serviceItems as string[]) ?? [],
    nonUserColumns: (data.nonUserColumns as string[]) ?? [],
    displayConfig: data.displayConfig as ScheduleMetadata['displayConfig'],
  }
}

export async function fetchFutureRows(col: string, from: string, limit: number): Promise<ScheduleRow[]> {
  // 只有「同一個 collection」且「同一個起始日期」的預抓結果才能採用，
  // 否則（例如快取的 id 已過期、或跨日導致週日不同）一律重查。
  const p = preload()
  if (p && p.id === col && p.from === from) {
    const pre = takePreload('rows')
    if (pre) {
      try {
        return rowsFromQueryResult(await pre)
      } catch {
        /* 預抓失敗 → 落回正常查詢 */
      }
    }
  }
  return runRangeQuery(col, from, null, limit)
}

export function fetchPastRows(col: string, from: string, until: string): Promise<ScheduleRow[]> {
  return runRangeQuery(col, from, until)
}

// ── serve-list 快取（省掉「先查 serve-list 才能查班表」這一段往返）──
const CACHE_KEY = 'public-serve-list-v1'

export function readServeListCache(): Serve[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Serve[]) : null
  } catch {
    return null
  }
}

export function writeServeListCache(serves: Serve[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(serves))
  } catch {
    /* 隱私模式 / 配額滿：快取只是加速手段，失敗直接忽略 */
  }
}
