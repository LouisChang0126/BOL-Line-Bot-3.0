import { ref, shallowRef } from 'vue'

/**
 * 統一的非同步載入狀態管理（loading / error / data）。
 * 讓每個資料頁不必各自重寫 try/catch + loading 旗標。
 *
 * @example
 * const { data, loading, error, run } = useAsyncData(() => loadServeList())
 * onMounted(run)
 */
export function useAsyncData<T>(loader: () => Promise<T>) {
  const data = shallowRef<T | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  async function run(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      data.value = await loader()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      console.error('[useAsyncData]', e)
    } finally {
      loading.value = false
    }
  }

  return { data, loading, error, run }
}
