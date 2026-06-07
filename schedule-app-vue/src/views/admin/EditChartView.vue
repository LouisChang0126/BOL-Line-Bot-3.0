<script setup lang="ts">
/**
 * 班表編輯器主頁（舊版 edit-chart.html + app.js/ui.js/agent.js 的整合殼層）。
 * 需管理員登入（路由 meta.requiresAdmin）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEditorStore } from '@/stores/editor'
import { useAgentStore } from '@/stores/agent'
import { useServesStore } from '@/stores/serves'
import ScheduleTable from '@/components/editor/ScheduleTable.vue'
import EditPersonModal from '@/components/editor/EditPersonModal.vue'
import EditServiceModal from '@/components/editor/EditServiceModal.vue'
import AddColumnModal from '@/components/editor/AddColumnModal.vue'
import DisplayConfigModal from '@/components/editor/DisplayConfigModal.vue'
import AgentSidebar from '@/components/editor/AgentSidebar.vue'

const route = useRoute()
const router = useRouter()
const editor = useEditorStore()
const agent = useAgentStore()
const servesStore = useServesStore()

const collection = computed(() => (route.query.collection as string) || '')
const loadError = ref('')
const title = ref('教會服事班表')
const emoji = ref('⛪')

const editPerson = ref<{ open: boolean; date: string; service: string }>({ open: false, date: '', service: '' })
const editService = ref<{ open: boolean; name: string }>({ open: false, name: '' })
const addColumnOpen = ref(false)
const displayConfigOpen = ref(false)
const sidebarOpen = ref(false)

onMounted(async () => {
  if (!collection.value) {
    loadError.value = '無效的班表名稱（未指定 collection）'
    return
  }
  try {
    await servesStore.ensureLoaded()
    const serve = servesStore.serves.find((s) => s.id === collection.value)
    if (!serve) {
      loadError.value = `找不到班表：${collection.value}`
      return
    }
    emoji.value = serve.emoji || '⛪'
    title.value = `${serve.name}班表`
    document.title = `${serve.name}班表 - 教會服事班表系統`
    await editor.load(collection.value)
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '載入失敗'
  }
  window.addEventListener('beforeunload', onUnload)
  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onUnload)
  window.removeEventListener('keydown', onKeydown)
  editor.flushOnLeave()
})

function onUnload() {
  editor.flushOnLeave()
}

function onKeydown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.ctrlKey && e.key === 'z') {
    e.preventDefault()
    void editor.undo()
  } else if (e.ctrlKey && e.key === 'y') {
    e.preventDefault()
    void editor.redo()
  }
}

function onEditPerson(date: string, service: string) {
  editPerson.value = { open: true, date, service }
}
function onEditService(name: string) {
  editService.value = { open: true, name }
}

async function goRecords() {
  await editor.saveEditLog()
  router.push({ name: 'difference', query: { collection: collection.value } })
}
async function goUsers() {
  await editor.saveEditLog()
  router.push({ name: 'users', query: { collection: collection.value } })
}
async function goBack() {
  await editor.saveEditLog()
  router.push('/admin')
}

function reclaim() {
  editor.reclaimTabLock()
  window.location.reload()
}
</script>

<template>
  <div v-if="loadError" class="editor-error">
    <h1>⚠️</h1>
    <h2>{{ loadError }}</h2>
    <router-link to="/admin" class="btn btn-primary">返回選擇頁面</router-link>
  </div>

  <div v-else class="agent-layout">
    <div class="agent-main">
      <div class="app-container">
        <!-- 頂部控制 -->
        <div class="header-section">
          <div class="app-title">
            <button class="btn btn-secondary back-btn" @click="goBack">← 返回</button>
            <h1><span>{{ emoji }}</span> {{ title }}</h1>
          </div>
          <div class="control-actions">
            <button class="btn btn-secondary" @click="editor.togglePast()">
              {{ editor.showingPast ? '📅 隱藏歷史' : '📅 顯示歷史' }}
            </button>
            <div class="btn-group">
              <button class="btn btn-secondary" :disabled="!editor.canUndo" title="上一步 (Ctrl+Z)" @click="editor.undo()">↩️</button>
              <button class="btn btn-secondary" :disabled="!editor.canRedo" title="下一步 (Ctrl+Y)" @click="editor.redo()">↪️</button>
            </div>
            <button class="btn btn-secondary" @click="addColumnOpen = true">✨ 新增服事/資訊</button>
            <button class="btn btn-secondary" @click="displayConfigOpen = true">📊 編輯顯示欄位</button>
            <button class="btn btn-secondary" @click="goRecords">📜 編輯記錄</button>
            <button class="btn btn-secondary" @click="editor.exportExcel(title)">📥 匯出 Excel</button>
            <button class="btn btn-secondary btn-with-badge" @click="goUsers">
              👥 管理使用者
              <span v-if="editor.userAlert" class="badge-alert">!</span>
            </button>
            <button class="btn btn-secondary" title="開關 AI 側邊欄" @click="sidebarOpen = !sidebarOpen">🤖 AI助手</button>
          </div>
          <div class="status-indicator">
            <span class="text-muted">{{ editor.status }}</span>
          </div>
        </div>

        <!-- AI 審核列 -->
        <div v-if="agent.hasPending" class="agent-review-bar">
          <span class="agent-review-label">🤖 Agent 提案審核中</span>
          <div class="agent-review-actions">
            <button class="btn btn-success btn-sm" @click="agent.acceptAll()">✅ 全部接受</button>
            <button class="btn btn-danger btn-sm" @click="agent.rejectAll()">❌ 全部拒絕</button>
          </div>
        </div>

        <ScheduleTable @edit-person="onEditPerson" @edit-service="onEditService" />
      </div>
    </div>

    <AgentSidebar :open="sidebarOpen" @close="sidebarOpen = false" />

    <!-- Modals -->
    <EditPersonModal
      v-model="editPerson.open"
      :date="editPerson.date"
      :service="editPerson.service"
    />
    <EditServiceModal v-model="editService.open" :service-name="editService.name" />
    <AddColumnModal v-model="addColumnOpen" />
    <DisplayConfigModal v-model="displayConfigOpen" />

    <!-- 分頁鎖遮罩 -->
    <div v-if="editor.isLocked" class="tab-lock-overlay">
      <div class="tab-lock-modal">
        <div class="tab-lock-icon">🔒</div>
        <h2>你已在其他分頁開啟編輯</h2>
        <p>為避免資料衝突，同時間只能有一個分頁進行編輯</p>
        <div class="tab-lock-btns">
          <button class="btn btn-secondary" @click="router.push('/admin')">離開此頁</button>
          <button class="btn btn-primary" @click="reclaim">在此分頁繼續編輯</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.agent-layout {
  display: flex;
  min-height: 100vh;
}
.agent-main {
  flex: 1;
  min-width: 0;
  overflow-x: hidden;
}
.app-container {
  padding: 20px 24px 60px;
}
.header-section {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.app-title {
  display: flex;
  align-items: center;
  gap: 12px;
}
.app-title h1 {
  font-size: 24px;
  font-weight: 700;
}
.back-btn {
  padding: 6px 12px;
}
.control-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-left: auto;
}
.btn-group {
  display: inline-flex;
}
.btn-group .btn {
  border-radius: 0;
}
.btn-group .btn:first-child {
  border-radius: var(--border-radius) 0 0 var(--border-radius);
}
.btn-group .btn:last-child {
  border-radius: 0 var(--border-radius) var(--border-radius) 0;
}
.btn-with-badge {
  position: relative;
}
.badge-alert {
  position: absolute;
  top: -6px;
  right: -6px;
  background: var(--danger-color);
  color: #fff;
  border-radius: 50%;
  width: 18px;
  height: 18px;
  font-size: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.status-indicator {
  width: 100%;
  font-size: 13px;
}
.agent-review-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 16px;
  margin-bottom: 12px;
}
.btn-sm {
  padding: 5px 12px;
  font-size: 13px;
}
.btn-success {
  background: #16a34a;
  color: #fff;
}
.editor-error {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  text-align: center;
}
.editor-error h1 {
  font-size: 48px;
}
.editor-error h2 {
  color: var(--danger-color);
}
.tab-lock-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}
.tab-lock-modal {
  background: #fff;
  border-radius: 16px;
  padding: 40px;
  text-align: center;
  max-width: 400px;
}
.tab-lock-icon {
  font-size: 48px;
}
.tab-lock-modal h2 {
  margin: 12px 0 8px;
}
.tab-lock-modal p {
  color: var(--text-secondary);
  margin-bottom: 24px;
}
.tab-lock-btns {
  display: flex;
  gap: 12px;
  justify-content: center;
}
</style>
