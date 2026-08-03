<script setup lang="ts">
/**
 * 班表表格（取代舊版 ui.js 的 renderTable / renderTableBody / renderTableHead）。
 * 反應式渲染：直接綁定 editor store 的 scheduleData。
 * 功能：服事標題拖拉排序 + 點擊編輯；人名積木拖拉移動；格子「就地編輯」（不再開 modal）；
 *      AI 待審核差異高亮 + 逐格 Accept/Reject；新增/刪除一週；右鍵 複製/剪下/貼上。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useAgentStore } from '@/stores/agent'
import { useMultiSelect, INTERNAL_COPY_MARKER } from '@/composables/editor/useMultiSelect'
import { cellOf, sortPersonCandidates } from '@/utils/schedule'
import { formatDisplayDate } from '@/utils/dates'
import type { PendingCellChange, ScheduleRow } from '@/types'
import PastePreviewModal from './PastePreviewModal.vue'

const editor = useEditorStore()
const agent = useAgentStore()
const ms = useMultiSelect(editor)

const emit = defineEmits<{
  editService: [name: string]
}>()

interface RenderRow {
  row: ScheduleRow
  isPast: boolean
}
const renderRows = computed<RenderRow[]>(() => {
  const out: RenderRow[] = []
  if (editor.showingPast) for (const row of editor.pastData) out.push({ row, isPast: true })
  for (const row of editor.scheduleData) out.push({ row, isPast: false })
  return out
})

// ── 待審核差異 ────────────────────────────────────────
function pendingOf(date: string, service: string): PendingCellChange | null {
  return agent.pendingChanges?.[date]?.[service] ?? null
}
function pendingPersons(change: PendingCellChange): { name: string; removed: boolean }[] {
  const all = Array.from(new Set([...(change.old || []), ...(change.new || [])]))
  return all.map((name) => ({ name, removed: change.old.includes(name) && !change.new.includes(name) }))
}

// ── 服事標題拖拉排序 ──────────────────────────────────
const draggedHeaderIndex = ref<number | null>(null)
function onHeaderDragStart(index: number, e: DragEvent) {
  draggedHeaderIndex.value = index
  e.dataTransfer && (e.dataTransfer.effectAllowed = 'move')
}
function onHeaderDrop(targetIndex: number) {
  if (draggedHeaderIndex.value === null) return
  const from = draggedHeaderIndex.value
  draggedHeaderIndex.value = null
  if (from !== targetIndex) void editor.reorderService(from, targetIndex)
}

// ── 人名積木拖拉 ──────────────────────────────────────
const dragData = ref<{ date: string; service: string; person: string } | null>(null)
function onChipDragStart(date: string, service: string, person: string, e: DragEvent) {
  dragData.value = { date, service, person }
  e.dataTransfer && (e.dataTransfer.effectAllowed = 'move')
}
function onCellDrop(date: string, service: string) {
  const d = dragData.value
  dragData.value = null
  if (!d) return
  if (d.date === date && d.service === service) return
  void editor.movePerson(d.date, d.service, date, service, d.person)
}

// ── 就地編輯（取代舊的 editPersonModal）────────────────
/** 目前正在就地編輯的格子；null = 沒有 */
const editing = ref<{ date: string; service: string } | null>(null)
/** 空白積木的輸入內容 */
const draft = ref('')
/**
 * 空白積木的 input。因為它位在 v-for 內（Vue 3 的 ref 會變成陣列），
 * 這裡改用 function ref，且只在元素掛載時賦值（卸載時傳入 null 直接忽略）。
 */
const draftInput = ref<HTMLInputElement | null>(null)
function setDraftInput(el: unknown) {
  if (el) draftInput.value = el as HTMLInputElement
}

function isEditing(date: string, service: string): boolean {
  return editing.value?.date === date && editing.value?.service === service
}

function isInfoColumn(service: string): boolean {
  return editor.nonUserColumns.includes(service)
}

/**
 * 空白積木寬度：服事欄預設 2 個中文字、資訊欄預設 8 個中文字，
 * 再乘上 1.4 倍係數；輸入變長時一併放大。
 */
const DRAFT_WIDTH_SCALE = 1.4
function draftWidth(service: string): string {
  const base = isInfoColumn(service) ? 8 : 2
  return `${Math.max(base, draft.value.length) * DRAFT_WIDTH_SCALE}em`
}

// ── 人員選單浮層（獨立疊在表格上，不再塞在格子裡）──────
/** 編輯中格子的 td 元素，用來定位浮層 */
let anchorEl: HTMLElement | null = null
/** 浮層位置（fixed 座標），null = 不顯示 */
const anchorRect = ref<{ left: number; top: number; width: number } | null>(null)

const POPOVER_MAX_W = 320
const POPOVER_MAX_H = 220

function updateAnchorRect() {
  if (!anchorEl || !anchorEl.isConnected) {
    anchorRect.value = null
    return
  }
  const r = anchorEl.getBoundingClientRect()
  // 靠右 / 靠下時往回收，避免超出視窗
  const width = Math.max(r.width, 160)
  const left = Math.min(r.left, window.innerWidth - Math.min(width, POPOVER_MAX_W) - 8)
  const spaceBelow = window.innerHeight - r.bottom
  const top = spaceBelow < POPOVER_MAX_H ? Math.max(8, r.top - POPOVER_MAX_H - 4) : r.bottom + 4
  anchorRect.value = { left: Math.max(8, left), top, width }
}

const popoverStyle = computed(() => {
  const a = anchorRect.value
  if (!a) return {}
  return {
    left: `${a.left}px`,
    top: `${a.top}px`,
    minWidth: `${Math.min(a.width, POPOVER_MAX_W)}px`,
    maxWidth: `${POPOVER_MAX_W}px`,
    maxHeight: `${POPOVER_MAX_H}px`,
  }
})

/** 目前是否要顯示人員選單浮層（資訊欄沒有選單） */
const showPicker = computed(
  () => !!editing.value && !isInfoColumn(editing.value.service) && !!anchorRect.value,
)

function openEditor(date: string, service: string, cell: HTMLElement | null) {
  closeCtx()
  editing.value = { date, service }
  draft.value = ''
  anchorEl = cell
  void nextTick(() => {
    draftInput.value?.focus()
    updateAnchorRect()
  })
}

function closeEditor() {
  editing.value = null
  draft.value = ''
  anchorEl = null
  anchorRect.value = null
}

function onCellClick(date: string, service: string, e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.person-chip')) return
  if (pendingOf(date, service)) return
  if (ms.consumeClick()) return // 剛完成多格選取 → 不開啟編輯
  if (isEditing(date, service)) return
  openEditor(date, service, e.currentTarget as HTMLElement)
}

/** 在此服事「有經驗」的人（本格以外的其他列出現過） */
function veteransOf(date: string, service: string): Set<string> {
  const set = new Set<string>()
  for (const r of editor.scheduleData) {
    if (r.date === date) continue
    for (const n of cellOf(r, service)) set.add(n)
  }
  return set
}

/**
 * 可點選加入的人員：所有人名扣掉本格已有的，
 * 依「跟輸入有關 → 其他週做過同服事 → 其他」排序（見 sortPersonCandidates）。
 */
function availableFor(date: string, service: string): string[] {
  const row = editor.scheduleData.find((r) => r.date === date)
  const cur = new Set(cellOf(row, service))
  return sortPersonCandidates(
    [...editor.allPersonNames].filter((n) => !cur.has(n)),
    { query: draft.value, veterans: veteransOf(date, service) },
  )
}

/** 送出空白積木的內容：服事欄 → 加人員；資訊欄 → 加一則資訊 */
async function submitDraft(date: string, service: string) {
  const value = draft.value.trim()
  if (!value) return
  if (isInfoColumn(service)) {
    await editor.addInfoItem(date, service, value)
    draft.value = ''
    return
  }
  if (value.includes('|')) {
    window.alert('姓名不能包含 "|" 符號')
    return
  }
  const ok = await editor.addPersonToCell(date, service, value)
  if (ok) draft.value = ''
  void nextTick(updateAnchorRect)
}

async function pickPerson(date: string, service: string, name: string) {
  await editor.addPersonToCell(date, service, name)
  draftInput.value?.focus()
  // 格子變高後浮層要重新貼齊
  void nextTick(updateAnchorRect)
}

/** 移除格內既有項目（資訊欄用 index，服事欄用人名） */
async function removeAt(date: string, service: string, name: string, index: number) {
  if (isInfoColumn(service)) await editor.removeInfoItem(date, service, index)
  else await editor.removePerson(date, service, name)
  void nextTick(updateAnchorRect)
}

// 點到編輯器以外的地方就關閉（編輯器內的 mousedown 已 .stop，不會觸發這裡）。
// 關閉前先把還沒送出的輸入寫進去，避免使用者打完字直接點別處而遺失。
async function onDocMouseDown() {
  const cur = editing.value
  if (!cur) return
  if (draft.value.trim()) await submitDraft(cur.date, cur.service)
  closeEditor()
}
// 表格捲動 / 視窗縮放時，浮層要跟著編輯中的格子移動（capture 才收得到內層捲動）
function onViewportChange() {
  if (editing.value) updateAnchorRect()
}

onMounted(() => {
  document.addEventListener('mousedown', onDocMouseDown)
  window.addEventListener('scroll', onViewportChange, true)
  window.addEventListener('resize', onViewportChange)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
})

// ── 右鍵選單（單格 複製/剪下/貼上）────────────────────
const ctx = reactive({ visible: false, x: 0, y: 0, date: '', service: '', dateIndex: -1, serviceIndex: -1, multi: false })
function onCellContextMenu(date: string, service: string, e: MouseEvent) {
  const dateIndex = editor.scheduleData.findIndex((r) => r.date === date)
  const serviceIndex = editor.serviceItems.indexOf(service)
  if (dateIndex < 0 || serviceIndex < 0) return
  // 右鍵點在已選取的多格上 → 操作整個選取；否則清除選取、改單格
  const multi = ms.count.value > 1 && ms.isSelected(date, service)
  if (!multi) ms.clear()
  Object.assign(ctx, { visible: true, x: e.clientX, y: e.clientY, date, service, dateIndex, serviceIndex, multi })
}
function closeCtx() {
  ctx.visible = false
}
async function copyCell() {
  closeCtx()
  if (ctx.multi) return ms.copy()
  const row = editor.scheduleData[ctx.dateIndex]
  await writeClipboard(INTERNAL_COPY_MARKER + cellOf(row, ctx.service).join('/'))
  editor.status = '已複製格子內容'
}
async function cutCell() {
  closeCtx()
  if (ctx.multi) return ms.cut()
  const row = editor.scheduleData[ctx.dateIndex]
  await writeClipboard(INTERNAL_COPY_MARKER + cellOf(row, ctx.service).join('/'))
  await editor.clearCells([{ date: ctx.date, service: ctx.service }])
  editor.status = '已剪下格子內容'
}
async function pasteCell() {
  const { dateIndex, serviceIndex } = ctx
  closeCtx()
  let text = ''
  try {
    text = await navigator.clipboard.readText()
  } catch {
    window.alert('無法讀取剪貼簿，請確認已授予剪貼簿權限')
    return
  }
  if (!text) {
    window.alert('剪貼簿中沒有資料')
    return
  }
  if (text.startsWith(INTERNAL_COPY_MARKER)) {
    const clean = text.slice(INTERNAL_COPY_MARKER.length)
    const parsed = clean.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === '')).map((r) => r.split('\t'))
    await editor.executePaste(dateIndex, serviceIndex, parsed, '/')
  } else {
    paste.open = true
    paste.startDateIndex = dateIndex
    paste.startServiceIndex = serviceIndex
    paste.rawData = text
  }
}

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch (e) {
    console.error('複製失敗:', e)
    window.alert('無法寫入剪貼簿')
  }
}

// ── 貼上預覽 modal ────────────────────────────────────
const paste = reactive({ open: false, startDateIndex: -1, startServiceIndex: -1, rawData: '' })
</script>

<template>
  <div class="table-container" @click="closeCtx">
    <div class="table-scroll" style="overflow-x: auto">
      <table class="schedule-table" id="scheduleTable">
        <thead>
          <tr>
            <th class="date-header">日期</th>
            <th
              v-for="(item, index) in editor.serviceItems"
              :key="item"
              class="service-header"
              draggable="true"
              @dragstart="onHeaderDragStart(index, $event)"
              @dragover.prevent
              @drop="onHeaderDrop(index)"
            >
              <span class="service-header-text service-header-editable" @click.stop="emit('editService', item)">
                {{ item }}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="{ row, isPast } in renderRows" :key="row.date" :style="isPast ? 'opacity:0.6;background:#f8fafc' : ''">
            <td>
              <div class="date-cell" style="cursor: default">{{ formatDisplayDate(row.date) }}</div>
            </td>

            <!-- 過去資料：唯讀 -->
            <template v-if="isPast">
              <td
                v-for="item in editor.serviceItems"
                :key="item"
                class="service-cell"
                :class="{ empty: cellOf(row, item).length === 0 }"
                style="cursor: default"
              >
                <div v-if="cellOf(row, item).length" class="person-chips">
                  <div
                    v-for="p in cellOf(row, item)"
                    :key="p"
                    class="person-chip"
                    :style="{ background: editor.getPersonColor(p), cursor: 'default' }"
                  >
                    {{ p }}
                  </div>
                </div>
              </td>
            </template>

            <!-- 未來資料：可編輯 -->
            <template v-else>
              <td
                v-for="item in editor.serviceItems"
                :key="item"
                class="service-cell"
                :class="[
                  { empty: cellOf(row, item).length === 0 && !pendingOf(row.date, item), 'pending-modify': !!pendingOf(row.date, item) },
                  ms.borderClasses(row.date, item),
                ]"
                :data-date="row.date"
                :data-service="item"
                @click="onCellClick(row.date, item, $event)"
                @contextmenu.prevent="onCellContextMenu(row.date, item, $event)"
                @mousedown="ms.beginLongPress(row.date, item, $event)"
                @mouseover="ms.extendTo(row.date, item)"
                @dragover.prevent
                @drop="onCellDrop(row.date, item)"
              >
                <!-- 待審核差異 -->
                <template v-if="pendingOf(row.date, item)">
                  <div class="person-chips">
                    <div
                      v-for="pp in pendingPersons(pendingOf(row.date, item)!)"
                      :key="pp.name"
                      class="person-chip"
                      :style="pp.removed
                        ? { background: '#9ca3af', textDecoration: 'line-through', opacity: 0.9 }
                        : { background: editor.getPersonColor(pp.name) }"
                    >
                      {{ pp.name }}
                    </div>
                  </div>
                  <div class="cell-review-btns">
                    <button class="cell-review-btn accept" @click.stop="agent.acceptCell(row.date, item)">✓</button>
                    <button class="cell-review-btn reject" @click.stop="agent.rejectCell(row.date, item)">✕</button>
                  </div>
                </template>

                <!-- 就地編輯中 -->
                <template v-else-if="isEditing(row.date, item)">
                  <div class="cell-inline-editor" @mousedown.stop @click.stop>
                    <div class="person-chips">
                      <div
                        v-for="(p, pi) in cellOf(row, item)"
                        :key="p + pi"
                        class="person-chip"
                        :style="{ background: editor.getPersonColor(p), cursor: 'default' }"
                      >
                        {{ p }}
                        <button class="remove-btn" @click="removeAt(row.date, item, p, pi)">×</button>
                      </div>

                      <!-- 可打字的空白積木 -->
                      <div class="person-chip person-chip-blank">
                        <input
                          :ref="setDraftInput"
                          v-model="draft"
                          class="person-chip-blank-input"
                          :style="{ width: draftWidth(item) }"
                          :placeholder="isInfoColumn(item) ? '輸入資訊…' : ''"
                          @keyup.enter="submitDraft(row.date, item)"
                          @keyup.esc="closeEditor"
                          @blur="submitDraft(row.date, item)"
                        />
                      </div>
                    </div>
                  </div>
                </template>

                <!-- 一般 -->
                <template v-else>
                  <div v-if="cellOf(row, item).length === 0" class="add-person-placeholder">＋</div>
                  <div v-else class="person-chips">
                    <div
                      v-for="p in cellOf(row, item)"
                      :key="p"
                      class="person-chip"
                      draggable="true"
                      :style="{ background: editor.getPersonColor(p) }"
                      @dragstart="onChipDragStart(row.date, item, p, $event)"
                    >
                      {{ p }}
                    </div>
                  </div>
                </template>
              </td>
            </template>
          </tr>

          <!-- 操作列 -->
          <tr class="table-action-row">
            <td :colspan="editor.serviceItems.length + 1">
              <div class="table-action-buttons">
                <button class="btn btn-primary" @click="editor.addRow()">➕ 新增一週</button>
                <button class="btn btn-danger" @click="editor.deleteLastRow()">➖ 刪除最後一週</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 人員選單浮層：獨立疊在表格上，不受格子寬度限制 -->
    <div
      v-if="showPicker && editing"
      class="person-chips-select cell-chips-popover"
      :style="popoverStyle"
      @mousedown.stop
      @click.stop
    >
      <div
        v-for="name in availableFor(editing.date, editing.service)"
        :key="name"
        class="person-chip-selectable"
        :style="{ background: editor.getPersonColor(name) }"
        @click="pickPerson(editing.date, editing.service, name)"
      >
        {{ name }}
      </div>
      <div v-if="availableFor(editing.date, editing.service).length === 0" class="picker-empty">
        無可用人員，請直接輸入
      </div>
    </div>

    <!-- 右鍵選單 -->
    <div v-if="ctx.visible" class="context-menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }" @click.stop>
      <div class="context-menu-item" @click="copyCell">📄 複製</div>
      <div class="context-menu-item" @click="cutCell">✂️ 剪下</div>
      <div class="context-menu-item" @click="pasteCell">📋 從此格貼上</div>
    </div>

    <PastePreviewModal
      v-model="paste.open"
      :start-date-index="paste.startDateIndex"
      :start-service-index="paste.startServiceIndex"
      :raw-data="paste.rawData"
    />
  </div>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 1000;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  min-width: 140px;
}
.context-menu-item {
  padding: 8px 12px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}
.context-menu-item:hover {
  background: var(--bg-hover);
}
.cell-review-btns {
  display: flex;
  gap: 4px;
  justify-content: center;
  margin-top: 4px;
}
.cell-review-btn {
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  font-size: 12px;
  color: #fff;
}
.cell-review-btn.accept {
  background: #16a34a;
}
.cell-review-btn.reject {
  background: #dc2626;
}
.pending-modify {
  background: #fffbeb;
}
.service-cell {
  user-select: none;
}

/* ── 就地編輯 ────────────────────────────────────────── */
.cell-inline-editor {
  user-select: text;
  min-width: 120px;
}

/* 可打字的空白積木：外觀同 person-chip，但用虛線框表示待輸入 */
.person-chip.person-chip-blank {
  background: #fff !important;
  border: 2px dashed var(--border-color);
  box-shadow: none;
  padding: 2px 6px;
  cursor: text;
}
.person-chip.person-chip-blank:hover {
  transform: none;
  box-shadow: none;
}
.cell-inline-editor .person-chip-blank:focus-within {
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}
.person-chip-blank-input {
  border: none;
  outline: none;
  background: transparent;
  padding: 0 2px;
  font-family: inherit;
  font-size: 15px;
  color: var(--text-primary);
}

/* 人員選單浮層：fixed 疊在表格之上，不受格子寬度 / 表格捲動裁切影響 */
.cell-chips-popover {
  position: fixed;
  z-index: 900;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 8px;
  overflow-y: auto;
  margin-bottom: 0;
  user-select: none;
}
.cell-chips-popover .person-chip-selectable {
  padding: 2px 7px;
  font-size: 13px;
}
.picker-empty {
  color: var(--text-light);
  font-size: 13px;
  padding: 2px 4px;
}
.service-cell.multi-selected {
  background: rgba(255, 90, 95, 0.08);
}
.service-cell.ms-top {
  border-top: 2px solid var(--primary-color);
}
.service-cell.ms-bottom {
  border-bottom: 2px solid var(--primary-color);
}
.service-cell.ms-left {
  border-left: 2px solid var(--primary-color);
}
.service-cell.ms-right {
  border-right: 2px solid var(--primary-color);
}
</style>
