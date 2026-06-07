<script setup lang="ts">
/** 新增服事項目 / 資訊欄位（舊版 addColumnModal）。 */
import { ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()
const colType = ref<'service' | 'info'>('service')
const nameInput = ref('')
const busy = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      colType.value = 'service'
      nameInput.value = ''
    }
  },
)

async function confirm() {
  const name = nameInput.value.trim()
  if (!name) return
  if (name.includes('|')) return window.alert('名稱不能包含 "|" 符號')
  if (editor.serviceItems.includes(name)) {
    return window.alert(colType.value === 'service' ? '此服事項目已存在' : '此欄位名稱已存在')
  }
  busy.value = true
  try {
    await editor.doAddColumn(name, colType.value === 'info')
    emit('update:modelValue', false)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    title="✨ 新增欄位"
    max-width="420px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="form-group">
      <label>類型</label>
      <div class="type-toggle">
        <button class="btn" :class="colType === 'service' ? 'btn-primary' : 'btn-secondary'" @click="colType = 'service'">
          ✨ 服事項目
        </button>
        <button class="btn" :class="colType === 'info' ? 'btn-primary' : 'btn-secondary'" @click="colType = 'info'">
          📝 資訊欄位
        </button>
      </div>
    </div>
    <div class="form-group">
      <label>名稱</label>
      <input v-model="nameInput" class="form-control" placeholder="請輸入名稱..." @keyup.enter="confirm" />
      <div class="form-hint">名稱不能包含 <code>|</code> 符號</div>
    </div>
    <template #footer="{ close }">
      <button class="btn btn-secondary" @click="close">取消</button>
      <button class="btn btn-primary" :disabled="busy" @click="confirm">新增</button>
    </template>
  </BaseModal>
</template>

<style scoped>
.type-toggle {
  display: flex;
  gap: 8px;
}
.type-toggle .btn {
  flex: 1;
}
.form-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
.form-hint code {
  background: var(--bg-secondary);
  padding: 1px 5px;
  border-radius: 4px;
}
</style>
