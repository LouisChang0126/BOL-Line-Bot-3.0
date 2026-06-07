<script setup lang="ts">
/** 編輯顯示欄位 / 分組（舊版 displayConfigModal）：拖拉服事到群組或隱藏區。 */
import { ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'
import type { DisplayConfig } from '@/types'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()
const temp = ref<DisplayConfig>({ groups: [], hidden: [] })
const dragged = ref<string | null>(null)
const busy = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    const dc = editor.displayConfig
    temp.value = dc
      ? JSON.parse(JSON.stringify(dc))
      : { groups: [{ id: 'ungrouped', name: '未分組', items: [...editor.serviceItems], defaultVisible: true }], hidden: [] }
  },
)

function onDragStart(service: string) {
  dragged.value = service
}

function moveTo(target: string, beforeService?: string) {
  const service = dragged.value
  dragged.value = null
  if (!service) return
  // 從所有群組與隱藏區移除
  for (const g of temp.value.groups) {
    const i = g.items.indexOf(service)
    if (i > -1) g.items.splice(i, 1)
  }
  const hi = temp.value.hidden.indexOf(service)
  if (hi > -1) temp.value.hidden.splice(hi, 1)
  // 插入目標
  const list = target === 'hidden' ? temp.value.hidden : temp.value.groups.find((g) => g.id === target)?.items
  if (!list) return
  if (beforeService && beforeService !== service) {
    const idx = list.indexOf(beforeService)
    if (idx > -1) list.splice(idx, 0, service)
    else list.push(service)
  } else {
    list.push(service)
  }
}

function addGroup() {
  const n = temp.value.groups.filter((g) => g.id !== 'ungrouped').length + 1
  temp.value.groups.push({ id: 'group-' + Date.now(), name: `群組 ${n}`, items: [], defaultVisible: true })
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
    <div class="dc-groups">
      <div v-for="group in temp.groups" :key="group.id" class="dc-group">
        <div class="dc-group-header">
          <input
            v-model="group.name"
            class="dc-group-name"
            :disabled="group.id === 'ungrouped'"
          />
          <label v-if="group.id !== 'ungrouped'" class="dc-visible">
            <input v-model="group.defaultVisible" type="checkbox" /> 預設顯示
          </label>
          <button v-if="group.id !== 'ungrouped'" class="dc-del" @click="deleteGroup(group.id)">🗑️</button>
        </div>
        <div class="dc-items" @dragover.prevent @drop="moveTo(group.id)">
          <div
            v-for="item in group.items"
            :key="item"
            class="dc-item"
            draggable="true"
            @dragstart="onDragStart(item)"
            @dragover.prevent
            @drop.stop="moveTo(group.id, item)"
          >
            {{ item }}
          </div>
          <div v-if="group.items.length === 0" class="dc-empty">拖入服事項目</div>
        </div>
      </div>
    </div>

    <button class="btn btn-secondary dc-add" @click="addGroup">➕ 新增群組</button>

    <div class="dc-hidden">
      <div class="dc-hidden-title">🚫 不顯示區域（拖入此處的項目會隱藏）</div>
      <div class="dc-items" @dragover.prevent @drop="moveTo('hidden')">
        <div
          v-for="item in temp.hidden"
          :key="item"
          class="dc-item"
          draggable="true"
          @dragstart="onDragStart(item)"
          @dragover.prevent
          @drop.stop="moveTo('hidden', item)"
        >
          {{ item }}
        </div>
        <div v-if="temp.hidden.length === 0" class="dc-empty">拖入不想顯示的服事項目</div>
      </div>
    </div>

    <template #footer="{ close }">
      <button class="btn btn-secondary" @click="close">取消</button>
      <button class="btn btn-primary" :disabled="busy" @click="save">儲存設定</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.dc-groups {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.dc-group {
  border: 1px solid var(--border-color);
  border-radius: 10px;
  padding: 12px;
}
.dc-group-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.dc-group-name {
  font-weight: 600;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  padding: 4px 8px;
  flex: 1;
}
.dc-group-name:disabled {
  background: var(--gray-100);
  cursor: not-allowed;
}
.dc-visible {
  font-size: 13px;
  color: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.dc-del {
  border: none;
  background: transparent;
  cursor: pointer;
  font-size: 16px;
}
.dc-items {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  min-height: 44px;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 8px;
}
.dc-item {
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 5px 14px;
  font-size: 13px;
  cursor: grab;
}
.dc-empty {
  color: var(--text-light);
  font-size: 13px;
  padding: 4px;
}
.dc-add {
  width: 100%;
  margin: 14px 0;
}
.dc-hidden {
  border: 2px dashed var(--border-color);
  border-radius: 10px;
  padding: 12px;
}
.dc-hidden-title {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
</style>
