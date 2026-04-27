# Agent Schedule Generator (Cloud Function)

此服務提供 `generate_agent_schedule` API，前端會送出排班資料與使用者提示，後端依 `selectedMode` 選擇不同模型與 provider，回傳：
- 排班更新（tool call）
- 或純問答內容（answer-only）
- 或 schema 驗證 / 範圍護欄違反（422）

## 檔案

```text
agent_schedule_GCF/
├─ main.py
├─ agentConfig.py
├─ requirements.txt
└─ README.md
```

## Request Body

```json
{
  "prompt": "請排 7 月班表",
  "currentSchedule": "{scheduleData, serviceItems, nonUserColumns}",
  "selectedMode": "scheduling",
  "activeRules": {
    "consecutive": true,
    "consecutiveWeeks": 2,
    "maxRoles": true,
    "maxRolesLimit": 2,
    "serviceKnownPeople": true,
    "frequencyParity": false
  },
  "chatHistory": [],
  "attachedCsvText": "(optional, edit_qa only)",

  "generateWeeks": ["2026.07.05", "2026.07.12"],
  "suppressStructural": true,

  "leaveByDate": {
    "2026.07.05": ["阿明", "小華"],
    "2026.07.12": ["老王"]
  },

  "experimentStartTime": "2026-04-26_22-00-00",
  "experimentRetryCount": 0
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `prompt` | ✅ | 使用者輸入；scheduling 模式可空（前端帶預設值送出） |
| `currentSchedule` | ✅ | JSON 字串。前端可先依 `referenceWeeks` 過濾再送 |
| `selectedMode` | ✅ | `edit_qa` 或 `scheduling` |
| `activeRules` | scheduling 必填 | 五條規則旗標 + 兩個門檻數字 |
| `chatHistory` | 選 | 模式隔離的對話歷史 |
| `attachedCsvText` | 選（僅 edit_qa） | 上傳的 CSV 參考資料 |
| `generateWeeks` | 選（scheduling） | 限定 LLM 只能修改/輸出這些日期 |
| `suppressStructural` | 選（scheduling） | true 時把 tool schema 的 `addWeeks` / `removeWeeks` 拿掉 |
| `leaveByDate` | 選（scheduling） | `{date: [names]}`，硬性禁止指定的人在指定日期被排班；違反 → 422 |
| `experimentStartTime` / `experimentRetryCount` | 選 | 排班模式落檔到 `Prompt_Experiment/` 用，方便 prompt engineering 比對 |

## 模式

- `edit_qa`：編輯/問答模式
- `scheduling`：排班模式

## 模式行為

- `edit_qa`：
  - 可附帶 `attachedCsvText`（包入 `<untrusted_csv>` 標籤）
  - 後端不把排班規則寫入 system prompt
  - 永遠用 JSON 版 `SCHEDULE_TOOL`
- `scheduling`：
  - 排班規則（`activeRules`）會寫入 system prompt
  - CSV 不會寫入 system prompt
  - `USE_CSV_SCHEDULE=True` 時 `currentSchedule` 在後端轉成 CSV 餵給 LLM、回應再解回 JSON
  - `generateWeeks` 非空時加入 **Scope Constraint** 段落，限定輸出範圍；`suppressStructural=true` 時對應的 tool 欄位也會從 schema 移除
  - `leaveByDate` 非空時加入 **Person Unavailability** 段落，硬性禁止指定日期排上指定人員；後端 `_validate_tool_input` 也會把違反的 LLM 回應擋下回 422
  - 每次呼叫會把 system prompt + messages + response 落檔到 `Prompt_Experiment/{start-time}-{retry}.txt`（可關閉，見下）

## activeRules

| key | 型別 | 說明 |
|---|---|---|
| `consecutive` | bool | 不允許連續 N 週同人同服事 |
| `consecutiveWeeks` | int ≥ 2 | 上一條的 N |
| `maxRoles` | bool | 單週每人服事項目上限 |
| `maxRolesLimit` | int ≥ 1 | 上一條的上限 |
| `serviceKnownPeople` | bool | 該服事只能用歷史出現過的人員 |
| `frequencyParity` | bool | （**目前 UI 隱藏**）每人在生成範圍的服事頻率盡量符合參考範圍的比例。容忍度 ±30%（寫死於程式碼，見 `FREQUENCY_PARITY_TOLERANCE`） |

## Schema 驗證與護欄

`SCHEMA_VALIDATION` 與 `PROMPT_HARDENING` 兩組設定可在 `agentConfig.py` 覆蓋（缺檔則用 `_DEFAULT_*` 預設）。

| 設定 | 用途 |
|---|---|
| `SCHEMA_VALIDATION.max_add_weeks` / `max_remove_weeks` | 結構性週數變更上限 |
| `SCHEMA_VALIDATION.max_add_service_columns` / `max_remove_service_columns` | 結構性欄位變更上限 |
| `SCHEMA_VALIDATION.max_schedule_rows` / `max_persons_per_cell` / `max_service_columns_per_row` | scheduleData 尺寸護欄 |
| `SCHEMA_VALIDATION.max_person_name_length` / `max_service_column_name_length` / `max_explanation_length` | 字串長度護欄 |
| `SCHEMA_VALIDATION.date_regex` | 日期格式（預設 `YYYY.MM.DD`） |
| `PROMPT_HARDENING.wrap_untrusted_in_tags` | 把 `currentSchedule` / `csv` / chat history 包進 `<untrusted_*>` 標籤 |
| `PROMPT_HARDENING.defense_instruction` | system prompt 頂部的安全指示 |

驗證失敗 → HTTP 422 + `{"error": "Agent response failed schema validation", "detail": "..."}`

## agentConfig.py

`MODE_CONFIG` 可讓你針對兩個模式各自設定：
- `provider`
- `model`
- `api_base_url`
- `api_key`

```python
import os

MODE_CONFIG = {
    "edit_qa": {
        "provider": "openai_compatible",
        "model": "gpt-4.1",
        "api_base_url": "https://api.openai.com/v1",
        "api_key": os.environ.get("OPENAI_API_KEY", ""),
    },
    "scheduling": {
        "provider": "anthropic",
        "model": "claude-opus-4-6",
        "api_base_url": "",
        "api_key": os.environ.get("ANTHROPIC_API_KEY", ""),
    },
}

DEFAULT_MODE = "edit_qa"

ALLOWED_ORIGINS = [
    "https://bol-line-bot-3.web.app",
    "http://localhost:5500",
]

# 可選：覆蓋 SCHEMA_VALIDATION / PROMPT_HARDENING 預設值（見 main.py）
```

## 支援的 provider

- `anthropic`
- `openai_compatible`（例如 `https://api.openai.com/v1`）

## 回應格式

### 1) 排班更新（200）

```json
{
  "scheduleData": [...],
  "explanation": "...",
  "addWeeks": 0,
  "removeWeeks": 0,
  "addServiceColumns": [],
  "removeServiceColumns": [],
  "modeKey": "scheduling",
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "usage": { "input_tokens": 123, "output_tokens": 456 }
}
```

### 2) 問答模式（200，不改排班）

```json
{
  "mode": "answer_only",
  "answerOnly": true,
  "answer": "...",
  "explanation": "...",
  "modeKey": "edit_qa",
  "provider": "openai_compatible",
  "model": "gpt-4.1",
  "usage": { "input_tokens": 123, "output_tokens": 456 }
}
```

### 3) Schema / 護欄違反（422）

```json
{
  "error": "Agent response failed schema validation",
  "detail": "addWeeks=30 exceeds limit 26",
  "modeKey": "scheduling",
  "provider": "anthropic",
  "model": "claude-opus-4-6",
  "usage": { ... }
}
```

## CSV 模式（實驗用旗標）

`main.py` 頂端 `USE_CSV_SCHEDULE = True/False`：
- `True`：scheduling 模式 LLM 看到 / 回的 `scheduleData` 是 CSV 文字（後端做 round-trip）。**對外 API 契約不變**，前端仍收到 list-of-dict。
- `False`：所有模式都是 JSON。

實測 CSV 比 JSON 約省 40% input/output tokens 與 ~38% 延遲，但首試通過率較低。請依需求切換。

## Prompt Engineering 實驗紀錄

`scheduling` 模式每次呼叫會把以下落檔到 `Prompt_Experiment/{start-time}-{retry}.txt`：
- system prompt（含 Scope Constraint、active rules、untrusted-wrapped schedule）
- messages（chat history + 當次 user request）
- response body（含 token usage）
- LLM 原始 CSV 輸出（CSV 模式才有）

要關閉：環境變數 `AGENT_EXPERIMENT_LOG_DIR=""` 或刪掉 `Prompt_Experiment/` 資料夾。

## CORS

`ALLOWED_ORIGINS` 在 `agentConfig.py`。新增本機開發網域記得加 `http://localhost:5500`、`http://127.0.0.1:5500`。
