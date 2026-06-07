<script setup lang="ts">
/** 個人班表選擇 —— `/` 帶 ?user= 時顯示（舊版 index.html 的對應頁）。 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { loadUser } from '@/services/users'
import { loadServeList } from '@/services/serves'
import type { Serve } from '@/types'

const props = defineProps<{ userName: string }>()
const router = useRouter()

const loading = ref(true)
const errorTitle = ref('')
const errorMsg = ref('')
const serves = ref<Serve[]>([])

function showError(title: string, msg: string) {
  errorTitle.value = title
  errorMsg.value = msg
}

function viewLink(serve: Serve) {
  return { name: 'view', query: { service: serve.name, user: props.userName } }
}

onMounted(async () => {
  try {
    const user = await loadUser(props.userName)
    if (!user) {
      showError('找不到使用者', `使用者「${props.userName}」不存在`)
      return
    }

    const serveTypes = user.serve_types || {}
    const userServeIds = Object.keys(serveTypes).filter(
      (id) => Array.isArray(serveTypes[id]) && serveTypes[id].length > 0,
    )
    if (userServeIds.length === 0) {
      showError('尚無服事', `使用者「${props.userName}」目前沒有任何服事項目`)
      return
    }

    const all = await loadServeList()
    serves.value = all.filter((s) => userServeIds.includes(s.id))

    // 只有一個崇拜 → 直接進入該班表
    if (serves.value.length === 1) {
      router.replace(viewLink(serves.value[0]))
    }
  } catch (e) {
    console.error('初始化失敗:', e)
    showError('載入失敗', '請檢查網路連線後重試')
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="selection-page">
    <div v-if="errorTitle" class="error-page">
      <div class="error-icon">⚠️</div>
      <h2>{{ errorTitle }}</h2>
      <p>{{ errorMsg }}</p>
      <router-link to="/" class="btn btn-secondary">回首頁</router-link>
    </div>

    <template v-else>
      <div class="selection-title">
        <h1>📖 {{ userName }} 的服事班表</h1>
        <p>請選擇要查看的班表</p>
      </div>

      <div v-if="loading" class="loading-message">載入中...</div>
      <div v-else class="collection-cards">
        <router-link
          v-for="serve in serves"
          :key="serve.id"
          :to="viewLink(serve)"
          class="collection-card"
        >
          <div class="icon">{{ serve.emoji }}</div>
          <div class="name">{{ serve.name }}</div>
        </router-link>
      </div>
    </template>
  </div>
</template>

<style scoped>
.selection-page {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 32px;
}
.selection-title {
  text-align: center;
  margin-bottom: 48px;
}
.selection-title h1 {
  font-size: 32px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.selection-title p {
  font-size: 16px;
  color: var(--text-secondary);
}
.collection-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  justify-content: center;
  max-width: 1100px;
}
.collection-card {
  background: white;
  border: 1px solid var(--border-color);
  border-radius: 16px;
  padding: 32px 48px;
  text-align: center;
  cursor: pointer;
  transition: all 0.25s ease;
  box-shadow: var(--shadow-md);
  min-width: 200px;
  text-decoration: none;
}
.collection-card:hover {
  transform: translateY(-4px);
  box-shadow: var(--shadow-lg);
  border-color: var(--primary-color);
}
.collection-card .icon {
  font-size: 48px;
  margin-bottom: 16px;
}
.collection-card .name {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}
.loading-message {
  text-align: center;
  color: var(--text-secondary);
  font-size: 16px;
}
.error-page {
  text-align: center;
  padding: 60px;
}
.error-page .error-icon {
  font-size: 64px;
  margin-bottom: 16px;
}
.error-page h2 {
  color: #dc2626;
  margin-bottom: 8px;
}
.error-page p {
  color: var(--text-secondary);
  margin-bottom: 24px;
}
</style>
