<script setup lang="ts">
/**
 * 可重用的 Chart.js 包裝元件。
 *
 * 負責 Chart.js 的生命週期：onMounted 建立、onBeforeUnmount 銷毀、
 * 當 `type` / `data` / `options` 任一改變時銷毀重建，避免 canvas 重用造成的記憶體洩漏。
 * 使用方式：把整理好的 ChartConfiguration 三個欄位以 props 傳入即可。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Chart, registerables } from 'chart.js'
import type { ChartData, ChartOptions, ChartType } from 'chart.js'

// 只需註冊一次（重複呼叫無害，Chart.js 內部會去重）
Chart.register(...registerables)

const props = defineProps<{
  type: ChartType
  data: ChartData
  options?: ChartOptions
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: Chart | null = null

function destroy() {
  if (chart) {
    chart.destroy()
    chart = null
  }
}

function render() {
  destroy()
  const canvas = canvasEl.value
  if (!canvas) return
  chart = new Chart(canvas, {
    type: props.type,
    // 以淺拷貝餵給 Chart.js，避免它在內部直接改動到 Vue 的 reactive 物件
    data: props.data,
    options: props.options,
  })
}

onMounted(render)
onBeforeUnmount(destroy)

// 任何一項設定改變都重建圖表（deep 監看 data / options 內容變化）
watch(
  () => [props.type, props.data, props.options],
  () => render(),
  { deep: true },
)
</script>

<template>
  <canvas ref="canvasEl"></canvas>
</template>
