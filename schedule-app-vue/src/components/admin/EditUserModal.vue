<script setup lang="ts">
/**
 * 編輯使用者彈窗 —— 對應舊版 edit-user.html 的編輯 Modal。
 *
 * 內容：LINE ID、Line Bot ID 選擇器（0..4 互斥）、週一至週六提醒勾選、
 * 各崇拜的服事項目管理（可移除標籤、下拉新增服事、下拉新增其他崇拜）。
 * 以本地可編輯副本操作，按「儲存」時才送出整份 UserDoc（已清掉空陣列的崇拜）。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { generateLoginToken } from '@/services/users'
import type { UserDoc } from '@/types'

const props = defineProps<{
  modelValue: boolean
  /** 正在編輯的使用者名稱 */
  name: string
  /** 原始使用者資料（新使用者剛建立後也會有一份） */
  user: UserDoc | null
  /** 目前鎖定的崇拜 id；無則空字串 */
  collection: string
  /** 所有崇拜 id（依 serve-list 順序） */
  collectionIds: string[]
  /** 崇拜 id → 顯示名稱 */
  serveNames: Record<string, string>
  /** 崇拜 id → 該崇拜可選服事項目（metadata.serviceItems） */
  serviceItemsByCollection: Record<string, string[]>
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  save: [name: string, data: UserDoc]
  delete: [name: string]
}>()

const ALARM_LABELS = ['週一', '週二', '週三', '週四', '週五', '週六']

// ── 本地可編輯狀態 ───────────────────────────────────────────
const lineId = ref('')
const lineBotId = ref(0)
const alarms = reactive<boolean[]>([false, false, false, false, false, false])
const loginToken = ref('')
// serve_types 的可編輯副本：崇拜 id → 服事陣列（含空陣列代表「已加入此崇拜但尚未選服事」）
const serveTypes = reactive<Record<string, string[]>>({})

function resetFromProps() {
  const u = props.user
  lineId.value = u?.lineId ?? ''
  lineBotId.value = u?.line_bot_id ?? 0
  loginToken.value = u?.login_token ?? ''
  const at = u?.alarm_type ?? []
  for (let i = 0; i < 6; i++) alarms[i] = at[i] ?? false

  for (const k of Object.keys(serveTypes)) delete serveTypes[k]
  const src = u?.serve_types ?? {}
  for (const [k, v] of Object.entries(src)) serveTypes[k] = [...v]

  // 新使用者：用班表帶入的服事（透過 user.serve_types 已塞好），這裡確保目前崇拜至少有空區塊
  if (props.collection && serveTypes[props.collection] === undefined && Object.keys(serveTypes).length === 0) {
    serveTypes[props.collection] = []
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      resetFromProps()
      closeDropdown()
    }
  },
  { immediate: true },
)

// ── 服事區塊（依 collectionIds 順序，僅顯示已加入的崇拜） ─────────
const sections = computed(() =>
  props.collectionIds
    .filter((id) => serveTypes[id] !== undefined)
    .map((id) => ({ id, name: props.serveNames[id] ?? id, items: serveTypes[id] })),
)

/** 尚未加入的崇拜（可用「新增其他崇拜服事」加入） */
const unusedCollections = computed(() =>
  props.collectionIds.filter((id) => serveTypes[id] === undefined),
)

function removeServe(col: string, serve: string) {
  const arr = serveTypes[col]
  if (!arr) return
  const idx = arr.indexOf(serve)
  if (idx > -1) arr.splice(idx, 1)
  if (arr.length === 0) delete serveTypes[col]
  closeDropdown()
}

function addServe(col: string, serve: string) {
  const arr = (serveTypes[col] ??= [])
  if (!arr.includes(serve)) arr.push(serve)
  closeDropdown()
}

function addCollection(col: string) {
  if (serveTypes[col] === undefined) serveTypes[col] = []
  closeDropdown()
}

// ── 下拉選單（服事 / 崇拜），對齊觸發按鈕、teleport 到 body ──────
type DropdownState =
  | { kind: 'serve'; col: string; x: number; y: number }
  | { kind: 'collection'; x: number; y: number }
const dropdown = ref<DropdownState | null>(null)

/** 目前服事下拉所屬的崇拜 id（kind=serve 時） */
const activeServeCol = computed(() => {
  const d = dropdown.value
  return d?.kind === 'serve' ? d.col : ''
})

const dropdownServeItems = computed(() => {
  const col = activeServeCol.value
  if (!col) return []
  const available = props.serviceItemsByCollection[col] ?? []
  const chosen = serveTypes[col] ?? []
  return available.map((item) => ({ item, selected: chosen.includes(item) }))
})

function openServeDropdown(col: string, e: MouseEvent) {
  const available = props.serviceItemsByCollection[col] ?? []
  if (available.length === 0) {
    alert('此崇拜沒有服事項目')
    return
  }
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropdown.value = { kind: 'serve', col, x: rect.left, y: rect.bottom + 4 }
}

function openCollectionDropdown(e: MouseEvent) {
  if (unusedCollections.value.length === 0) return
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  dropdown.value = { kind: 'collection', x: rect.left, y: rect.bottom + 4 }
}

function closeDropdown() {
  dropdown.value = null
}

function onWindowClick() {
  if (dropdown.value) closeDropdown()
}
onMounted(() => window.addEventListener('click', onWindowClick))
onBeforeUnmount(() => window.removeEventListener('click', onWindowClick))

// ── 儲存 / 刪除 ─────────────────────────────────────────────
function buildUserDoc(): UserDoc {
  const cleaned: Record<string, string[]> = {}
  for (const [col, items] of Object.entries(serveTypes)) {
    if (items && items.length > 0) cleaned[col] = [...items]
  }
  return {
    alarm_type: [...alarms],
    lineId: lineId.value.trim(),
    login_token: loginToken.value || generateLoginToken(),
    line_bot_id: lineBotId.value,
    serve_types: cleaned,
    usage_count: props.user?.usage_count ?? {},
  }
}

function onSave() {
  emit('save', props.name, buildUserDoc())
}

function onDelete() {
  emit('delete', props.name)
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    :title="`編輯使用者：${name}`"
    max-width="600px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- LINE ID -->
    <div class="form-group">
      <label>LINE ID</label>
      <input v-model="lineId" class="form-control" placeholder="輸入 LINE 使用者 ID" />
    </div>

    <!-- Line Bot ID -->
    <div class="form-group">
      <label>Line Bot ID（使用哪台機器人）</label>
      <div class="line-bot-selector">
        <button
          v-for="opt in [0, 1, 2, 3, 4]"
          :key="opt"
          type="button"
          class="line-bot-btn"
          :class="{ active: lineBotId === opt }"
          @click="lineBotId = opt"
        >
          {{ opt === 0 ? '無' : opt }}
        </button>
      </div>
    </div>

    <!-- 提醒設定 -->
    <div class="form-group">
      <label>提醒設定（週一至週六）</label>
      <div class="alarm-settings">
        <label v-for="(lbl, i) in ALARM_LABELS" :key="i" class="alarm-checkbox-item">
          <input v-model="alarms[i]" type="checkbox" /> {{ lbl }}
        </label>
      </div>
    </div>

    <!-- 服事項目 -->
    <div class="form-group">
      <label>服事項目</label>
      <div class="serve-section" v-for="sec in sections" :key="sec.id">
        <div class="serve-section-header">
          <span class="serve-section-title">{{ sec.name }}</span>
        </div>
        <div class="serve-items-container">
          <span v-for="s in sec.items" :key="s" class="serve-item-tag">
            {{ s }}
            <button class="serve-item-remove" type="button" @click.stop="removeServe(sec.id, s)">
              ×
            </button>
          </span>
          <button class="add-serve-btn" type="button" @click.stop="openServeDropdown(sec.id, $event)">
            + 新增服事
          </button>
        </div>
      </div>

      <div v-if="unusedCollections.length" style="margin-top: 8px">
        <button class="btn btn-secondary btn-sm" type="button" @click.stop="openCollectionDropdown">
          ➕ 新增其他崇拜服事
        </button>
      </div>
    </div>

    <template #footer="{ close }">
      <div class="footer-row">
        <button class="btn btn-danger" @click="onDelete">刪除使用者</button>
        <div style="display: flex; gap: 16px">
          <button class="btn btn-secondary" @click="close">取消</button>
          <button class="btn btn-primary" @click="onSave">儲存</button>
        </div>
      </div>
    </template>
  </BaseModal>

  <!-- 下拉選單（teleport 到 body，覆蓋於 modal 之上） -->
  <Teleport to="body">
    <div
      v-if="dropdown"
      class="serve-dropdown"
      :style="{ left: dropdown.x + 'px', top: dropdown.y + 'px' }"
      @click.stop
    >
      <template v-if="dropdown.kind === 'serve'">
        <div
          v-for="opt in dropdownServeItems"
          :key="opt.item"
          class="serve-dropdown-item"
          :class="{ disabled: opt.selected }"
          @click="!opt.selected && addServe(activeServeCol, opt.item)"
        >
          {{ opt.item }}<span v-if="opt.selected"> (已加入)</span>
        </div>
      </template>
      <template v-else>
        <div
          v-for="col in unusedCollections"
          :key="col"
          class="serve-dropdown-item"
          @click="addCollection(col)"
        >
          {{ serveNames[col] ?? col }}
        </div>
      </template>
    </div>
  </Teleport>
</template>

<style scoped>
.footer-row {
  display: flex;
  justify-content: space-between;
  width: 100%;
}

/* Line Bot ID 選擇器 */
.line-bot-selector {
  display: flex;
  gap: 0;
}
.line-bot-btn {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  background: white;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.2s;
}
.line-bot-btn:first-child {
  border-radius: 8px 0 0 8px;
}
.line-bot-btn:last-child {
  border-radius: 0 8px 8px 0;
}
.line-bot-btn:not(:first-child) {
  border-left: none;
}
.line-bot-btn:hover {
  background: var(--bg-hover);
}
.line-bot-btn.active {
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}
.line-bot-btn.active + .line-bot-btn {
  border-left-color: var(--primary-color);
}

/* 服事項目可編輯區塊 */
.serve-section {
  margin-bottom: 16px;
  padding: 12px;
  background: var(--bg-secondary);
  border-radius: var(--border-radius);
}
.serve-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.serve-section-title {
  font-weight: 600;
  font-size: 14px;
}
.serve-items-container {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.serve-item-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--primary-light);
  color: var(--primary-color);
  border-radius: 12px;
  font-size: 13px;
  font-weight: 500;
}
.serve-item-remove {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.1);
  color: var(--primary-color);
  font-size: 12px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
}
.serve-item-remove:hover {
  background: rgba(0, 0, 0, 0.2);
}
.add-serve-btn {
  padding: 4px 10px;
  background: white;
  border: 1px dashed var(--border-color);
  border-radius: 12px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.add-serve-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
}
</style>

<style>
/* 下拉選單為 teleport 到 body，需用非 scoped 樣式 */
.serve-dropdown {
  position: fixed;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  box-shadow: var(--shadow-md);
  z-index: 1100;
  max-height: 200px;
  overflow-y: auto;
  min-width: 150px;
}
.serve-dropdown-item {
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
}
.serve-dropdown-item:hover {
  background: var(--bg-hover);
}
.serve-dropdown-item.disabled {
  color: var(--text-light);
  cursor: not-allowed;
}
</style>
