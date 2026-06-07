<script setup lang="ts">
/** 大眾 Landing 頁 —— 無 ?user= 時於 `/` 顯示（新需求）。 */
import { useRouter } from 'vue-router'

const router = useRouter()
</script>

<template>
  <div class="landing">
    <header class="landing-hero">
      <div class="landing-emoji">⛪</div>
      <h1>教會服事班表系統</h1>
      <p class="landing-tagline">讓服事安排更清楚、更輕鬆</p>
    </header>

    <section class="landing-cards">
      <article class="landing-card">
        <div class="landing-card-icon">📖</div>
        <h2>查看我的班表</h2>
        <p>
          透過 LINE Bot 取得你的<strong>專屬連結</strong>，即可隨時查看自己負責的服事，
          並自動標示你的名字。
        </p>
        <p class="landing-card-hint">已有專屬連結？直接開啟即可。</p>
      </article>

      <article class="landing-card">
        <div class="landing-card-icon">✏️</div>
        <h2>管理班表</h2>
        <p>管理員可編輯班表、管理服事人員、使用 AI 協助排班，並查看使用數據。</p>
        <button class="btn btn-primary landing-btn" @click="router.push('/admin')">
          管理員登入
        </button>
      </article>
    </section>

    <footer class="landing-footer">Made with ❤️ for Church Ministry</footer>
  </div>
</template>

<style scoped>
.landing {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 24px;
  background: linear-gradient(180deg, var(--bg-primary) 0%, var(--bg-secondary) 100%);
}
.landing-hero {
  text-align: center;
  margin-bottom: 48px;
}
.landing-emoji {
  font-size: 72px;
  margin-bottom: 12px;
}
.landing-hero h1 {
  font-size: 36px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.landing-tagline {
  font-size: 17px;
  color: var(--text-secondary);
}
.landing-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 24px;
  justify-content: center;
  max-width: 760px;
  width: 100%;
}
.landing-card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius-lg);
  box-shadow: var(--shadow-md);
  padding: 32px;
  flex: 1 1 300px;
  max-width: 360px;
  text-align: center;
}
.landing-card-icon {
  font-size: 44px;
  margin-bottom: 12px;
}
.landing-card h2 {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--text-primary);
}
.landing-card p {
  color: var(--text-secondary);
  line-height: 1.7;
  font-size: 14px;
}
.landing-card-hint {
  margin-top: 10px;
  font-size: 13px;
  color: var(--text-light);
}
.landing-btn {
  margin-top: 20px;
  width: 100%;
  justify-content: center;
}
.landing-footer {
  margin-top: 56px;
  color: var(--text-light);
  font-size: 13px;
}
</style>
