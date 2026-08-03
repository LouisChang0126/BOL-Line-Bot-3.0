<script setup lang="ts">
/**
 * 編輯顯示欄位 / 分組（對應舊版 displayConfigModal）：拖拉服事到群組或隱藏區。
 *
 * DOM 結構與 class 刻意與舊版 edit-chart.html / ui.js 一致
 * （display-config-groups / group-container / group-items / draggable-service /
 *  hidden-zone / drag-insert-indicator），直接沿用 main.css 既有樣式。
 */
import { ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'
import type { DisplayConfig } from '@/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()
const temp = ref<DisplayConfig>({ groups: [], hidden: [] })
const busy = ref(false)

/** 正在被拖曳的服事名稱 */
const dragged = ref<string | null>(null)
/** 目前落點：container 為群組 id 或 'hidden'；before 為要插在哪個項目之前（null = 插在最後） */
const dropTarget = ref<{ container: string; before: string | null } | null>(null)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) {
      dragged.value = null
      dropTarget.value = null
      return
    }
    const dc = editor.displayConfig
    temp.value = dc
      ? JSON.parse(JSON.stringify(dc))
      : {
          groups: [
            { id: 'ungrouped', name: '未分組', items: [...editor.serviceItems], defaultVisible: true },
          ],
          hidden: [],
        }
  },
)

// ── 拖拉 ──────────────────────────────────────────────
function onDragStart(service: string, e: DragEvent) {
  dragged.value = service
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() {
  dragged.value = null
  dropTarget.value = null
}

/**
 * 依游標位置決定插入點 —— 與舊版 handleDragOver 相同的演算法：
 * 只考慮中心點在游標右側的項目，取「水平距離 + 垂直距離 × 0.5」最小者。
 * 垂直權重壓低，是為了讓多行 wrap 時同一行的項目優先被選中。
 */
function onDragOver(e: DragEvent, container: string) {
  e.preventDefault()
  if (!dragged.value) return
  const el = e.currentTarget as HTMLElement
  const items = Array.from(el.querySelectorAll<HTMLElement>('.draggable-service:not(.dragging)'))

  let before: string | null = null
  let min = Infinity
  for (const item of items) {
    const r = item.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const distance = Math.abs(e.clientX - cx) + Math.abs(e.clientY - cy) * 0.5
    if (e.clientX < cx && distance < min) {
      min = distance
      before = item.dataset.service ?? null
    }
  }
  dropTarget.value = { container, before }
}

function onDragLeave(e: DragEvent, container: string) {
  // 游標移到子元素上也會冒出 dragleave，必須排除，否則指示線會一直閃爍
  const el = e.currentTarget as HTMLElement
  const related = e.relatedTarget as Node | null
  if (related && el.contains(related)) return
  if (dropTarget.value?.container === container) dropTarget.value = null
}

function onDrop(container: string) {
  const before = dropTarget.value?.container === container ? dropTarget.value.before : null
  moveTo(container, before ?? undefined)
  dragged.value = null
  dropTarget.value = null
}

/** 指示線是否要畫在這個項目前面 */
function indicatorBefore(container: string, item: string): boolean {
  return (
    !!dragged.value &&
    dropTarget.value?.container === container &&
    dropTarget.value.before === item
  )
}

/** 指示線是否要畫在這個容器的最後面 */
function indicatorAtEnd(container: string): boolean {
  return (
    !!dragged.value && dropTarget.value?.container === container && dropTarget.value.before === null
  )
}

function moveTo(target: string, beforeService?: string) {
  const service = dragged.value
  if (!service) return
  // 先從所有群組與隱藏區移除
  for (const g of temp.value.groups) {
    const i = g.items.indexOf(service)
    if (i > -1) g.items.splice(i, 1)
  }
  const hi = temp.value.hidden.indexOf(service)
  if (hi > -1) temp.value.hidden.splice(hi, 1)
  // 再插進目標位置
  const list =
    target === 'hidden' ? temp.value.hidden : temp.value.groups.find((g) => g.id === target)?.items
  if (!list) return
  if (beforeService && beforeService !== service) {
    const idx = list.indexOf(beforeService)
    if (idx > -1) list.splice(idx, 0, service)
    else list.push(service)
  } else {
    list.push(service)
  }
}

// ── 群組 ──────────────────────────────────────────────
function addGroup() {
  const n = temp.value.groups.filter((g) => g.id !== 'ungrouped').length + 1
  temp.value.groups.push({
    id: 'group-' + Date.now(),
    name: `群組 ${n}`,
    items: [],
    defaultVisible: true,
  })
}

function deleteGroup(id: string) {
  const g = temp.value.groups.find((x) => x.id === id)
  if (!g || g.id === 'ungrouped') return
  const ung = temp.value.groups.find((x) => x.id === 'ungrouped')
  if (ung) ung.items.push(...g.items)
  temp.value.groups = temp.value.groups.filter((x) => x.id !== id)
}

async function save() {
  busy.value = true
  try {
    const ok = await editor.saveDisplayConfig(temp.value)
    if (ok) emit('update:modelValue', false)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    title="📊 編輯顯示欄位"
    max-width="800px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="display-config-groups">
      <div v-for="group in temp.groups" :key="group.id" class="group-container">
        <div class="group-header">
          <input
            v-model="group.name"
            type="text"
            class="group-name-input"
            :disabled="group.id === 'ungrouped'"
          />
          <label
            class="group-visibility-toggle"
            :style="group.id === 'ungrouped' ? 'opacity:0.5;pointer-events:none' : ''"
          >
            <input
              v-model="group.defaultVisible"
              type="checkbox"
              :disabled="group.id === 'ungrouped'"
            />
            預設顯示
          </label>
          <button
            v-if="group.id !== 'ungrouped'"
            class="group-delete-btn"
            @click="deleteGroup(group.id)"
          >
            🗑️
          </button>
        </div>

        <div
          class="group-items"
          :class="{ 'drag-over': dropTarget?.container === group.id }"
          @dragover="onDragOver($event, group.id)"
          @dragleave="onDragLeave($event, group.id)"
          @drop.prevent="onDrop(group.id)"
        >
          <template v-for="item in group.items" :key="item">
            <div v-if="indicatorBefore(group.id, item)" class="drag-insert-indicator"></div>
            <div
              class="draggable-service"
              :class="{ dragging: dragged === item }"
              draggable="true"
              :data-service="item"
              @dragstart="onDragStart(item, $event)"
              @dragend="onDragEnd"
            >
              {{ item }}
            </div>
          </template>
          <div v-if="indicatorAtEnd(group.id)" class="drag-insert-indicator"></div>
        </div>
      </div>
    </div>

    <div class="add-group-section">
      <button class="btn btn-secondary" style="width: 100%" @click="addGroup">➕ 新增群組</button>
    </div>

    <div class="hidden-zone">
      <div class="hidden-zone-title">🚫 不顯示區域 (拖入此處的項目會隱藏)</div>
      <div
        class="hidden-zone-items"
        :class="{ 'drag-over': dropTarget?.container === 'hidden' }"
        @dragover="onDragOver($event, 'hidden')"
        @dragleave="onDragLeave($event, 'hidden')"
        @drop.prevent="onDrop('hidden')"
      >
        <template v-for="item in temp.hidden" :key="item">
          <div v-if="indicatorBefore('hidden', item)" class="drag-insert-indicator"></div>
          <div
            class="draggable-service"
            :class="{ dragging: dragged === item }"
            draggable="true"
            :data-service="item"
            @dragstart="onDragStart(item, $event)"
            @dragend="onDragEnd"
          >
            {{ item }}
          </div>
        </template>
        <div v-if="indicatorAtEnd('hidden')" class="drag-insert-indicator"></div>
        <div v-if="temp.hidden.length === 0 && !dragged" class="hidden-zone-empty">
          拖入不想顯示的服事項目
        </div>
      </div>
    </div>

    <template #footer="{ close }">
      <button class="btn btn-secondary" @click="close">取消</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">儲存設定</button>
    </template>
  </BaseModal>
</template>

<style scoped>
/* 比照舊版 edit-chart.html 的 inline style：群組一多就讓 body 自行捲動 */
:deep(.modal) {
  max-height: 80vh;
}
:deep(.modal-body) {
  overflow-y: auto;
  max-height: 60vh;
}
.display-config-groups {
  margin-bottom: 16px;
}
.hidden-zone-empty {
  color: #94a3b8;
  font-size: 13px;
}
.group-name-input:disabled {
  background: #e5e7eb;
  cursor: not-allowed;
}
</style>
