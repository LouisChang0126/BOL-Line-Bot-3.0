<script setup lang="ts">
/**
 * 公開端首頁分派器：
 *   - 有 ?user=名字 → 顯示個人班表選擇（相容 LINE bot 的 /?user= 連結）
 *   - 無 ?user=     → 顯示大眾 landing 頁
 */
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import LandingView from './LandingView.vue'
import PublicSelectView from './PublicSelectView.vue'

const route = useRoute()
const userName = computed(() => {
  const u = route.query.user
  return (Array.isArray(u) ? u[0] : u) || ''
})
</script>

<template>
  <PublicSelectView v-if="userName" :key="userName" :user-name="userName" />
  <LandingView v-else />
</template>
