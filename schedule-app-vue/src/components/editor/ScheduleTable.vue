<script setup lang="ts">
/**
 * 班表表格（取代舊版 ui.js 的 renderTable / renderTableBody / renderTableHead）。
 * 反應式渲染：直接綁定 editor store 的 scheduleData。
 * 功能：服事標題拖拉排序 + 點擊編輯；人名積木拖拉移動；空格點擊編輯；
 *      AI 待審核差異高亮 + 逐格 Accept/Reject；新增/刪除一週；右鍵 複製/剪下/貼上。
 */
import { computed, reactive, ref } from 'vue'
import { useEditorStore } from '@/stores/editor'
import { useAgentStore } from '@/stores/agent'
import { useMultiSelect, INTERNAL_COPY_MARKER } from '@/composables/editor/useMultiSelect'
import { cellOf } from '@/utils/schedule'
import { formatDisplayDate } from '@/utils/dates'
import type { PendingCellChange, ScheduleRow } from '@/types'
import PastePreviewModal from './PastePreviewModal.vue'

const editor = useEditorStore()
const agent = useAgentStore()
const ms = useMultiSelect(editor)

const emit = defineEmits<{
  editPerson: [date: string, service: string]
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

// ── 點擊編輯 ──────────────────────────────────────────
function onCellClick(date: string, service: string, e: MouseEvent) {
  if ((e.target as HTMLElement).closest('.person-chip')) return
  if (pendingOf(date, service)) return
  if (ms.consumeClick()) return // 剛完成多格選取 → 不開啟編輯
  emit('editPerson', date, service)
}

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
