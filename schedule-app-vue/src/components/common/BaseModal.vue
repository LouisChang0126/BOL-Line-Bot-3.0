<script setup lang="ts">
/**
 * 共用彈窗 —— 沿用全域 styles.css 的 .modal-overlay / .modal 樣式。
 * 取代舊版散落各頁的 modal DOM 與手動 classList 操作。
 */
import { onBeforeUnmount, onMounted, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: boolean
    title?: string
    maxWidth?: string
    closeOnOverlay?: boolean
  }>(),
  { title: '', maxWidth: '480px', closeOnOverlay: true },
)

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  close: []
}>()

function close() {
  emit('update:modelValue', false)
  emit('close')
}

function onOverlayClick(e: MouseEvent) {
  if (props.closeOnOverlay && e.target === e.currentTarget) close()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.modelValue) close()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))

watch(
  () => props.modelValue,
  (open) => {
    document.body.style.overflow = open ? 'hidden' : ''
  },
)
</script>

<template>
  <Transition name="modal-fade">
    <div v-if="modelValue" class="modal-overlay" @click="onOverlayClick">
      <div class="modal" :style="{ maxWidth }">
        <div v-if="title || $slots.header" class="modal-header">
          <slot name="header">
            <h2>{{ title }}</h2>
          </slot>
          <button class="modal-close" type="button" @click="close">&times;</button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-footer">
          <slot name="footer" :close="close" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.18s ease;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}
</style>
