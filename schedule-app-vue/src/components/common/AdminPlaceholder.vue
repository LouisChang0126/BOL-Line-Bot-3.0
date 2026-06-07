<script setup lang="ts">
/** 重構中的管理頁佔位元件。各 stub view 共用，待對應階段以完整實作取代。 */
import { useRoute, useRouter } from 'vue-router'

defineProps<{ title: string; note?: string }>()
const route = useRoute()
const router = useRouter()
const collection = (route.query.collection as string) || ''
</script>

<template>
  <div class="placeholder-page">
    <div class="placeholder-card">
      <div class="placeholder-icon">🚧</div>
      <h1>{{ title }}</h1>
      <p class="placeholder-note">{{ note || '此頁面正在重構為 Vue 版本。' }}</p>
      <p v-if="collection" class="placeholder-meta">collection: <code>{{ collection }}</code></p>
      <div class="placeholder-actions">
        <button class="btn btn-secondary" @click="router.back()">← 返回</button>
        <button class="btn btn-primary" @click="router.push('/admin')">回崇拜選擇</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.placeholder-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-secondary);
}
.placeholder-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-lg);
  box-shadow: var(--shadow-md);
  padding: 48px 40px;
  text-align: center;
  max-width: 460px;
}
.placeholder-icon {
  font-size: 56px;
  margin-bottom: 12px;
}
.placeholder-card h1 {
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
  color: var(--text-primary);
}
.placeholder-note {
  color: var(--text-secondary);
  line-height: 1.7;
}
.placeholder-meta {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-light);
}
.placeholder-meta code {
  background: var(--bg-secondary);
  padding: 1px 6px;
  border-radius: 4px;
}
.placeholder-actions {
  margin-top: 28px;
  display: flex;
  gap: 12px;
  justify-content: center;
}
</style>
