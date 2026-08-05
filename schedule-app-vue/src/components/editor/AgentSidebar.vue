<script setup lang="ts">
/** AI 助手側邊欄（舊版 agent.js 的 UI）：模式、規則、參考/生成範圍、請假、對話、送出。 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import * as XLSX from 'xlsx'
import { useAgentStore } from '@/stores/agent'
import { LLM_TARGETS, type LlmTarget } from '@/utils/outsource'
import LlmIcon from './LlmIcon.vue'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const agent = useAgentStore()
const prompt = ref('')

// ── 拖曳調整寬度（對應舊版 agent.js setupResizer）────────
const DEFAULT_WIDTH = 380
const MIN_WIDTH = 200
/** 側邊欄寬度（px）；收合時由 CSS 的 .collapsed 覆蓋，不吃這個值 */
const width = ref(DEFAULT_WIDTH)
const resizing = ref(false)
let startX = 0
let startWidth = 0

function startResize(e: MouseEvent) {
  if (!props.open) return
  resizing.value = true
  startX = e.clientX
  startWidth = width.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onResizeMove)
  document.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

function onResizeMove(e: MouseEvent) {
  if (!resizing.value) return
  // 分隔線在側邊欄左側：游標往左移 = 變寬
  const raw = startWidth + (startX - e.clientX)
  if (raw < MIN_WIDTH) {
    // 與舊版一致：拖得比最小寬度還窄就直接收合側邊欄
    stopResize()
    emit('close')
    return
  }
  width.value = Math.min(raw, window.innerWidth * 0.4)
}

function stopResize() {
  if (!resizing.value) return
  resizing.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onResizeMove)
  document.removeEventListener('mouseup', stopResize)
}

// 元件卸載時務必還原 body 樣式並移除全域監聽，否則游標會卡在 col-resize
onBeforeUnmount(stopResize)
const chatArea = ref<HTMLElement | null>(null)
const rulesOpen = ref(true)
const refOpen = ref(true)
const leaveOpen = ref(false)

/** end 選項需 ≥ start */
function endOptions(candidates: string[], start: string): string[] {
  if (!start) return candidates
  return candidates.filter((d) => d >= start)
}
function startOptions(candidates: string[], end: string): string[] {
  if (!end) return candidates
  return candidates.filter((d) => d <= end)
}

const refStartOpts = computed(() => startOptions(agent.refCandidates, agent.refEnd))
const refEndOpts = computed(() => endOptions(agent.refCandidates, agent.refStart))
const genStartOpts = computed(() => startOptions(agent.genCandidates, agent.genEnd))
const genEndOpts = computed(() => endOptions(agent.genCandidates, agent.genStart))

async function scrollChat() {
  await nextTick()
  if (chatArea.value) chatArea.value.scrollTop = chatArea.value.scrollHeight
}
watch(() => agent.messages.length, scrollChat)
watch(() => agent.isLoading, scrollChat)
watch(() => agent.progressElapsedSec, scrollChat)

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`
}

async function onSend() {
  const p = prompt.value
  prompt.value = ''
  await agent.send(p)
}

// ── 排班外包 ────────────────────────────────────────────
const replyText = ref('')
const outsourceBusy = ref(false)

/** 複製提示詞並開啟該 LLM 的網頁（無法自動貼上，需使用者自行 Ctrl+V） */
async function onOpenLlm(target: LlmTarget) {
  if (outsourceBusy.value) return
  outsourceBusy.value = true
  try {
    await agent.openLlmWithPrompt(target, prompt.value)
  } finally {
    outsourceBusy.value = false
  }
}

/** 只複製提示詞，不開網頁 */
async function onCopyPrompt() {
  if (outsourceBusy.value) return
  outsourceBusy.value = true
  try {
    const len = await agent.copyOutsourcePrompt(prompt.value)
    if (len !== null) {
      agent.addMessage(`已複製提示詞（${len.toLocaleString()} 字）到剪貼簿。`, 'assistant')
    }
  } finally {
    outsourceBusy.value = false
  }
}

/** 套用貼回來的 AI 回覆 */
function onApplyReply() {
  if (agent.applyOutsourceReply(replyText.value)) replyText.value = ''
}

function toggleLeaveDate(rowIndex: number, date: string, checked: boolean) {
  const row = agent.leaveRows[rowIndex]
  if (!row) return
  if (checked) {
    if (!row.dates.includes(date)) row.dates.push(date)
  } else {
    row.dates = row.dates.filter((d) => d !== date)
  }
}

async function onCsvChange(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'csv') {
    const reader = new FileReader()
    reader.onload = (ev) => agent.attachCsv(file.name, String(ev.target?.result ?? ''))
    reader.readAsText(file)
  } else if (ext === 'xlsx' || ext === 'xls') {
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const wb = XLSX.read(new Uint8Array(ev.target?.result as ArrayBuffer), { type: 'array' })
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
        agent.attachCsv(file.name, csv)
      } catch {
        window.alert('解析 Excel 失敗')
      }
    }
    reader.readAsArrayBuffer(file)
  } else {
    window.alert('不支援的檔案格式')
  }
  ;(e.target as HTMLInputElement).value = ''
}
</script>

<template>
  <!-- 可拖曳分隔線：與舊版一樣放在側邊欄左側，收合時一併隱藏 -->
  <div
    class="agent-resizer"
    :class="{ collapsed: !open, dragging: resizing }"
    title="拖曳調整寬度"
    @mousedown="startResize"
  ></div>

  <aside
    class="agent-sidebar"
    :class="{ collapsed: !open, 'outsource-mode': agent.isOutsource }"
    :style="open ? { width: width + 'px' } : undefined"
  >
    <div class="agent-sidebar-header">
      <h3>🤖 AI 助手</h3>
      <button class="agent-sidebar-close" @click="emit('close')">&times;</button>
    </div>

    <!-- 模式 + thinking -->
    <div class="agent-section agent-row">
      <label class="agent-label">模式</label>
      <select v-model="agent.mode" class="agent-select">
        <option value="edit_qa">編輯 / 問答</option>
        <option value="scheduling">排班</option>
        <option value="outsource">排班外包</option>
      </select>
      <label class="agent-label">思考</label>
      <label class="switch">
        <input v-model="agent.enableThinking" type="checkbox" />
        <span class="slider"></span>
      </label>
    </div>

    <!-- 參考範圍（排班模式） -->
    <div v-if="agent.isSchedulingLike" class="agent-section">
      <div class="agent-toggle" @click="refOpen = !refOpen">參考範圍 <span>{{ refOpen ? '▼' : '▶' }}</span></div>
      <div v-show="refOpen" class="agent-ranges">
        <div class="range-row">
          <span>參考週次 <b style="color: var(--danger-color)">*</b></span>
          <select v-model="agent.refStart" class="range-select">
            <option value="">起始</option>
            <option v-for="d in refStartOpts" :key="d" :value="d">{{ d }}</option>
          </select>
          <span>→</span>
          <select v-model="agent.refEnd" class="range-select">
            <option value="">結束</option>
            <option v-for="d in refEndOpts" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div class="range-row">
          <span>生成週次 <b style="color: var(--danger-color)">*</b></span>
          <select v-model="agent.genStart" class="range-select">
            <option value="">起始</option>
            <option v-for="d in genStartOpts" :key="d" :value="d">{{ d }}</option>
          </select>
          <span>→</span>
          <select v-model="agent.genEnd" class="range-select">
            <option value="">結束</option>
            <option v-for="d in genEndOpts" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 排班規則 -->
    <div v-if="agent.isSchedulingLike" class="agent-section">
      <div class="agent-toggle" @click="rulesOpen = !rulesOpen">排班規則 <span>{{ rulesOpen ? '▼' : '▶' }}</span></div>
      <div v-show="rulesOpen" class="agent-rules">
        <label class="rule-row">
          <input v-model="agent.rules.consecutive" type="checkbox" /> 禁止連續同服事
          <select v-model.number="agent.rules.consecutiveWeeks" class="mini-select">
            <option :value="2">2</option>
            <option :value="3">3</option>
          </select>
          週
        </label>
        <label class="rule-row">
          <input v-model="agent.rules.maxRoles" type="checkbox" /> 同工單週最多
          <select v-model.number="agent.rules.maxRolesLimit" class="mini-select">
            <option :value="1">1</option>
            <option :value="2">2</option>
            <option :value="3">3</option>
          </select>
          項
        </label>
        <label class="rule-row">
          <input v-model="agent.rules.serviceKnownPeople" type="checkbox" /> 僅使用該服事歷史人員
        </label>
      </div>
    </div>

    <!-- 請假區域 -->
    <div v-if="agent.isSchedulingLike" class="agent-section">
      <div class="agent-toggle" @click="leaveOpen = !leaveOpen">請假區域 <span>{{ leaveOpen ? '▼' : '▶' }}</span></div>
      <div v-show="leaveOpen" class="agent-leave">
        <div v-for="(row, i) in agent.leaveRows" :key="i" class="leave-row">
          <input v-model="row.person" class="leave-person" placeholder="人名" />
          <div class="leave-dates">
            <span v-if="agent.generateRangeDates.length === 0" class="leave-empty">請先選生成週次</span>
            <label v-for="d in agent.generateRangeDates" :key="d" class="leave-date">
              <input
                type="checkbox"
                :checked="row.dates.includes(d)"
                @change="toggleLeaveDate(i, d, ($event.target as HTMLInputElement).checked)"
              />
              {{ d.slice(5) }}
            </label>
          </div>
          <button class="leave-remove" @click="agent.removeLeaveRow(i)">×</button>
        </div>
        <button class="leave-add" @click="agent.addLeaveRow()">+ 新增請假</button>
      </div>
    </div>

    <!-- 對話 -->
    <div ref="chatArea" class="agent-chat">
      <div v-if="agent.messages.length === 0" class="agent-welcome">
        <div class="agent-welcome-icon">🤖</div>
        <p>嗨！我是 AI 助手。</p>
        <p v-if="agent.isOutsource">選好參考／生成週次後，用下方按鈕把提示詞帶到你自己的 AI，再把結果貼回來。</p>
        <p v-else>{{ agent.isScheduling ? '填入排班需求，我會產生建議供你審核。' : '輸入需求，我會協助你調整班表。' }}</p>
      </div>
      <div v-for="(m, i) in agent.messages" :key="i" class="agent-msg" :class="m.role">{{ m.content }}</div>

      <!-- 排班模式：非線性進度條 -->
      <div v-if="agent.progressActive" class="agent-progress">
        <div class="agent-progress-label">🤖 AI 排班中，請稍候...</div>
        <div class="agent-progress-track">
          <div class="agent-progress-fill" :style="{ width: agent.progressPct + '%' }"></div>
        </div>
        <div class="agent-progress-info">
          <span>{{ Math.floor(agent.progressPct) }}%</span>
          <span>{{ formatElapsed(agent.progressElapsedSec) }}</span>
        </div>
      </div>
      <!-- 其他模式：泡泡 -->
      <div v-else-if="agent.isLoading" class="agent-loading">
        <span class="dot"></span><span class="dot"></span><span class="dot"></span>
      </div>
    </div>

    <!-- 排班外包：不打自己的 API，改由使用者拿去自己的 LLM 跑 -->
    <div v-if="agent.isOutsource" class="agent-input outsource-panel">
      <textarea
        v-model="prompt"
        class="agent-prompt outsource-extra"
        rows="2"
        placeholder="額外排班指令（可留空）..."
      ></textarea>

      <div class="outsource-step">1️⃣ 複製提示詞並開啟 AI</div>
      <div class="outsource-llms">
        <button
          v-for="t in LLM_TARGETS"
          :key="t.id"
          class="btn btn-secondary outsource-llm"
          :disabled="outsourceBusy"
          @click="onOpenLlm(t)"
        >
          <LlmIcon :id="t.id" />
          {{ t.name }}
        </button>
      </div>
      <button class="btn btn-secondary outsource-copy" :disabled="outsourceBusy" @click="onCopyPrompt">
        📋 只複製提示詞
      </button>
      <div class="outsource-note">
        開啟後請貼上在對話框並送出，這一步需要自己來。
      </div>

      <div class="outsource-step">2️⃣ 把 AI 的回覆貼回來</div>
      <textarea
        v-model="replyText"
        class="agent-prompt outsource-reply"
        rows="3"
        placeholder="把 AI 回覆的 JSON 整段貼在這裡..."
      ></textarea>
      <button class="btn btn-primary outsource-apply" :disabled="!replyText.trim()" @click="onApplyReply">
        ✅ 套用回覆（進入審核）
      </button>
    </div>

    <!-- 輸入 -->
    <div v-else class="agent-input">
      <div v-if="agent.attachedCsv" class="agent-attach">
        📄 {{ agent.attachedCsv.name }}
        <button @click="agent.removeCsv()">&times;</button>
      </div>
      <div class="agent-input-row">
        <label v-if="!agent.isSchedulingLike" class="agent-attach-btn" title="上傳 Excel / CSV">
          📎
          <input type="file" accept=".csv,.xlsx,.xls" hidden @change="onCsvChange" />
        </label>
        <textarea
          v-model="prompt"
          class="agent-prompt"
          rows="1"
          :placeholder="agent.isScheduling ? '額外排班指令（可留空）...' : '輸入需求...'"
          @keydown.enter.exact.prevent="onSend"
        ></textarea>
        <button class="agent-send" :disabled="agent.isLoading" @click="onSend">➤</button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/*
  .agent-sidebar / .agent-sidebar-header / .agent-sidebar-close / .agent-resizer
  一律沿用 main.css 的共用樣式（＝舊版 styles.css），才會跟舊版長得一樣
  —— 特別是標題列的紫色漸層。這裡只補 main.css 沒有的：讓側邊欄自己捲動。
*/
.agent-sidebar {
  height: 100vh;
  overflow: hidden;
}
.agent-section {
  padding: 10px 16px;
  border-bottom: 1px solid var(--gray-100);
}
.agent-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-label {
  font-size: 13px;
  white-space: nowrap;
}
.agent-select {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
}
.agent-toggle {
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  justify-content: space-between;
  user-select: none;
}
.agent-ranges,
.agent-rules,
.agent-leave {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.range-row {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.range-select {
  flex: 1;
  min-width: 0;
  padding: 3px 4px;
  font-size: 12px;
  font-family: monospace;
  border: 1px solid var(--border-color);
  border-radius: 4px;
}
.rule-row {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mini-select {
  padding: 1px 4px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
}
.leave-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.leave-person {
  width: 70px;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
}
.leave-dates {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.leave-date {
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
.leave-empty {
  font-size: 12px;
  color: var(--text-light);
}
.leave-remove {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--danger-color);
}
.leave-add {
  align-self: flex-start;
  font-size: 12px;
  border: 1px dashed var(--border-color);
  background: var(--bg-secondary);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
}
.switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}
.switch input {
  opacity: 0;
  width: 0;
  height: 0;
}
.slider {
  position: absolute;
  inset: 0;
  background: var(--gray-200);
  border-radius: 20px;
  transition: 0.2s;
}
.slider::before {
  content: '';
  position: absolute;
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: #fff;
  border-radius: 50%;
  transition: 0.2s;
}
.switch input:checked + .slider {
  background: var(--primary-color);
}
.switch input:checked + .slider::before {
  transform: translateX(16px);
}
.agent-chat {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.agent-welcome {
  text-align: center;
  color: var(--text-secondary);
  margin-top: 24px;
}
.agent-welcome-icon {
  font-size: 40px;
}
.agent-msg {
  max-width: 90%;
  padding: 8px 12px;
  border-radius: 12px;
  font-size: 14px;
  white-space: pre-wrap;
  word-break: break-word;
}
.agent-msg.user {
  align-self: flex-end;
  background: var(--primary-color);
  color: #fff;
}
.agent-msg.assistant {
  align-self: flex-start;
  background: var(--bg-secondary);
  color: var(--text-primary);
}
.agent-msg.error {
  align-self: flex-start;
  background: #fef2f2;
  color: #991b1b;
}
.agent-loading {
  align-self: flex-start;
  display: flex;
  gap: 5px;
  padding: 6px 4px;
}
.agent-loading .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--gray-300);
  animation: agent-bounce 1.2s infinite ease-in-out;
}
.agent-loading .dot:nth-child(2) {
  animation-delay: 0.15s;
}
.agent-loading .dot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes agent-bounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-6px);
    opacity: 1;
  }
}
.agent-progress {
  align-self: stretch;
  background: var(--bg-secondary);
  border-radius: 10px;
  padding: 12px;
}
.agent-progress-label {
  font-size: 13px;
  color: var(--text-primary);
  margin-bottom: 8px;
}
.agent-progress-track {
  height: 8px;
  background: var(--gray-200);
  border-radius: 8px;
  overflow: hidden;
}
.agent-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
  border-radius: 8px;
  transition: width 0.6s ease;
}
.agent-progress-info {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
}
.agent-input {
  border-top: 1px solid var(--border-color);
  padding: 10px 12px;
}
.agent-attach {
  font-size: 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 4px 8px;
  margin-bottom: 6px;
  display: inline-flex;
  gap: 6px;
  align-items: center;
}
.agent-attach button {
  border: none;
  background: transparent;
  cursor: pointer;
}
.agent-input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.agent-attach-btn {
  cursor: pointer;
  font-size: 18px;
  padding: 6px;
}
.agent-prompt {
  flex: 1;
  resize: none;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 8px 10px;
  font-family: inherit;
  max-height: 100px;
}
/* ── 排班外包面板 ────────────────────────────────── */
.outsource-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow-y: auto;
}
/*
  外包模式把對話區排到最下面：操作面板（複製 / 開 AI / 貼回）是主要動線，
  對話區只是結果與錯誤訊息，放下面比較順。
  aside 是 flex column，其餘區塊 order 預設為 0，所以這兩個排在它們之後。
*/
.agent-sidebar.outsource-mode .outsource-panel {
  order: 1;
  flex-shrink: 0;
  border-top: 1px solid var(--border-color);
}
.agent-sidebar.outsource-mode .agent-chat {
  order: 2;
  border-top: 1px solid var(--border-color);
  min-height: 90px;
}
.outsource-step {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-top: 2px;
}
.outsource-llms {
  display: flex;
  gap: 6px;
}
.outsource-llm {
  flex: 1;
  padding: 6px 4px;
  font-size: 12px;
  justify-content: center;
}
.outsource-copy,
.outsource-apply {
  width: 100%;
  justify-content: center;
  font-size: 12px;
  padding: 6px 8px;
}
.outsource-note {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-light);
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 6px 8px;
}
.outsource-extra,
.outsource-reply {
  width: 100%;
  resize: vertical;
}
.agent-send {
  border: none;
  background: var(--primary-color);
  color: #fff;
  border-radius: 8px;
  width: 40px;
  cursor: pointer;
  font-size: 16px;
}
.agent-send:disabled {
  opacity: 0.5;
}
</style>
