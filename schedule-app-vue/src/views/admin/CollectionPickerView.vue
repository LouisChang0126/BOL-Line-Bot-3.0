<script setup lang="ts">
/** 管理端崇拜選擇頁（舊版 edit-chart/index.html）。需管理員登入。 */
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import BaseModal from '@/components/common/BaseModal.vue'
import { useServesStore } from '@/stores/serves'
import { useAuthStore } from '@/stores/auth'
import { deleteServeCascade, initServeMetadata, nextAvailableServeId } from '@/services/serves'
import { AVAILABLE_EMOJIS, MAX_SERVES, type Serve } from '@/types'

const router = useRouter()
const servesStore = useServesStore()
const { serves } = storeToRefs(servesStore)
const auth = useAuthStore()

const loading = ref(true)
const busy = ref(false)

// 新增/編輯 modal
const serveModalOpen = ref(false)
const editingId = ref<string | null>(null)
const nameInput = ref('')
const selectedEmoji = ref<string>(AVAILABLE_EMOJIS[0])

// 刪除 modal
const deleteModalOpen = ref(false)
const deleteTarget = ref<Serve | null>(null)
const deleteConfirmInput = ref('')

onMounted(async () => {
  try {
    await servesStore.ensureLoaded()
  } finally {
    loading.value = false
  }
})

function openEditor(serve: Serve) {
  router.push({ name: 'editor', query: { collection: serve.id } })
}

function openAddModal() {
  editingId.value = null
  selectedEmoji.value = AVAILABLE_EMOJIS[0]
  nameInput.value = ''
  serveModalOpen.value = true
}

function openEditModal(serve: Serve) {
  editingId.value = serve.id
  selectedEmoji.value = serve.emoji
  nameInput.value = serve.name
  serveModalOpen.value = true
}

async function saveServe() {
  const name = nameInput.value.trim()
  if (!name) return alert('請輸入崇拜名稱')
  if (serves.value.some((s) => s.name === name && s.id !== editingId.value)) {
    return alert('此崇拜名稱已存在')
  }

  busy.value = true
  try {
    let next: Serve[]
    if (editingId.value) {
      next = serves.value.map((s) =>
        s.id === editingId.value ? { ...s, name, emoji: selectedEmoji.value } : s,
      )
    } else {
      const id = nextAvailableServeId(serves.value)
      if (!id) return alert('已達到最大崇拜數量限制')
      await initServeMetadata(id)
      next = [...serves.value, { id, name, emoji: selectedEmoji.value }]
    }
    await servesStore.save(next)
    serveModalOpen.value = false
  } catch (e) {
    alert('儲存失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

function openDeleteModal(serve: Serve) {
  deleteTarget.value = serve
  deleteConfirmInput.value = ''
  deleteModalOpen.value = true
}

async function confirmDelete() {
  const target = deleteTarget.value
  if (!target || deleteConfirmInput.value !== target.name) return
  busy.value = true
  try {
    await deleteServeCascade(target.id)
    await servesStore.save(serves.value.filter((s) => s.id !== target.id))
    deleteModalOpen.value = false
    alert('已成功刪除崇拜')
  } catch (e) {
    alert('刪除失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

async function logout() {
  await auth.logout()
  router.replace('/')
}
</script>

<template>
  <div class="selection-page">
    <div class="top-right-buttons">
      <span class="admin-email">{{ auth.user?.email }}</span>
      <router-link to="/admin/users" class="top-right-btn">👥 所有使用者管理</router-link>
      <router-link to="/admin/observation" class="top-right-btn">📈 使用數據觀察</router-link>
      <router-link to="/admin/agent-log" class="top-right-btn">🤖 AI 助手記錄</router-link>
      <button class="top-right-btn" @click="logout">🚪 登出</button>
    </div>

    <div class="selection-title">
      <h1>⛪ 教會服事班表系統</h1>
      <p>請選擇要編輯的班表</p>
    </div>

    <div v-if="loading" class="loading-message">載入中...</div>

    <div v-else class="collection-cards">
      <div v-for="serve in serves" :key="serve.id" class="collection-card" @click="openEditor(serve)">
        <div class="card-actions">
          <button class="card-action-btn" title="編輯" @click.stop="openEditModal(serve)">✏️</button>
          <button class="card-action-btn delete" title="刪除" @click.stop="openDeleteModal(serve)">
            🗑️
          </button>
        </div>
        <div class="icon">{{ serve.emoji }}</div>
        <div class="name">{{ serve.name }}</div>
      </div>

      <div v-if="serves.length < MAX_SERVES" class="collection-card add-card" @click="openAddModal">
        <div class="icon">➕</div>
        <div class="name">新增崇拜</div>
        <div class="description">最多 {{ MAX_SERVES }} 場</div>
      </div>
    </div>

    <!-- 新增 / 編輯崇拜 -->
    <BaseModal
      v-model="serveModalOpen"
      :title="editingId ? '編輯崇拜' : '新增崇拜'"
      max-width="450px"
    >
      <div class="form-group">
        <label>選擇 Emoji</label>
        <div class="emoji-picker">
          <button
            v-for="emoji in AVAILABLE_EMOJIS"
            :key="emoji"
            class="emoji-option"
            :class="{ selected: emoji === selectedEmoji }"
            @click="selectedEmoji = emoji"
          >
            {{ emoji }}
          </button>
        </div>
      </div>
      <div class="form-group">
        <label>崇拜名稱</label>
        <input
          v-model="nameInput"
          class="form-control"
          placeholder="例如：青年崇拜"
          maxlength="20"
          @keyup.enter="saveServe"
        />
      </div>
      <template #footer="{ close }">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button class="btn btn-primary" :disabled="busy" @click="saveServe">儲存</button>
      </template>
    </BaseModal>

    <!-- 刪除確認 -->
    <BaseModal v-model="deleteModalOpen" title="⚠️ 刪除崇拜" max-width="500px">
      <div class="warning-text">
        <strong>警告：此操作不可復原！</strong><br /><br />
        刪除後，該崇拜的所有班表資料、編輯記錄都將永久刪除。
      </div>
      <p>您即將刪除：<strong>{{ deleteTarget?.emoji }} {{ deleteTarget?.name }}</strong></p>
      <div class="form-group" style="margin-top: 16px">
        <label>請輸入崇拜名稱以確認刪除：</label>
        <input
          v-model="deleteConfirmInput"
          class="form-control"
          :placeholder="deleteTarget?.name"
        />
      </div>
      <template #footer="{ close }">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button
          class="btn btn-danger"
          :disabled="busy || deleteConfirmInput !== deleteTarget?.name"
          @click="confirmDelete"
        >
          確認刪除
        </button>
      </template>
    </BaseModal>
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
  position: relative;
}
.top-right-buttons {
  position: absolute;
  top: 24px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
}
.admin-email {
  font-size: 13px;
  color: var(--text-secondary);
}
.top-right-btn {
  padding: 10px 16px;
  background: white;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: 8px;
  transition: all 0.2s ease;
  box-shadow: var(--shadow-sm);
}
.top-right-btn:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
  box-shadow: var(--shadow-md);
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
  position: relative;
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
  margin-bottom: 8px;
}
.collection-card .description {
  font-size: 14px;
  color: var(--text-secondary);
}
.collection-card.add-card {
  border: 2px dashed var(--border-color);
  background: var(--bg-secondary);
}
.collection-card.add-card:hover {
  border-color: var(--primary-color);
}
.card-actions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.2s;
}
.collection-card:hover .card-actions {
  opacity: 1;
}
.card-action-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 50%;
  background: var(--bg-secondary);
  cursor: pointer;
  font-size: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
}
.card-action-btn:hover {
  background: var(--bg-hover);
}
.card-action-btn.delete:hover {
  background: #fee2e2;
  color: #dc2626;
}
.loading-message {
  text-align: center;
  color: var(--text-secondary);
  font-size: 16px;
}
.emoji-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
  margin-bottom: 16px;
}
.emoji-option {
  width: 48px;
  height: 48px;
  font-size: 28px;
  border: 2px solid var(--border-color);
  border-radius: 12px;
  background: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}
.emoji-option:hover {
  border-color: var(--primary-color);
  transform: scale(1.1);
}
.emoji-option.selected {
  border-color: var(--primary-color);
  background: var(--primary-light);
}
.warning-text {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
  color: #991b1b;
}
</style>
