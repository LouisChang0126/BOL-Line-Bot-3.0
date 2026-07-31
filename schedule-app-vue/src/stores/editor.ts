/**
 * 班表編輯器中央 store（取代舊版 app.js 的大部分職責）。
 *
 * 負責：資料載入/同步、人員與服事 CRUD、撤銷重做、編輯記錄、單一分頁鎖、
 * 顯示分組、匯出 Excel、結構變更（給 AI agent 用）。
 *
 * 反應式設計：scheduleData 是 deep reactive ref，直接改 row[service] 即會更新畫面，
 * 不再需要舊版的手動 renderTable / renderSingleCell。寫入仍採「先存後 commit」模式，
 * 失敗（含分頁鎖）時記憶體不殘留幻影編輯。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import * as XLSX from 'xlsx'
import {
  bulkWrite,
  deleteScheduleRow,
  renameServiceInPast,
  saveMetadata as saveMetadataDoc,
  saveScheduleRow,
} from '@/services/scheduleWrite'
import { loadFutureRows, loadMetadata, loadPastRows } from '@/services/schedule'
import { loadAllUsers } from '@/services/users'
import { doc, setDoc, deleteDoc, getDocs, collection as fsCollection, query, where } from 'firebase/firestore'
import { db } from '@/firebase'
import { buildPersonColorMap, colorOf } from '@/utils/colors'
import {
  MAX_FUTURE_ROWS,
  addDays,
  formatDateString,
  formatTimestampId,
  getCurrentSunday,
  parseDateString,
} from '@/utils/dates'
import { cellOf, computeMove } from '@/utils/schedule'
import type { DisplayConfig, ScheduleMetadata, ScheduleRow, UserDoc } from '@/types'

const MAX_HISTORY_SIZE = 20
const TAB_LOCK_PREFIX = 'editor_active_tab__'
const TAB_LOCK_SESSION_KEY = 'editor_tab_id'

interface HistorySnapshot {
  scheduleData: ScheduleRow[]
  serviceItems: string[]
  nonUserColumns: string[]
  displayConfig: DisplayConfig | null
}

export const useEditorStore = defineStore('editor', () => {
  // ── 狀態 ──────────────────────────────────────────────
  const collection = ref('')
  const scheduleData = ref<ScheduleRow[]>([])
  const pastData = ref<ScheduleRow[]>([])
  const pastDataLoaded = ref(false)
  const showingPast = ref(false)
  const serviceItems = ref<string[]>([])
  const nonUserColumns = ref<string[]>([])
  const displayConfig = ref<DisplayConfig | null>(null)
  const personNames = ref<string[]>([])
  const status = ref('載入中...')
  const isLocked = ref(false)
  const userAlert = ref(false)

  // 撤銷/重做
  const historyStack = ref<string[]>([])
  const historyIndex = ref(-1)
  let isRestoring = false

  // 編輯記錄
  let sessionStartTime = formatTimestampId()
  let originalChart: Record<string, Record<string, string[]>> = {}
  let editDifference: Record<string, Record<string, { old: string[]; new: string[] } | boolean>> = {}
  let hasEdited = false
  const sources = new Set<string>()
  let logWasWritten = false
  let saveDebounce: ReturnType<typeof setTimeout> | null = null

  // 使用者快取（檢查未註冊/需更新）
  let usersCache: Record<string, UserDoc> = {}

  // 分頁鎖
  let myTabId: string | null = null
  let tabLockKey: string | null = null

  // ── 計算屬性 ──────────────────────────────────────────
  const personColorMap = computed(() => buildPersonColorMap(personNames.value))
  const canUndo = computed(() => historyIndex.value > 0)
  const canRedo = computed(() => historyIndex.value < historyStack.value.length - 1)
  const allPersonNames = computed(() => new Set(personNames.value))

  function getPersonColor(name: string): string {
    return colorOf(personColorMap.value, name)
  }

  function addPersonName(name: string) {
    if (!personNames.value.includes(name)) personNames.value.push(name)
  }

  // ── 分頁鎖 ────────────────────────────────────────────
  function initTabLock() {
    try {
      tabLockKey = TAB_LOCK_PREFIX + (collection.value || '_default')
      myTabId = sessionStorage.getItem(TAB_LOCK_SESSION_KEY)
      if (!myTabId) {
        myTabId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
        sessionStorage.setItem(TAB_LOCK_SESSION_KEY, myTabId)
      }
      localStorage.setItem(tabLockKey, myTabId)
      isLocked.value = false
      window.addEventListener('storage', (e) => {
        if (e.key !== tabLockKey) return
        if (e.newValue && e.newValue !== myTabId) isLocked.value = true
      })
    } catch (err) {
      console.warn('Tab lock init failed:', err)
      isLocked.value = false
    }
  }

  /** 重新取回此分頁的編輯權（使用者按「在此分頁繼續編輯」） */
  function reclaimTabLock() {
    try {
      if (tabLockKey && myTabId) localStorage.setItem(tabLockKey, myTabId)
    } catch {
      /* ignore */
    }
  }

  function assertEditing() {
    if (isLocked.value) throw new Error('TAB_LOCKED')
  }

  function isTabLockError(e: unknown): boolean {
    return e instanceof Error && e.message === 'TAB_LOCKED'
  }

  // ── 載入 ──────────────────────────────────────────────
  async function load(col: string) {
    collection.value = col
    status.value = '載入資料中...'
    initTabLock()
    try {
      const meta = await loadMetadata(col)
      if (!meta) throw new Error('沒有 metadata')
      serviceItems.value = meta.serviceItems
      nonUserColumns.value = meta.nonUserColumns
      displayConfig.value = meta.displayConfig ?? defaultDisplayConfig(meta.serviceItems)

      const rows = await loadFutureRows(col)
      scheduleData.value = rows
      rebuildPersonNames()

      if (scheduleData.value.length === 0) {
        await createInitialData()
      }

      snapshotOriginal()
      initHistory()
      void refreshUsersBadge()
      status.value = '就緒'
    } catch (e) {
      console.error('載入資料失敗:', e)
      status.value = '載入失敗'
      throw e
    }
  }

  function defaultDisplayConfig(items: string[]): DisplayConfig {
    return {
      groups: [{ id: 'ungrouped', name: '未分組', items: [...items], defaultVisible: true }],
      hidden: [],
    }
  }

  function rebuildPersonNames() {
    const nonUser = new Set(nonUserColumns.value)
    const set = new Set<string>()
    for (const row of scheduleData.value) {
      for (const item of serviceItems.value) {
        if (nonUser.has(item)) continue
        for (const name of cellOf(row, item)) set.add(name)
      }
    }
    personNames.value = Array.from(set)
  }

  async function createInitialData() {
    const start = getCurrentSunday()
    serviceItems.value = ['範例服事']
    await persistMetadata()
    for (let i = 0; i < 4; i++) {
      const d = new Date(start)
      d.setDate(d.getDate() + i * 7)
      const dateStr = formatDateString(d)
      const data: ScheduleRow = { date: dateStr }
      for (const item of serviceItems.value) data[item] = []
      scheduleData.value.push(data)
      await saveScheduleRow(collection.value, dateStr, { ...data })
    }
  }

  async function loadPast() {
    if (pastDataLoaded.value) return
    pastDataLoaded.value = true
    status.value = '載入歷史資料中...'
    try {
      pastData.value = await loadPastRows(collection.value)
    } catch (e) {
      console.error('載入歷史資料失敗:', e)
      pastData.value = []
    }
    status.value = '就緒'
  }

  async function togglePast() {
    if (!showingPast.value && !pastDataLoaded.value) await loadPast()
    showingPast.value = !showingPast.value
  }

  // ── metadata / 寫入 helpers ──────────────────────────
  function metadataPayload() {
    return {
      serviceItems: serviceItems.value,
      nonUserColumns: nonUserColumns.value,
      displayConfig: displayConfig.value ?? undefined,
    }
  }

  async function persistMetadata() {
    assertEditing()
    await saveMetadataDoc(collection.value, metadataPayload())
  }

  // ── 人員 CRUD ─────────────────────────────────────────
  async function addPersonToCell(date: string, service: string, person: string): Promise<boolean> {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return false
    const current = cellOf(row, service)
    if (current.includes(person)) {
      window.alert('此人員已在此服事項目中')
      return false
    }
    const newArr = [...current, person]
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: newArr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return false
    }
    row[service] = newArr
    addPersonName(person)
    afterMutation()
    void refreshUsersBadge()
    return true
  }

  async function removePerson(date: string, service: string, person: string): Promise<boolean> {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return false
    const current = cellOf(row, service)
    const idx = current.indexOf(person)
    if (idx < 0) return false
    const newArr = current.slice(0, idx).concat(current.slice(idx + 1))
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: newArr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return false
    }
    row[service] = newArr
    afterMutation()
    void refreshUsersBadge()
    return true
  }

  async function movePerson(
    fromDate: string,
    fromService: string,
    toDate: string,
    toService: string,
    person: string,
  ): Promise<boolean> {
    const fromRow = scheduleData.value.find((r) => r.date === fromDate)
    const toRow = scheduleData.value.find((r) => r.date === toDate)
    if (!fromRow || !toRow) return false
    if (fromDate === toDate && fromService === toService) return false
    const outcome = computeMove(cellOf(fromRow, fromService), cellOf(toRow, toService), person)
    if (!outcome.ok) {
      if (outcome.reason === 'duplicate') window.alert('目標格已經有這位同工')
      return false
    }
    const sameRow = fromRow.date === toRow.date
    const newFromArr = outcome.fromCell
    const newToArr = outcome.toCell

    try {
      assertEditing()
      if (sameRow) {
        await saveScheduleRow(collection.value, fromRow.date, {
          ...fromRow,
          [fromService]: newFromArr,
          [toService]: newToArr,
        })
      } else {
        await bulkWrite({
          collection: collection.value,
          rowUpdates: [
            { date: fromRow.date, data: { ...fromRow, [fromService]: newFromArr } },
            { date: toRow.date, data: { ...toRow, [toService]: newToArr } },
          ],
        })
      }
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return false
    }
    fromRow[fromService] = newFromArr
    toRow[toService] = newToArr
    afterMutation()
    void refreshUsersBadge()
    return true
  }

  // ── 資訊欄位 CRUD ─────────────────────────────────────
  async function addInfoItem(date: string, service: string, value: string) {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return
    const newArr = [...cellOf(row, service), value]
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: newArr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return
    }
    row[service] = newArr
    afterMutation()
  }

  async function updateInfoItem(date: string, service: string, index: number, value: string) {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return
    const arr = [...cellOf(row, service)]
    arr[index] = value
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: arr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return
    }
    row[service] = arr
    afterMutation()
  }

  async function removeInfoItem(date: string, service: string, index: number) {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return
    const arr = cellOf(row, service).slice()
    arr.splice(index, 1)
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: arr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return
    }
    row[service] = arr
    afterMutation()
  }

  // ── 週次（列）管理 ────────────────────────────────────
  async function addRow(): Promise<void> {
    if (scheduleData.value.length === 0) {
      window.alert('請先建立初始資料')
      return
    }
    if (scheduleData.value.length >= MAX_FUTURE_ROWS) {
      window.alert(`已達到最大筆數限制（${MAX_FUTURE_ROWS}週）`)
      return
    }
    const last = scheduleData.value[scheduleData.value.length - 1].date
    const newDate = addDays(last, 7)
    const data: ScheduleRow = { date: newDate }
    for (const item of serviceItems.value) data[item] = []
    try {
      assertEditing()
      await saveScheduleRow(collection.value, newDate, { ...data })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('新增一週失敗：' + errMsg(e))
      return
    }
    scheduleData.value.push(data)
    afterMutation()
  }

  async function deleteLastRow(): Promise<void> {
    if (scheduleData.value.length === 0) return
    const last = scheduleData.value[scheduleData.value.length - 1]
    try {
      assertEditing()
      await deleteScheduleRow(collection.value, last.date)
    } catch (e) {
      if (!isTabLockError(e)) window.alert('刪除失敗：' + errMsg(e))
      return
    }
    scheduleData.value.pop()
    afterMutation()
  }

  // ── 服事/資訊欄位管理 ─────────────────────────────────
  async function doAddColumn(name: string, isInfo: boolean): Promise<void> {
    serviceItems.value.push(name)
    if (isInfo) nonUserColumns.value.push(name)
    if (displayConfig.value) {
      const ung = displayConfig.value.groups.find((g) => g.id === 'ungrouped')
      if (ung) ung.items.push(name)
    }
    for (const row of scheduleData.value) row[name] = []
    try {
      assertEditing()
      await bulkWrite({
        collection: collection.value,
        rowUpdates: scheduleData.value.map((r) => ({ date: r.date, data: { ...r } })),
        metadata: metadataPayload(),
      })
    } catch (e) {
      if (!isTabLockError(e)) {
        window.alert('新增失敗：' + errMsg(e))
        // 回滾
        serviceItems.value.pop()
        if (isInfo) nonUserColumns.value.pop()
        for (const row of scheduleData.value) delete row[name]
      }
      return
    }
    afterMutation()
  }

  async function deleteServiceItem(name: string): Promise<void> {
    const idx = serviceItems.value.indexOf(name)
    if (idx < 0) return
    serviceItems.value.splice(idx, 1)
    removeFromDisplayConfig(name)
    const nIdx = nonUserColumns.value.indexOf(name)
    if (nIdx > -1) nonUserColumns.value.splice(nIdx, 1)
    for (const row of scheduleData.value) delete row[name]
    try {
      assertEditing()
      await bulkWrite({
        collection: collection.value,
        rowUpdates: scheduleData.value.map((r) => ({ date: r.date, data: { ...r } })),
        metadata: metadataPayload(),
      })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('刪除服事項目失敗：' + errMsg(e))
      return
    }
    afterMutation()
    void refreshUsersBadge()
  }

  function removeFromDisplayConfig(name: string) {
    const dc = displayConfig.value
    if (!dc) return
    for (const g of dc.groups) {
      const i = g.items.indexOf(name)
      if (i > -1) g.items.splice(i, 1)
    }
    const h = dc.hidden.indexOf(name)
    if (h > -1) dc.hidden.splice(h, 1)
  }

  /** 重新命名服事項目（含 displayConfig / 歷史班表 / users.serve_types 同步） */
  async function renameService(oldName: string, newName: string, isInfo: boolean): Promise<void> {
    const nameChanged = newName !== oldName
    const wasInfo = nonUserColumns.value.includes(oldName)

    // nonUserColumns 調整
    if (isInfo && !wasInfo) nonUserColumns.value.push(nameChanged ? newName : oldName)
    else if (!isInfo && wasInfo) {
      const i = nonUserColumns.value.indexOf(oldName)
      if (i > -1) nonUserColumns.value.splice(i, 1)
    } else if (nameChanged && wasInfo) {
      const i = nonUserColumns.value.indexOf(oldName)
      if (i > -1) nonUserColumns.value[i] = newName
    }

    if (!nameChanged) {
      try {
        await persistMetadata()
      } catch (e) {
        if (!isTabLockError(e)) window.alert('更新失敗：' + errMsg(e))
        return
      }
      void refreshUsersBadge()
      return
    }

    // 改名：serviceItems + displayConfig + 每列資料
    const i = serviceItems.value.indexOf(oldName)
    if (i > -1) serviceItems.value[i] = newName
    if (displayConfig.value) {
      for (const g of displayConfig.value.groups) {
        const j = g.items.indexOf(oldName)
        if (j > -1) g.items[j] = newName
      }
      const h = displayConfig.value.hidden.indexOf(oldName)
      if (h > -1) displayConfig.value.hidden[h] = newName
    }
    for (const row of scheduleData.value) {
      row[newName] = cellOf(row, oldName)
      delete row[oldName]
    }
    try {
      assertEditing()
      await bulkWrite({
        collection: collection.value,
        rowUpdates: scheduleData.value.map((r) => ({ date: r.date, data: { ...r } })),
        metadata: metadataPayload(),
      })
      // 同步歷史班表（最多 100 週）
      const cs = getCurrentSunday()
      const minPast = new Date(cs)
      minPast.setDate(minPast.getDate() - 100 * 7)
      await renameServiceInPast(
        collection.value,
        oldName,
        newName,
        formatDateString(minPast),
        formatDateString(cs),
      )
      // 同步已載入的 pastData 記憶體
      for (const row of pastData.value) {
        if (oldName in row) {
          row[newName] = cellOf(row, oldName)
          delete row[oldName]
        }
      }
      await syncUsersServeRename(oldName, newName)
    } catch (e) {
      if (!isTabLockError(e)) window.alert('更新服事項目失敗：' + errMsg(e))
      return
    }
    afterMutation()
    void refreshUsersBadge()
  }

  async function syncUsersServeRename(oldName: string, newName: string) {
    try {
      const q = query(
        fsCollection(db, 'users'),
        where(`serve_types.${collection.value}`, 'array-contains', oldName),
      )
      const snap = await getDocs(q)
      for (const d of snap.docs) {
        const data = d.data() as UserDoc
        const arr = data.serve_types?.[collection.value]
        if (!Array.isArray(arr)) continue
        await setDoc(doc(db, 'users', d.id), {
          ...data,
          serve_types: {
            ...data.serve_types,
            [collection.value]: arr.map((s) => (s === oldName ? newName : s)),
          },
        })
      }
    } catch (e) {
      console.warn('更新 users serve_types 失敗:', e)
    }
  }

  /** 服事標題拖拉排序 */
  async function reorderService(fromIndex: number, toIndex: number): Promise<void> {
    if (fromIndex === toIndex) return
    const moved = serviceItems.value.splice(fromIndex, 1)[0]
    serviceItems.value.splice(toIndex, 0, moved)
    try {
      await persistMetadata()
    } catch (e) {
      if (!isTabLockError(e)) window.alert('移動服事項目失敗：' + errMsg(e))
      return
    }
    afterMutation()
  }

  // ── 多格操作（剪下/清空/貼上）─────────────────────────
  async function clearCells(cells: { date: string; service: string }[]): Promise<void> {
    if (cells.length === 0) return
    const rowMap = new Map<string, ScheduleRow>()
    for (const { date, service } of cells) {
      const row = scheduleData.value.find((r) => r.date === date)
      if (!row) continue
      if (!rowMap.has(date)) rowMap.set(date, { ...row })
      ;(rowMap.get(date) as ScheduleRow)[service] = []
    }
    try {
      assertEditing()
      await bulkWrite({
        collection: collection.value,
        rowUpdates: [...rowMap.entries()].map(([date, data]) => ({ date, data })),
      })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('操作失敗：' + errMsg(e))
      return
    }
    for (const { date, service } of cells) {
      const row = scheduleData.value.find((r) => r.date === date)
      if (row) row[service] = []
    }
    afterMutation()
    void refreshUsersBadge()
  }

  /**
   * 貼上：以 (startDateIndex, startServiceIndex) 為左上角，把 parsedRows（tab 分隔的 cell）
   * 依 separator 拆人名後寫入。回傳 false 表示失敗。
   */
  async function executePaste(
    startDateIndex: number,
    startServiceIndex: number,
    parsedRows: string[][],
    separator: string,
  ): Promise<boolean> {
    const rowUpdates: { date: string; data: ScheduleRow }[] = []
    const commits: { rowIndex: number; service: string; names: string[] }[] = []
    const newPersons = new Set<string>()

    for (let i = 0; i < parsedRows.length && startDateIndex + i < scheduleData.value.length; i++) {
      const cells = parsedRows[i]
      const sourceRow = scheduleData.value[startDateIndex + i]
      const rowCopy: ScheduleRow = { ...sourceRow }
      for (let j = 0; j < cells.length && startServiceIndex + j < serviceItems.value.length; j++) {
        const service = serviceItems.value[startServiceIndex + j]
        const cellValue = cells[j].trim()
        let names: string[]
        if (cellValue === '') names = []
        else if (separator === '') names = [cellValue]
        else names = cellValue.split(separator).map((n) => n.trim()).filter(Boolean)
        if (names.some((n) => n.includes('|'))) {
          window.alert('匯入失敗：人員名稱不能包含 "|" 符號')
          return false
        }
        rowCopy[service] = names
        names.forEach((n) => newPersons.add(n))
        commits.push({ rowIndex: startDateIndex + i, service, names })
      }
      rowUpdates.push({ date: sourceRow.date, data: rowCopy })
    }

    try {
      assertEditing()
      await bulkWrite({ collection: collection.value, rowUpdates })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('匯入資料失敗：' + errMsg(e))
      return false
    }
    for (const { rowIndex, service, names } of commits) {
      const r = scheduleData.value[rowIndex]
      if (r) r[service] = names
    }
    newPersons.forEach(addPersonName)
    afterMutation()
    void refreshUsersBadge()
    return true
  }

  /**
   * 把某格設成指定陣列（AI 審核接受用）。batch=true 時延後 history/diff，
   * 由 commitAgentBatch() 一次結算。回傳 false 表示寫入失敗（含分頁鎖）。
   */
  async function addPersonsExact(
    date: string,
    service: string,
    newArr: string[],
    batch = false,
  ): Promise<boolean> {
    const row = scheduleData.value.find((r) => r.date === date)
    if (!row) return false
    try {
      assertEditing()
      await saveScheduleRow(collection.value, date, { ...row, [service]: newArr })
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return false
    }
    row[service] = [...newArr]
    newArr.forEach(addPersonName)
    if (!batch) {
      afterMutation('ai')
      void refreshUsersBadge()
    }
    return true
  }

  function commitAgentBatch() {
    afterMutation('ai')
    void refreshUsersBadge()
  }

  // ── 顯示分組設定 ──────────────────────────────────────
  async function saveDisplayConfig(next: DisplayConfig): Promise<boolean> {
    next.groups = next.groups.filter((g) => g.id === 'ungrouped' || g.items.length > 0)
    displayConfig.value = JSON.parse(JSON.stringify(next))
    try {
      await persistMetadata()
      return true
    } catch (e) {
      if (!isTabLockError(e)) window.alert('儲存失敗：' + errMsg(e))
      return false
    }
  }

  // ── AI agent 結構變更 ─────────────────────────────────
  async function applyAgentStructuralChanges(opts: {
    addWeeks?: number
    removeWeeks?: number
    addServiceColumns?: string[]
    removeServiceColumns?: string[]
  }): Promise<void> {
    const addWeeks = Math.max(0, Number(opts.addWeeks) || 0)
    const removeWeeks = Math.max(0, Number(opts.removeWeeks) || 0)
    const addCols = opts.addServiceColumns ?? []
    const removeCols = opts.removeServiceColumns ?? []
    if (!addWeeks && !removeWeeks && !addCols.length && !removeCols.length) return

    const removedDates: string[] = []
    const removable = Math.min(removeWeeks, scheduleData.value.length)
    for (let i = 0; i < removable; i++) {
      const removed = scheduleData.value.pop()
      if (removed?.date) removedDates.push(removed.date)
    }
    const addable = Math.min(addWeeks, Math.max(0, MAX_FUTURE_ROWS - scheduleData.value.length))
    for (let i = 0; i < addable; i++) {
      if (scheduleData.value.length === 0) break
      const last = scheduleData.value[scheduleData.value.length - 1].date
      const newDate = addDays(last, 7)
      const data: ScheduleRow = { date: newDate }
      for (const item of serviceItems.value) data[item] = []
      scheduleData.value.push(data)
    }
    for (const col of removeCols) {
      if (!serviceItems.value.includes(col)) continue
      const i = serviceItems.value.indexOf(col)
      if (i > -1) serviceItems.value.splice(i, 1)
      const n = nonUserColumns.value.indexOf(col)
      if (n > -1) nonUserColumns.value.splice(n, 1)
      removeFromDisplayConfig(col)
      for (const row of scheduleData.value) delete row[col]
    }
    for (const col of addCols) {
      if (!col || serviceItems.value.includes(col)) continue
      serviceItems.value.push(col)
      for (const row of scheduleData.value) row[col] = []
      const ung = displayConfig.value?.groups.find((g) => g.id === 'ungrouped')
      if (ung && !ung.items.includes(col)) ung.items.push(col)
    }

    try {
      assertEditing()
      await bulkWrite({
        collection: collection.value,
        rowUpdates: scheduleData.value.map((r) => ({ date: r.date, data: { ...r } })),
        rowDeletes: removedDates,
        metadata: metadataPayload(),
      })
    } catch (e) {
      if (isTabLockError(e)) return
      throw e
    }
    afterMutation()
    void refreshUsersBadge()
  }

  /** 建立尚不存在的空白週次（AI 生成週次用） */
  async function ensureWeeks(dates: string[]): Promise<void> {
    const existing = new Set(scheduleData.value.map((r) => r.date))
    const missing = dates.filter((d) => !existing.has(d)).sort()
    if (missing.length === 0) return
    for (const dateStr of missing) {
      const data: ScheduleRow = { date: dateStr }
      for (const item of serviceItems.value) data[item] = []
      assertEditing()
      await saveScheduleRow(collection.value, dateStr, { ...data })
      scheduleData.value.push(data)
    }
    scheduleData.value.sort((a, b) => a.date.localeCompare(b.date))
    afterMutation('ai')
  }

  // ── 撤銷/重做 ─────────────────────────────────────────
  function snapshot(): string {
    return JSON.stringify({
      scheduleData: scheduleData.value.map((row) => {
        const copy: ScheduleRow = { date: row.date }
        for (const s of serviceItems.value) copy[s] = [...cellOf(row, s)]
        return copy
      }),
      serviceItems: [...serviceItems.value],
      nonUserColumns: [...nonUserColumns.value],
      displayConfig: displayConfig.value ? JSON.parse(JSON.stringify(displayConfig.value)) : null,
    })
  }

  function initHistory() {
    historyStack.value = [snapshot()]
    historyIndex.value = 0
  }

  function pushHistory() {
    historyStack.value = historyStack.value.slice(0, historyIndex.value + 1)
    historyStack.value.push(snapshot())
    if (historyStack.value.length > MAX_HISTORY_SIZE) historyStack.value.shift()
    else historyIndex.value++
  }

  async function undo() {
    if (isRestoring || historyIndex.value <= 0) return
    historyIndex.value--
    await restoreFromHistory()
    status.value = '已撤銷'
  }

  async function redo() {
    if (isRestoring || historyIndex.value >= historyStack.value.length - 1) return
    historyIndex.value++
    await restoreFromHistory()
    status.value = '已重做'
  }

  async function restoreFromHistory() {
    isRestoring = true
    const state = JSON.parse(historyStack.value[historyIndex.value]) as HistorySnapshot
    const oldRowMap = new Map(scheduleData.value.map((r) => [r.date, JSON.stringify(r)]))
    const oldDates = new Set(scheduleData.value.map((r) => r.date))
    const oldMeta = JSON.stringify({
      serviceItems: serviceItems.value,
      nonUserColumns: nonUserColumns.value,
      displayConfig: displayConfig.value,
    })

    scheduleData.value = state.scheduleData
    serviceItems.value = state.serviceItems
    nonUserColumns.value = state.nonUserColumns || []
    displayConfig.value = state.displayConfig || null
    rebuildPersonNames()

    try {
      const newDates = new Set(scheduleData.value.map((r) => r.date))
      const rowDeletes = [...oldDates].filter((d) => !newDates.has(d))
      const rowUpdates = scheduleData.value
        .filter((row) => JSON.stringify(row) !== oldRowMap.get(row.date))
        .map((row) => ({ date: row.date, data: { ...row } }))
      const newMeta = JSON.stringify({
        serviceItems: serviceItems.value,
        nonUserColumns: nonUserColumns.value,
        displayConfig: displayConfig.value,
      })
      const metadata = newMeta !== oldMeta ? metadataPayload() : null
      if (rowUpdates.length || rowDeletes.length || metadata) {
        assertEditing()
        await bulkWrite({ collection: collection.value, rowUpdates, rowDeletes, metadata })
      }
    } catch (e) {
      if (!isTabLockError(e)) console.error('同步到 Firestore 失敗:', e)
    }

    isRestoring = false
    updateEditDifference(null)
    void refreshUsersBadge()
  }

  // ── 編輯記錄 ──────────────────────────────────────────
  function snapshotOriginal() {
    if (!originalChart || Object.keys(originalChart).length === 0) originalChart = {}
    for (const row of scheduleData.value) {
      if (!originalChart[row.date]) originalChart[row.date] = {}
      for (const service of serviceItems.value) {
        if (!(service in originalChart[row.date])) originalChart[row.date][service] = [...cellOf(row, service)]
      }
    }
  }

  /** 每次成功變更後呼叫：推歷史 + 算差異 */
  function afterMutation(source: string = 'admin') {
    pushHistory()
    updateEditDifference(source)
  }

  function updateEditDifference(source: string | null = 'admin') {
    if (source !== null) sources.add(source)
    const currentDates = new Set(scheduleData.value.map((r) => r.date))

    for (const row of scheduleData.value) {
      const orig = originalChart[row.date]
      if (!orig) continue
      if (editDifference[row.date] && (editDifference[row.date] as Record<string, unknown>)._deleted) {
        delete (editDifference[row.date] as Record<string, unknown>)._deleted
      }
      for (const service of serviceItems.value) {
        const o = orig[service] || []
        const c = cellOf(row, service)
        if (JSON.stringify(o) !== JSON.stringify(c)) {
          if (!editDifference[row.date]) editDifference[row.date] = {}
          editDifference[row.date][service] = { old: [...o], new: [...c] }
        } else if (editDifference[row.date]?.[service]) {
          delete editDifference[row.date][service]
          if (Object.keys(editDifference[row.date]).length === 0) delete editDifference[row.date]
        }
      }
    }

    for (const date of Object.keys(originalChart)) {
      if (currentDates.has(date)) continue
      const orig = originalChart[date]
      const had = serviceItems.value.some((s) => (orig[s] || []).length > 0)
      if (had) {
        if (!editDifference[date]) editDifference[date] = {}
        for (const service of serviceItems.value) {
          const o = orig[service] || []
          if (o.length > 0) editDifference[date][service] = { old: [...o], new: [] }
        }
        ;(editDifference[date] as Record<string, unknown>)._deleted = true
      } else if (editDifference[date]) {
        delete editDifference[date]
      }
    }

    hasEdited = Object.keys(editDifference).length > 0
    if (hasEdited) {
      if (saveDebounce) clearTimeout(saveDebounce)
      saveDebounce = setTimeout(() => {
        saveDebounce = null
        void saveEditLog()
      }, 1500)
    } else {
      if (saveDebounce) {
        clearTimeout(saveDebounce)
        saveDebounce = null
      }
      sources.clear()
      void deleteEditLog()
    }
  }

  async function saveEditLog(): Promise<void> {
    if (!hasEdited) return
    const lastEdited = formatTimestampId()
    let finalSource = 'admin'
    if (sources.has('admin') && (sources.has('ai') || sources.has('ai-assistant'))) finalSource = 'admin+ai'
    else if (sources.has('ai') || sources.has('ai-assistant')) finalSource = 'ai'
    else if (sources.has('linebot')) finalSource = 'linebot'
    try {
      await setDoc(doc(db, '_edit_chart_log', sessionStartTime), {
        'serve-id': collection.value,
        source: finalSource,
        difference: editDifference,
        'last-edited-time': lastEdited,
      })
      logWasWritten = true
    } catch (e) {
      console.error('儲存編輯記錄失敗:', e)
    }
  }

  async function deleteEditLog(): Promise<void> {
    if (!logWasWritten) return
    logWasWritten = false
    try {
      await deleteDoc(doc(db, '_edit_chart_log', sessionStartTime))
    } catch (e) {
      console.error('刪除編輯記錄失敗:', e)
    }
  }

  /** 離開頁面前 flush */
  function flushOnLeave() {
    if (hasEdited) void saveEditLog()
  }

  // ── 使用者警示 badge ──────────────────────────────────
  async function refreshUsersBadge() {
    try {
      if (Object.keys(usersCache).length === 0) usersCache = await loadAllUsers()
      userAlert.value = evaluateMissingUsers(usersCache)
    } catch (e) {
      console.error('檢查未註冊使用者失敗:', e)
    }
  }

  function evaluateMissingUsers(users: Record<string, UserDoc>): boolean {
    const userItems = serviceItems.value.filter((i) => !nonUserColumns.value.includes(i))
    const personServes: Record<string, Set<string>> = {}
    for (const row of scheduleData.value) {
      for (const item of userItems) {
        for (const name of cellOf(row, item)) (personServes[name] ??= new Set()).add(item)
      }
    }
    for (const name of Object.keys(personServes)) {
      const u = users[name]
      if (!u) return true
      const registered = u.serve_types?.[collection.value] || []
      for (const serve of personServes[name]) if (!registered.includes(serve)) return true
    }
    return false
  }

  // ── 匯出 Excel ────────────────────────────────────────
  function exportExcel(titleName: string) {
    const rows: string[][] = [['日期', ...serviceItems.value]]
    const data = showingPast.value && pastData.value.length > 0
      ? [...pastData.value, ...scheduleData.value]
      : scheduleData.value
    for (const row of data) {
      rows.push([
        row.date.replace(/\./g, '/'),
        ...serviceItems.value.map((s) => cellOf(row, s).join('/')),
      ])
    }
    const ws = XLSX.utils.aoa_to_sheet(rows)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, '班表')
    const dateStr = new Date().toISOString().split('T')[0]
    XLSX.writeFile(wb, `${titleName}_${dateStr}.xlsx`)
  }

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e)
  }

  return {
    // state
    collection, scheduleData, pastData, pastDataLoaded, showingPast,
    serviceItems, nonUserColumns, displayConfig, status, isLocked, userAlert,
    // computed
    personColorMap, canUndo, canRedo, allPersonNames,
    sessionStartTime: () => sessionStartTime,
    // lock
    initTabLock, reclaimTabLock, assertEditing, isTabLockError,
    // load
    load, loadPast, togglePast,
    // person CRUD
    getPersonColor, addPersonToCell, removePerson, movePerson,
    // info CRUD
    addInfoItem, updateInfoItem, removeInfoItem,
    // rows / columns
    addRow, deleteLastRow, doAddColumn, deleteServiceItem, renameService, reorderService,
    // multi-cell
    clearCells, executePaste,
    // display config
    saveDisplayConfig,
    // agent
    applyAgentStructuralChanges, ensureWeeks, addPersonsExact, commitAgentBatch,
    // history
    undo, redo, pushHistory,
    // edit log
    updateEditDifference, saveEditLog, flushOnLeave,
    // misc
    refreshUsersBadge, exportExcel,
  }
})
