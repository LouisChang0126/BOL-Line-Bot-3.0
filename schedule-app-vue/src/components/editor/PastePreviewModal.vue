<script setup lang="ts">
/** 外部貼上預覽（舊版 pastePreviewModal）：可即時切換人名分隔符後確認匯入。 */
import { computed, ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'

const props = defineProps<{
  modelValue: boolean
  startDateIndex: number
  startServiceIndex: number
  rawData: string
}>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()

const SEPARATORS = [
  { value: '/', label: '/ 斜線' },
  { value: '+', label: '+ 加號' },
  { value: ',', label: ', 半形逗號' },
  { value: '，', label: '， 全形逗號' },
  { value: ' ', label: '空格' },
  { value: '', label: '無分隔' },
]

const separator = ref('/')

/** rawData → 以 \n 分列、\t 分欄 */
const parsedRows = computed<string[][]>(() => {
  const lines = props.rawData.split('\n')
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => l.split('\t'))
})

const colCount = computed(() => Math.max(0, ...parsedRows.value.map((r) => r.length)))

function splitNames(cellValue: string): string[] {
  const v = cellValue.trim()
  if (v === '') return []
  if (separator.value === '') return [v]
  return v.split(separator.value).map((n) => n.trim()).filter(Boolean)
}

function serviceAt(j: number): string | undefined {
  return editor.serviceItems[props.startServiceIndex + j]
}
function dateAt(i: number): string | undefined {
  return editor.scheduleData[props.startDateIndex + i]?.date
}

// 自動偵測分隔符
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return
    const priority = ['/', '+', ',', '，', ' ']
    separator.value = priority.find((s) => props.rawData.includes(s)) ?? ''
  },
)

async function confirmImport() {
  const ok = await editor.executePaste(
    props.startDateIndex,
    props.startServiceIndex,
    parsedRows.value,
    separator.value,
  )
  if (ok) emit('update:modelValue', false)
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    title="📋 貼上預覽"
    max-width="850px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="separator-options">
      <span class="separator-label">人名分隔符：</span>
      <label v-for="s in SEPARATORS" :key="s.value" class="separator-option">
        <input v-model="separator" type="radio" :value="s.value" />
        {{ s.label }}
      </label>
    </div>
    <div style="overflow-x: auto; margin-top: 12px">
      <table class="paste-preview-table">
        <thead>
          <tr>
            <th>日期</th>
            <th v-for="j in colCount" :key="j">{{ serviceAt(j - 1) ?? '—' }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(cells, i) in parsedRows" :key="i">
            <td v-if="dateAt(i)" style="white-space: nowrap; font-weight: 600">{{ dateAt(i) }}</td>
            <td v-else style="color: var(--text-light)">（超出範圍）</td>
            <td v-for="j in colCount" :key="j">
              <template v-if="serviceAt(j - 1)">
                <span v-for="name in splitNames(cells[j - 1] || '')" :key="name" class="preview-chip">{{ name }}</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <template #footer="{ close }">
      <button class="btn btn-secondary" @click="close">取消</button>
      <button class="btn btn-primary" @click="confirmImport">確認匯入</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.separator-options {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}
.separator-label {
  font-weight: 600;
}
.separator-option {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  cursor: pointer;
}
.paste-preview-table {
  width: 100%;
  border-collapse: collapse;
}
.paste-preview-table th,
.paste-preview-table td {
  border: 1px solid var(--gray-100);
  padding: 6px 10px;
  text-align: center;
  font-size: 13px;
}
.preview-chip {
  display: inline-block;
  background: var(--primary-light);
  color: var(--primary-hover);
  border-radius: 10px;
  padding: 1px 8px;
  margin: 2px;
  font-size: 12px;
}
</style>
