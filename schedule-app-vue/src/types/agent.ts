/** AI 排班助手相關型別（前端 ↔ Cloud Function 契約 + agent_log dashboard） */
import type { ScheduleRow } from './schedule'

export type AgentMode = 'edit_qa' | 'scheduling'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  content: string
}

/** 排班規則設定 */
export interface ActiveRules {
  consecutive: boolean
  consecutiveWeeks: number
  maxRoles: boolean
  maxRolesLimit: number
  serviceKnownPeople: boolean
  frequencyParity: boolean
}

export type RuleWarningType =
  | 'consecutive'
  | 'maxRoles'
  | 'serviceKnownPeople'
  | 'frequencyParity'
  | 'personUnavailability'

export interface RuleWarning {
  type: RuleWarningType
  message: string
  date?: string
  service?: string
  person?: string
  count?: number
  [k: string]: unknown
}

/** 送給 Cloud Function 的 payload */
export interface AgentRequestPayload {
  prompt: string
  /** JSON.stringify({ scheduleData }) */
  currentSchedule: string
  selectedMode: AgentMode
  activeRules: Partial<ActiveRules>
  chatHistory: { role: string; content: string }[]
  enableThinking: boolean
  attachedCsvText?: string
  generateWeeks?: string[]
  suppressStructural?: boolean
  consecutiveContextWeeks?: string[]
  leaveByDate?: Record<string, string[]>
}

/** Cloud Function 回應 */
export interface AgentResponse {
  scheduleData?: ScheduleRow[]
  explanation?: string
  answer?: string
  answerOnly?: boolean
  mode?: string
  inferenceSeconds?: number
  addWeeks?: number
  removeWeeks?: number
  addServiceColumns?: string[]
  removeServiceColumns?: string[]
  _debug?: unknown
}

/** 一格待審核的 AI 變更 */
export interface PendingCellChange {
  old: string[]
  new: string[]
}
/** date → service → PendingCellChange */
export type PendingAgentChanges = Record<string, Record<string, PendingCellChange>>

// ── agent_log dashboard ────────────────────────────────────────────
export interface AgentLogMessage {
  role: string
  content: string
}

export interface AgentLogUsage {
  input_tokens?: number
  output_tokens?: number
}

export interface AgentLog {
  id: string
  wall_clock_utc: string
  start_time?: string | null
  retry_count?: number
  'serve-id'?: string
  mode?: string
  provider?: string
  model?: string
  enable_thinking?: boolean
  status_code?: number | null
  inference_time?: number | null
  stop_reason?: string
  system_prompt?: string
  thinking?: string
  messages?: AgentLogMessage[]
  response_body?: {
    usage?: AgentLogUsage
    scheduleData?: ScheduleRow[]
    [k: string]: unknown
  } | { _truncated?: boolean; preview?: string } | unknown
  truncated_fields?: string[]
}
