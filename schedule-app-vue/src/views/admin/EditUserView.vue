<script setup lang="ts">
/**
 * 使用者管理頁（移植自舊版 edit-chart/edit-user.html）。
 *
 * 兩種模式：
 *  - 帶 ?collection=<id>：單一崇拜的使用者管理。讀該崇拜未來班表，擷取每個人被排到的
 *    服事，將名單分成「在此班表的人」與「其他使用者」，並提供「自動加入 / 更新服事」。
 *  - 無 collection：所有使用者管理。
 *
 * 需管理員登入（路由 meta.requiresAdmin）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import BaseModal from '@/components/common/BaseModal.vue'
import UserCard from '@/components/admin/UserCard.vue'
import EditUserModal from '@/components/admin/EditUserModal.vue'
import { useServesStore } from '@/stores/serves'
import { loadMetadata } from '@/services/schedule'
import {
  deleteUser as deleteUserDoc,
  generateLoginToken,
  loadAllUsers,
  loadSchedulePersonServes,
  saveUser,
  saveUsers,
} from '@/services/users'
import { createEmptyUser } from '@/types'
import type { UserDoc } from '@/types'

const route = useRoute()
const router = useRouter()
const servesStore = useServesStore()

const targetCollection = computed(() => (route.query.collection as string) || '')

const loading = ref(true)
const errorMsg = ref('')
const busy = ref(false)

// 資料
const allUsers = reactive<Record<string, UserDoc>>({})
/** 班表中每個人被排到的服事（僅 targetCollection 模式有值） */
const personServes = reactive<Record<string, string[]>>({})
/** 各崇拜 id → metadata.serviceItems（供編輯彈窗的下拉用） */
const serviceItemsByCollection = reactive<Record<string, string[]>>({})

// 崇拜 id → 顯示名稱
const serveNames = computed<Record<string, string>>(() => {
  const m: Record<string, string> = {}
  for (const s of servesStore.serves) m[s.id] = s.name
  return m
})
const collectionIds = computed(() => servesStore.serves.map((s) => s.id))

const pageTitle = computed(() => {
  if (!targetCollection.value) return '所有使用者管理'
  const name = serveNames.value[targetCollection.value] ?? targetCollection.value
  return `${name} 使用者管理`
})

// 搜尋
const searchTerm = ref('')

onMounted(async () => {
  try {
    await servesStore.ensureLoaded()

    if (targetCollection.value && !collectionIds.value.includes(targetCollection.value)) {
      errorMsg.value = `找不到崇拜「${targetCollection.value}」`
      return
    }

    // 載入每個崇拜的服事項目（編輯彈窗下拉用）
    await Promise.all(
      collectionIds.value.map(async (id) => {
        const meta = await loadMetadata(id)
        serviceItemsByCollection[id] = meta?.serviceItems ?? []
      }),
    )

    // 班表中的人 + 服事（僅單一崇拜模式）
    if (targetCollection.value) {
      const ps = await loadSchedulePersonServes(targetCollection.value)
      for (const [name, serves] of Object.entries(ps)) personServes[name] = serves
    }

    // 所有使用者
    const users = await loadAllUsers()
    for (const [name, data] of Object.entries(users)) allUsers[name] = data
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e)
    console.error('[EditUserView] 載入失敗:', e)
  } finally {
    loading.value = false
  }
})

// ── 名單計算 ─────────────────────────────────────────────────
/** 是否需要處理（新使用者，或班表有未登記服事） */
function needsUpdate(name: string): boolean {
  const u = allUsers[name]
  if (!u) return true
  if (!targetCollection.value) return false
  const registered = u.serve_types?.[targetCollection.value] ?? []
  return (personServes[name] ?? []).some((s) => !registered.includes(s))
}

const filteredNames = computed(() => {
  const names = new Set<string>([...Object.keys(personServes), ...Object.keys(allUsers)])
  let arr = Array.from(names)
  const term = searchTerm.value.trim().toLowerCase()
  if (term) arr = arr.filter((n) => n.toLowerCase().includes(term))
  arr.sort((a, b) => a.localeCompare(b, 'zh-TW'))
  return arr
})

const inScheduleNames = computed(() =>
  targetCollection.value ? filteredNames.value.filter((n) => n in personServes) : [],
)
const otherNames = computed(() =>
  targetCollection.value
    ? filteredNames.value.filter((n) => !(n in personServes))
    : filteredNames.value,
)

const totalCount = computed(() => filteredNames.value.length)
const pendingCount = computed(() => filteredNames.value.filter((n) => needsUpdate(n)).length)

function isInSchedule(name: string): boolean {
  return name in personServes
}

// ── 返回鍵 ───────────────────────────────────────────────────
function goBack() {
  if (targetCollection.value) {
    router.push({ name: 'editor', query: { collection: targetCollection.value } })
  } else {
    router.push('/admin')
  }
}

// ── 新增使用者 ───────────────────────────────────────────────
const addModalOpen = ref(false)
const newUserName = ref('')

function openAddModal() {
  newUserName.value = ''
  addModalOpen.value = true
}

async function confirmAddUser() {
  const name = newUserName.value.trim()
  if (!name) return alert('請輸入使用者名稱')
  if (allUsers[name]) return alert('此使用者已存在')

  busy.value = true
  try {
    const data = createEmptyUser()
    data.login_token = generateLoginToken()
    await saveUser(name, data)
    allUsers[name] = data
    addModalOpen.value = false
    openEditModal(name)
  } catch (e) {
    alert('新增失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

// ── 編輯使用者 ───────────────────────────────────────────────
const editModalOpen = ref(false)
const editName = ref('')
const editUser = ref<UserDoc | null>(null)

function openEditModal(name: string) {
  editName.value = name
  const existing = allUsers[name]
  if (existing) {
    editUser.value = existing
  } else {
    // 班表中但尚未建立的使用者：帶入班表服事 + 產生邀請碼（儲存時才寫入）
    const seeded = createEmptyUser()
    seeded.login_token = generateLoginToken()
    if (targetCollection.value && personServes[name]?.length) {
      seeded.serve_types[targetCollection.value] = [...personServes[name]]
    }
    editUser.value = seeded
  }
  editModalOpen.value = true
}

async function onSaveUser(name: string, data: UserDoc) {
  busy.value = true
  try {
    await saveUser(name, data)
    allUsers[name] = data
    editModalOpen.value = false
  } catch (e) {
    alert('儲存失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

// ── 刪除使用者（BaseModal 確認） ─────────────────────────────
const deleteModalOpen = ref(false)
const deleteTarget = ref('')

function onRequestDelete(name: string) {
  deleteTarget.value = name
  deleteModalOpen.value = true
}

async function confirmDelete() {
  const name = deleteTarget.value
  if (!name) return
  busy.value = true
  try {
    await deleteUserDoc(name)
    delete allUsers[name]
    deleteModalOpen.value = false
    editModalOpen.value = false
  } catch (e) {
    alert('刪除失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

// ── 自動加入 & 更新服事（BaseModal 確認） ───────────────────
const autoModalOpen = ref(false)
const autoNewNames = ref<string[]>([])
const autoUpdateNames = ref<string[]>([])

function openAutoAdd() {
  const col = targetCollection.value
  if (!col) return
  const toProcess = Object.keys(personServes).filter((name) => needsUpdate(name))
  if (toProcess.length === 0) {
    alert('沒有需要處理的使用者！')
    return
  }
  autoNewNames.value = toProcess.filter((n) => !allUsers[n])
  autoUpdateNames.value = toProcess.filter((n) => allUsers[n])
  autoModalOpen.value = true
}

async function confirmAutoAdd() {
  const col = targetCollection.value
  if (!col) return
  busy.value = true
  try {
    const updates: Record<string, UserDoc> = {}
    for (const name of [...autoNewNames.value, ...autoUpdateNames.value]) {
      const scheduled = personServes[name] ?? []
      const existing = allUsers[name]
      let data: UserDoc
      if (!existing) {
        data = createEmptyUser()
        data.login_token = generateLoginToken()
        data.serve_types[col] = [...scheduled]
      } else {
        const merged = Array.from(new Set([...(existing.serve_types?.[col] ?? []), ...scheduled]))
        data = {
          ...existing,
          serve_types: { ...(existing.serve_types ?? {}), [col]: merged },
        }
      }
      updates[name] = data
    }
    await saveUsers(updates)
    for (const [name, data] of Object.entries(updates)) allUsers[name] = data
    autoModalOpen.value = false
    alert(`處理完成！\n- 新增 ${autoNewNames.value.length} 位\n- 更新 ${autoUpdateNames.value.length} 位`)
  } catch (e) {
    alert('處理失敗：' + (e instanceof Error ? e.message : e))
  } finally {
    busy.value = false
  }
}

// ── 匯出 CSV ─────────────────────────────────────────────────
function exportCsv() {
  const entries = Object.entries(allUsers)
  if (entries.length === 0) {
    alert('沒有使用者資料可以匯出')
    return
  }
  let csv = '﻿' // BOM
  csv += '使用者名稱,邀請碼,已綁定LINE\n'
  for (const [name, data] of entries) {
    const token = data.login_token || ''
    const hasLine = data.lineId ? '是' : '否'
    csv += `"${name}","${token}","${hasLine}"\n`
  }
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `使用者邀請碼_${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

// ── 複製邀請碼 ───────────────────────────────────────────────
async function copyToken(token: string) {
  try {
    await navigator.clipboard.writeText(token)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = token
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
}
</script>

<template>
  <div class="admin-page">
    <div class="page-header">
      <button class="btn btn-secondary back-btn" @click="goBack">← 返回</button>
      <h1>👥 {{ pageTitle }}</h1>
    </div>

    <div v-if="errorMsg" class="error-box">
      <div class="error-icon">⚠️</div>
      <h2>錯誤</h2>
      <p>{{ errorMsg }}</p>
      <button class="btn btn-primary" @click="router.push('/admin')">回崇拜選擇</button>
    </div>

    <template v-else>
      <!-- 快速操作區 -->
      <div class="quick-actions">
        <button
          v-if="targetCollection"
          class="btn btn-primary"
          :disabled="busy"
          @click="openAutoAdd"
        >
          🔄 自動加入使用者
        </button>
        <button class="btn btn-secondary" @click="exportCsv">📥 匯出邀請碼 Excel</button>
        <input v-model="searchTerm" class="search-box" placeholder="搜尋使用者..." />
        <div class="stats-info">
          <span>總計 <strong>{{ totalCount }}</strong> 位使用者</span>
          <span>待處理 <strong>{{ pendingCount }}</strong> 位</span>
        </div>
      </div>

      <div v-if="loading" class="loading-message">載入中...</div>

      <!-- 使用者列表 -->
      <div v-else class="user-list">
        <!-- 單一崇拜模式：分兩區 -->
        <template v-if="targetCollection">
          <div class="section-title">
            📋 {{ serveNames[targetCollection] ?? targetCollection }}（{{ inScheduleNames.length }} 人）
          </div>
          <div class="user-card add-user-card" @click="openAddModal">➕ 手動新增使用者</div>
          <UserCard
            v-for="name in inScheduleNames"
            :key="name"
            :name="name"
            :user="allUsers[name] ?? null"
            :collection="targetCollection"
            :serve-names="serveNames"
            :scheduled-serves="personServes[name] ?? []"
            :in-schedule="true"
            @edit="openEditModal(name)"
            @copy="copyToken"
          />

          <template v-if="otherNames.length">
            <div class="section-title section-title-other">
              👤 其他使用者（{{ otherNames.length }} 人）
            </div>
            <UserCard
              v-for="name in otherNames"
              :key="name"
              :name="name"
              :user="allUsers[name] ?? null"
              :collection="targetCollection"
              :serve-names="serveNames"
              :scheduled-serves="personServes[name] ?? []"
              :in-schedule="false"
              @edit="openEditModal(name)"
              @copy="copyToken"
            />
          </template>
        </template>

        <!-- 所有使用者模式：不分區 -->
        <template v-else>
          <div class="user-card add-user-card" @click="openAddModal">➕ 手動新增使用者</div>
          <UserCard
            v-for="name in otherNames"
            :key="name"
            :name="name"
            :user="allUsers[name] ?? null"
            :collection="''"
            :serve-names="serveNames"
            :scheduled-serves="[]"
            :in-schedule="false"
            @edit="openEditModal(name)"
            @copy="copyToken"
          />
        </template>

        <div v-if="totalCount === 0" class="empty-hint">沒有找到使用者</div>
      </div>
    </template>

    <!-- 新增使用者 Modal -->
    <BaseModal v-model="addModalOpen" title="新增使用者" max-width="400px">
      <div class="form-group">
        <label>使用者名稱</label>
        <input
          v-model="newUserName"
          class="form-control"
          placeholder="請輸入使用者名稱"
          maxlength="10"
          @keyup.enter="confirmAddUser"
        />
      </div>
      <template #footer="{ close }">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button class="btn btn-primary" :disabled="busy" @click="confirmAddUser">新增</button>
      </template>
    </BaseModal>

    <!-- 編輯使用者 Modal -->
    <EditUserModal
      v-model="editModalOpen"
      :name="editName"
      :user="editUser"
      :collection="targetCollection"
      :collection-ids="collectionIds"
      :serve-names="serveNames"
      :service-items-by-collection="serviceItemsByCollection"
      @save="onSaveUser"
      @delete="onRequestDelete"
    />

    <!-- 刪除確認 -->
    <BaseModal v-model="deleteModalOpen" title="確認刪除" max-width="400px">
      <p style="margin: 0; line-height: 1.5">
        確定要刪除使用者「<strong>{{ deleteTarget }}</strong>」嗎？
      </p>
      <template #footer="{ close }">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button class="btn btn-danger" :disabled="busy" @click="confirmDelete">確認刪除</button>
      </template>
    </BaseModal>

    <!-- 自動加入確認 -->
    <BaseModal v-model="autoModalOpen" title="確認操作" max-width="400px">
      <p style="margin: 0; line-height: 1.6">
        即將處理 {{ autoNewNames.length + autoUpdateNames.length }} 位使用者：
      </p>
      <ul style="margin: 8px 0 0; padding-left: 20px; line-height: 1.6">
        <li v-if="autoNewNames.length">新增 {{ autoNewNames.length }} 位</li>
        <li v-if="autoUpdateNames.length">更新 {{ autoUpdateNames.length }} 位</li>
      </ul>
      <p style="margin: 12px 0 0">確定要執行嗎？</p>
      <template #footer="{ close }">
        <button class="btn btn-secondary" @click="close">取消</button>
        <button class="btn btn-primary" :disabled="busy" @click="confirmAutoAdd">確認</button>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.admin-page {
  max-width: 1400px;
  margin: 0 auto;
  padding: 32px;
}
.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
}
.page-header h1 {
  font-size: 28px;
  font-weight: 700;
}
.back-btn {
  padding: 6px 12px;
}

.search-box {
  padding: 10px 16px;
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  font-size: 14px;
  width: 250px;
}
.search-box:focus {
  outline: none;
  border-color: var(--primary-color);
  box-shadow: 0 0 0 3px var(--primary-light);
}

.loading-message,
.empty-hint {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
}
.empty-hint {
  grid-column: 1 / -1;
}

.section-title {
  grid-column: 1 / -1;
  padding: 12px 0 4px 4px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}
.section-title-other {
  padding: 20px 0 4px 4px;
  color: var(--text-secondary);
  border-top: 1px solid var(--border-color);
  margin-top: 12px;
}

/* 新增使用者卡片 */
.add-user-card {
  border: 2px dashed var(--border-color);
  background: var(--bg-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100px;
  font-size: 16px;
  color: var(--text-secondary);
}
.add-user-card:hover {
  border-color: var(--primary-color);
  color: var(--primary-color);
}

.error-box {
  text-align: center;
  padding: 60px;
}
.error-icon {
  font-size: 48px;
  margin-bottom: 16px;
}
.error-box h2 {
  color: #dc2626;
  margin-bottom: 8px;
}
.error-box p {
  color: var(--text-secondary);
  margin-bottom: 24px;
}
</style>
