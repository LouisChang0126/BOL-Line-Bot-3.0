/**
 * 多格矩形選取（移植自舊版 app.js 的 multi-cell selection）。
 * 長按 150ms 開始 → 滑過延伸 → 放開結束；支援 Ctrl+C 複製 / Ctrl+X 剪下 / Delete 清空。
 * 選取以 (dateIndex, serviceIndex) 計算矩形範圍，套用 Excel 風格外框。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { cellOf } from '@/utils/schedule'

export const INTERNAL_COPY_MARKER = '​​​'
const LONG_PRESS_MS = 150

type EditorStore = ReturnType<typeof useEditorStore>

export function useMultiSelect(editor: EditorStore) {
  const selectedKeys = ref<Set<string>>(new Set())
  const isSelecting = ref(false)
  const justSelected = ref(false)
  let anchor: { dateIndex: number; serviceIndex: number } | null = null
  let longPressTimer: ReturnType<typeof setTimeout> | null = null

  const count = computed(() => selectedKeys.value.size)

  function indicesOf(date: string, service: string) {
    return {
      dateIndex: editor.scheduleData.findIndex((r) => r.date === date),
      serviceIndex: editor.serviceItems.indexOf(service),
    }
  }

  function rectKeys(a: { dateIndex: number; serviceIndex: number }, b: { dateIndex: number; serviceIndex: number }) {
    const keys = new Set<string>()
    const minR = Math.min(a.dateIndex, b.dateIndex)
    const maxR = Math.max(a.dateIndex, b.dateIndex)
    const minC = Math.min(a.serviceIndex, b.serviceIndex)
    const maxC = Math.max(a.serviceIndex, b.serviceIndex)
    for (let r = minR; r <= maxR; r++) {
      for (let c = minC; c <= maxC; c++) {
        const row = editor.scheduleData[r]
        const service = editor.serviceItems[c]
        if (row && service) keys.add(`${row.date}|${service}`)
      }
    }
    return keys
  }

  /** 選取範圍的格子座標邊界（給外框用） */
  const bounds = computed(() => {
    let minR = Infinity
    let maxR = -Infinity
    let minC = Infinity
    let maxC = -Infinity
    for (const key of selectedKeys.value) {
      const [date, service] = key.split('|')
      const { dateIndex, serviceIndex } = indicesOf(date, service)
      if (dateIndex < 0 || serviceIndex < 0) continue
      minR = Math.min(minR, dateIndex)
      maxR = Math.max(maxR, dateIndex)
      minC = Math.min(minC, serviceIndex)
      maxC = Math.max(maxC, serviceIndex)
    }
    return { minR, maxR, minC, maxC }
  })

  function isSelected(date: string, service: string): boolean {
    return selectedKeys.value.has(`${date}|${service}`)
  }

  function borderClasses(date: string, service: string): Record<string, boolean> {
    if (!isSelected(date, service)) return {}
    const { dateIndex, serviceIndex } = indicesOf(date, service)
    const b = bounds.value
    return {
      'multi-selected': true,
      'ms-top': dateIndex === b.minR,
      'ms-bottom': dateIndex === b.maxR,
      'ms-left': serviceIndex === b.minC,
      'ms-right': serviceIndex === b.maxC,
    }
  }

  // ── 長按 / 拖選 ───────────────────────────────────────
  function beginLongPress(date: string, service: string, e: MouseEvent) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('.person-chip')) return
    const idx = indicesOf(date, service)
    if (idx.dateIndex < 0 || idx.serviceIndex < 0) return
    justSelected.value = false
    longPressTimer = setTimeout(() => {
      isSelecting.value = true
      anchor = idx
      justSelected.value = true
      selectedKeys.value = rectKeys(idx, idx)
    }, LONG_PRESS_MS)
  }

  function extendTo(date: string, service: string) {
    if (!isSelecting.value || !anchor) return
    const idx = indicesOf(date, service)
    if (idx.dateIndex < 0 || idx.serviceIndex < 0) return
    selectedKeys.value = rectKeys(anchor, idx)
  }

  function clear() {
    selectedKeys.value = new Set()
    anchor = null
  }

  /** 點擊時呼叫；若剛完成選取則吞掉這次點擊（不開啟編輯） */
  function consumeClick(): boolean {
    if (justSelected.value) {
      justSelected.value = false
      return true
    }
    if (selectedKeys.value.size > 0) {
      clear()
      return false
    }
    return false
  }

  // ── 內容 / 複製剪下清空 ───────────────────────────────
  function selectedCells(): { date: string; service: string }[] {
    return [...selectedKeys.value].map((k) => {
      const [date, service] = k.split('|')
      return { date, service }
    })
  }

  function getContent(): string {
    const rows = [...new Set(selectedCells().map((c) => indicesOf(c.date, c.service).dateIndex))].sort((a, b) => a - b)
    const cols = [...new Set(selectedCells().map((c) => indicesOf(c.date, c.service).serviceIndex))].sort((a, b) => a - b)
    return rows
      .map((r) =>
        cols
          .map((c) => {
            const row = editor.scheduleData[r]
            const service = editor.serviceItems[c]
            return row && service ? cellOf(row, service).join('/') : ''
          })
          .join('\t'),
      )
      .join('\n')
  }

  async function copy() {
    const content = getContent()
    if (!content) return
    try {
      await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + content)
      editor.status = '已複製選取的格子'
    } catch {
      window.alert('無法寫入剪貼簿')
    }
  }

  async function cut() {
    const content = getContent()
    if (!content) return
    try {
      await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + content)
    } catch {
      window.alert('無法寫入剪貼簿')
      return
    }
    await editor.clearCells(selectedCells())
    clear()
    editor.status = '已剪下選取的格子'
  }

  async function remove() {
    if (selectedKeys.value.size === 0) return
    await editor.clearCells(selectedCells())
    clear()
    editor.status = '已清空選取的格子'
  }

  // ── 全域事件 ──────────────────────────────────────────
  function onMouseUp() {
    if (longPressTimer) {
      clearTimeout(longPressTimer)
      longPressTimer = null
    }
    if (!isSelecting.value) return
    isSelecting.value = false
    if (selectedKeys.value.size <= 1) clear()
  }

  function onDocMouseDown(e: MouseEvent) {
    const t = e.target as HTMLElement
    if (!t.closest('.service-cell') && !t.closest('.context-menu')) clear()
  }

  function onKeydown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    if (e.key === 'Escape') {
      clear()
      return
    }
    if (selectedKeys.value.size === 0) return
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      e.preventDefault()
      void copy()
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'x') {
      e.preventDefault()
      void cut()
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      void remove()
    }
  }

  onMounted(() => {
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onKeydown)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('mouseup', onMouseUp)
    document.removeEventListener('mousedown', onDocMouseDown)
    document.removeEventListener('keydown', onKeydown)
    if (longPressTimer) clearTimeout(longPressTimer)
  })

  return {
    selectedKeys, isSelecting, count,
    beginLongPress, extendTo, clear, consumeClick,
    isSelected, borderClasses, selectedCells,
    copy, cut, remove,
  }
}
