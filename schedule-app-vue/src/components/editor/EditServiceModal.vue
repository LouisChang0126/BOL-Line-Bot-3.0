<script setup lang="ts">
/** 編輯服事項目（舊版 editServiceModal）：改名 / 切換資訊欄位 / 刪除。 */
import { ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import { useEditorStore } from '@/stores/editor'

const props = defineProps<{ modelValue: boolean; serviceName: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()

const editor = useEditorStore()
const nameInput = ref('')
const isInfo = ref(false)
const busy = ref(false)

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      nameInput.value = props.serviceName
      isInfo.value = editor.nonUserColumns.includes(props.serviceName)
    }
  },
)

async function save() {
  const newName = nameInput.value.trim()
  if (!newName) return window.alert('請輸入服事項目名稱')
  if (newName.includes('|')) return window.alert('名稱不能包含 "|" 符號')
  const changed = newName !== props.serviceName
  if (changed && editor.serviceItems.includes(newName)) return window.alert('此服事項目名稱已存在')
  busy.value = true
  try {
    await editor.renameService(props.serviceName, newName, isInfo.value)
    emit('update:modelValue', false)
  } finally {
    busy.value = false
  }
}

async function remove() {
  if (!window.confirm(`確定要刪除服事項目「${props.serviceName}」嗎？這將刪除所有相關資料。`)) return
  busy.value = true
  try {
    await editor.deleteServiceItem(props.serviceName)
    emit('update:modelValue', false)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <BaseModal
    :model-value="modelValue"
    :title="isInfo ? '編輯資訊欄位' : '編輯服事項目'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="form-group">
      <label>名稱</label>
      <input v-model="nameInput" class="form-control" placeholder="請輸入名稱" @keyup.enter="save" />
    </div>
    <div class="form-group checkbox-row">
      <input id="isInfoCheckbox" v-model="isInfo" type="checkbox" />
      <label for="isInfoCheckbox">這是資訊欄位（不包含人名）</label>
    </div>
    <template #footer>
      <div class="footer-split">
        <button class="btn btn-danger" :disabled="busy" @click="remove">移除</button>
        <div class="footer-right">
          <button class="btn btn-secondary" :disabled="busy" @click="emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="busy" @click="save">儲存</button>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<style scoped>
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.checkbox-row input {
  width: 18px;
  height: 18px;
}
.footer-split {
  display: flex;
  justify-content: space-between;
  width: 100%;
}
.footer-right {
  display: flex;
  gap: 12px;
}
</style>
