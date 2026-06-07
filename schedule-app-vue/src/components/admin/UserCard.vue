<script setup lang="ts">
/**
 * 使用者卡片 —— 顯示單一使用者的名稱、狀態徽章、服事標籤與邀請碼按鈕。
 * 對應舊版 edit-user.html 的 renderUserCard。樣式沿用全域 styles.css 的 .user-card / .user-card-badge / .serve-tag。
 */
import { ref } from 'vue'
import type { UserDoc } from '@/types'

const props = defineProps<{
  /** 使用者名稱（= doc id） */
  name: string
  /** 使用者資料；不存在（新使用者，僅出現在班表）時為 null */
  user: UserDoc | null
  /** 目前鎖定的崇拜 id；無（所有使用者管理）時為空字串 */
  collection: string
  /** 各崇拜 id → 顯示名稱 */
  serveNames: Record<string, string>
  /** 此人在班表中被排到的服事（僅有 collection 時有意義） */
  scheduledServes: string[]
  /** 是否在目前崇拜班表中 */
  inSchedule: boolean
}>()

const emit = defineEmits<{ edit: []; copy: [token: string] }>()

const copied = ref(false)

/** 此卡是否要高亮（新使用者或服事需更新） */
function isHighlighted(): boolean {
  const user = props.user
  if (!user) return true
  const col = props.collection
  if (!col) return false
  const registered = user.serve_types?.[col] ?? []
  return props.scheduledServes.some((s) => !registered.includes(s))
}

/** 目前崇拜的服事標籤（有 collection 時） */
function currentServes(): string[] {
  const user = props.user
  if (!user || !props.collection) return []
  return user.serve_types?.[props.collection] ?? []
}

/** 缺少的服事（在班表中但未登記） */
function missingServes(): string[] {
  const user = props.user
  if (!user || !props.collection || !props.inSchedule) return []
  const registered = user.serve_types?.[props.collection] ?? []
  return props.scheduledServes.filter((s) => !registered.includes(s))
}

/** 也在其他崇拜服事的崇拜名稱（有 collection 時） */
function otherServeNames(): string[] {
  const user = props.user
  const col = props.collection
  if (!user || !col) return []
  return Object.keys(user.serve_types ?? {})
    .filter((c) => c !== col && (user.serve_types[c]?.length ?? 0) > 0)
    .map((c) => props.serveNames[c] ?? c)
}

/** 所有崇拜的服事分組（無 collection 時） */
function allServeGroups(): Array<{ name: string; items: string[] }> {
  const user = props.user
  if (!user || props.collection) return []
  return Object.entries(user.serve_types ?? {})
    .filter(([, items]) => items && items.length > 0)
    .map(([c, items]) => ({ name: props.serveNames[c] ?? c, items }))
}

async function onCopy() {
  const token = props.user?.login_token
  if (!token) return
  emit('copy', token)
  copied.value = true
  setTimeout(() => (copied.value = false), 2000)
}
</script>

<template>
  <div class="user-card" :class="{ 'new-user': isHighlighted() }" @click="emit('edit')">
    <div class="user-card-header">
      <span class="user-card-name">{{ name }}</span>
      <span v-if="!user" class="user-card-badge new">新</span>
      <span v-else-if="isHighlighted()" class="user-card-badge new">需更新</span>
      <span v-if="user && user.lineId" class="user-card-badge linked">已綁定 LINE</span>
      <button
        v-if="user && !user.lineId && user.login_token"
        class="copy-invite-btn"
        :class="{ copied }"
        type="button"
        @click.stop="onCopy"
      >
        {{ copied ? '✅ 已複製！' : '📋 複製邀請碼' }}
      </button>
    </div>

    <div class="user-card-body">
      <div v-if="collection && inSchedule">📋 在此崇拜班表中</div>

      <!-- 有 collection：顯示目前崇拜的服事 -->
      <div v-if="currentServes().length" class="user-card-serve">
        <span v-for="s in currentServes()" :key="s" class="serve-tag">{{ s }}</span>
      </div>

      <!-- 無 collection：依崇拜分組顯示所有服事 -->
      <div
        v-for="grp in allServeGroups()"
        :key="grp.name"
        class="user-card-serve serve-group-row"
      >
        <span class="serve-group-label">{{ grp.name }}:</span>
        <span v-for="s in grp.items" :key="s" class="serve-tag">{{ s }}</span>
      </div>

      <div v-if="missingServes().length" class="missing-serves">
        缺少：{{ missingServes().join('、') }}
      </div>
      <div v-if="otherServeNames().length" class="other-serves">
        也在：{{ otherServeNames().join('、') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.serve-group-row {
  align-items: center;
}
.serve-group-label {
  font-size: 11px;
  color: var(--text-secondary);
}
.missing-serves {
  margin-top: 4px;
  font-size: 11px;
  color: #f97316;
}
.other-serves {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-light);
}

/* 複製邀請碼按鈕 - badge 樣式（沿用舊版 edit-user.html） */
.copy-invite-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  background: #fef3c7;
  border: 1px solid #fcd34d;
  border-radius: 12px;
  font-size: 11px;
  color: #92400e;
  cursor: pointer;
  transition: all 0.2s;
  font-weight: 500;
}
.copy-invite-btn:hover {
  background: #fde68a;
  border-color: #f59e0b;
}
.copy-invite-btn.copied {
  background: #d1fae5;
  border-color: #34d399;
  color: #065f46;
}
</style>
