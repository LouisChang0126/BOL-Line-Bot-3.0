<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const signingIn = ref(false)
const errorMsg = ref('')

const redirectTarget = computed(() => (route.query.redirect as string) || '/admin')
const deniedEmail = computed(() => (auth.user && !auth.isAdmin ? auth.user.email : ''))

onMounted(async () => {
  await auth.whenReady()
  if (auth.user && auth.isAdmin) router.replace(redirectTarget.value)
})

async function signIn() {
  signingIn.value = true
  errorMsg.value = ''
  try {
    await auth.signInWithGoogle()
    if (auth.isAdmin) {
      router.replace(redirectTarget.value)
    }
    // 若非管理員，畫面會自動顯示 deniedEmail 區塊
  } catch (e) {
    const code = (e as { code?: string })?.code
    if (code === 'auth/popup-closed-by-user') {
      errorMsg.value = '登入視窗被關閉，請再試一次'
    } else {
      errorMsg.value = e instanceof Error ? e.message : '登入失敗'
    }
  } finally {
    signingIn.value = false
  }
}

async function switchAccount() {
  await auth.logout()
  errorMsg.value = ''
}
</script>

<template>
  <div class="login-page">
    <div class="login-card">
      <div class="login-icon">⛪</div>
      <h1>教會服事班表系統</h1>
      <p class="login-subtitle">管理員登入</p>

      <template v-if="deniedEmail">
        <div class="login-denied">
          <strong>⚠️ 沒有管理權限</strong>
          <p>帳號 <b>{{ deniedEmail }}</b> 不在允許名單內。</p>
          <p class="login-hint">請聯絡系統管理員把你的 Google 帳號加入 <code>_config/admins</code>。</p>
        </div>
        <button class="btn btn-secondary login-btn" @click="switchAccount">換一個帳號登入</button>
      </template>

      <template v-else>
        <button class="btn btn-primary login-btn" :disabled="signingIn" @click="signIn">
          <span v-if="signingIn">登入中…</span>
          <span v-else>使用 Google 登入</span>
        </button>
        <p v-if="errorMsg" class="login-error">{{ errorMsg }}</p>
      </template>

      <router-link to="/" class="login-back">← 回到班表查看</router-link>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: var(--bg-secondary);
}
.login-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 40px 36px;
  width: 100%;
  max-width: 380px;
  text-align: center;
}
.login-icon {
  font-size: 56px;
  margin-bottom: 12px;
}
.login-card h1 {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.login-subtitle {
  color: var(--text-secondary);
  margin-bottom: 28px;
}
.login-btn {
  width: 100%;
  justify-content: center;
  padding: 12px;
  font-size: 15px;
}
.login-error {
  color: var(--danger-color);
  font-size: 13px;
  margin-top: 12px;
}
.login-denied {
  background: #fef2f2;
  border: 1px solid #fecaca;
  border-radius: var(--border-radius);
  padding: 16px;
  margin-bottom: 16px;
  color: #991b1b;
  text-align: left;
  font-size: 14px;
}
.login-denied p {
  margin-top: 6px;
}
.login-hint {
  color: #b45309;
  font-size: 12px;
}
.login-denied code {
  background: rgba(0, 0, 0, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
}
.login-back {
  display: inline-block;
  margin-top: 24px;
  color: var(--text-secondary);
  font-size: 13px;
  text-decoration: none;
}
.login-back:hover {
  color: var(--primary-color);
}
</style>
