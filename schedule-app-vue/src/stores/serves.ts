/** 崇拜清單快取（多個頁面共用，避免重複讀取 `_config/serve-list`） */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { loadServeList, saveServeList } from '@/services/serves'
import type { Serve } from '@/types'

export const useServesStore = defineStore('serves', () => {
  const serves = ref<Serve[]>([])
  const loaded = ref(false)

  async function ensureLoaded(force = false): Promise<Serve[]> {
    if (loaded.value && !force) return serves.value
    serves.value = await loadServeList()
    loaded.value = true
    return serves.value
  }

  async function save(next: Serve[]): Promise<void> {
    await saveServeList(next)
    serves.value = next
    loaded.value = true
  }

  return { serves, loaded, ensureLoaded, save }
})
