<script setup lang="ts">
/** 編輯儲存格內容（舊版 editPersonModal）：服事欄位 → 人員；資訊欄位 → 文字列表。 */
import { computed, ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'
import { cellOf } from '@/utils/schedule'
import { formatDisplayDate } from '@/utils/dates'

const props = defineProps<{ modelValue: boolean; date: string; service: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()
const newPerson = ref('')
const newInfo = ref('')

const isInfo = computed(() => editor.nonUserColumns.includes(props.service))
const row = computed(() => editor.scheduleData.find((r) => r.date === props.date))
const current = computed(() => cellOf(row.value, props.service))

/** 在此服事「有經驗」的人（其他列出現過） */
const veterans = computed(() => {
  const set = new Set<string>()
  for (const r of editor.scheduleData) {
    if (r.date === props.date) continue
    for (const n of cellOf(r, props.service)) set.add(n)
  }
  return set
})

const available = computed(() => {
  const cur = new Set(current.value)
  return [...editor.allPersonNames]
    .filter((n) => !cur.has(n))
    .sort((a, b) => {
      const av = veterans.value.has(a)
      const bv = veterans.value.has(b)
      if (av && !bv) return -1
      if (!av && bv) return 1
      return a.localeCompare(b, 'zh-TW')
    })
})

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      newPerson.value = ''
      newInfo.value = ''
    }
  },
)

async function addExisting(name: string) {
  await editor.addPersonToCell(props.date, props.service, name)
}
async function addNew() {
  const name = newPerson.value.trim()
  if (!name) return window.alert('請輸入姓名')
  if (name.includes('|')) return window.alert('姓名不能包含 "|" 符號')
  const ok = await editor.addPersonToCell(props.date, props.service, name)
  if (ok) newPerson.value = ''
}
async function remove(name: string) {
  await editor.removePerson(props.date, props.service, name)
}

async function onInfoChange(index: number, value: string) {
  const v = value.trim()
  if (v === '') await editor.removeInfoItem(props.date, props.service, index)
  else await editor.updateInfoItem(props.date, props.service, index, v)
}
async function addInfo() {
  const v = newInfo.value.trim()
  if (!v) return window.alert('請輸入資訊')
  await editor.addInfoItem(props.date, props.service, v)
  newInfo.value = ''
}

async function done() {
  if (isInfo.value && newInfo.value.trim()) await addInfo()
  emit('update:modelValue', false)
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    :title="isInfo ? '編輯資訊內容' : '編輯服事人員'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="modal-subtitle">{{ formatDisplayDate(date) }} - {{ service }}</div>

    <!-- 資訊欄位 -->
    <template v-if="isInfo">
      <div class="form-group">
        <label>資訊內容</label>
        <div class="info-list">
          <div v-for="(item, i) in current" :key="i" class="info-input-row">
            <input
              class="form-control"
              :value="item"
              @change="onInfoChange(i, ($event.target as HTMLInputElement).value)"
            />
            <button class="remove-info-btn" @click="editor.removeInfoItem(date, service, i)">×</button>
          </div>
          <div class="info-input-row">
            <input v-model="newInfo" class="form-control" placeholder="輸入新資訊..." @keyup.enter="addInfo" />
            <button class="add-info-btn" @click="addInfo">+</button>
          </div>
        </div>
      </div>
    </template>

    <!-- 服事人員 -->
    <template v-else>
      <div class="form-group">
        <label>選擇現有人員或輸入新人員</label>
        <div class="person-chips-select">
          <div
            v-for="name in available"
            :key="name"
            class="person-chip-selectable"
            :class="{ veteran: veterans.has(name) }"
            :style="{ background: editor.getPersonColor(name) }"
            @click="addExisting(name)"
          >
            {{ name }}
          </div>
          <div v-if="available.length === 0" class="text-muted" style="padding: 8px">無可用人員，請輸入新人員</div>
        </div>
        <div class="person-chip-input-wrapper">
          <input v-model="newPerson" class="person-chip-input" placeholder="輸入新姓名..." @keyup.enter="addNew" />
          <button class="person-chip-input-btn" @click="addNew">+</button>
        </div>
      </div>
      <div class="form-group">
        <label>目前服事人員</label>
        <div class="person-chips">
          <div v-if="current.length === 0" class="text-muted">尚未指派人員</div>
          <div
            v-for="name in current"
            :key="name"
            class="person-chip"
            :style="{ background: editor.getPersonColor(name) }"
          >
            {{ name }}
            <button class="remove-btn" @click="remove(name)">×</button>
          </div>
        </div>
      </div>
    </template>

    <template #footer="{ close }">
      <button class="btn btn-primary" @click="isInfo ? done() : close()">完成</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.modal-subtitle {
  color: var(--text-secondary);
  font-size: 14px;
  margin-bottom: 16px;
}
.info-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.info-input-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.add-info-btn,
.remove-info-btn {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-secondary);
  cursor: pointer;
  font-size: 16px;
}
.person-chips-select {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 180px;
  overflow-y: auto;
  margin-bottom: 10px;
}
.person-chip-selectable {
  color: #fff;
  border-radius: 14px;
  padding: 4px 12px;
  font-size: 13px;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s;
}
.person-chip-selectable:hover {
  opacity: 1;
}
.person-chip-selectable.veteran {
  box-shadow: 0 0 0 2px var(--warning-color);
}
.person-chip-input-wrapper {
  display: flex;
  gap: 8px;
}
.person-chip-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}
.person-chip-input-btn {
  width: 40px;
  border: none;
  border-radius: 8px;
  background: var(--primary-color);
  color: #fff;
  font-size: 18px;
  cursor: pointer;
}
.person-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.person-chip {
  color: #fff;
  border-radius: 14px;
  padding: 4px 10px;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.remove-btn {
  background: rgba(255, 255, 255, 0.3);
  border: none;
  color: #fff;
  border-radius: 50%;
  width: 16px;
  height: 16px;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
}
</style>
