# Agent Schedule Generator (Cloud Function)

此服務提供 `generate_agent_schedule` API，前端會送出排班資料與使用者提示，後端依 `selectedMode` 選擇不同模型與 provider，回傳：
- 排班更新（tool call）
- 或純問答內容（answer-only）

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
  "prompt": "4/19有誰？",
  "currentSchedule": "{scheduleData, serviceItems, nonUserColumns}",
  "selectedMode": "edit_qa",
  "activeRules": { "consecutive": true, "maxRoles": true },
  "attachedCsvText": "(optional)"
}
```

## 模式

- `edit_qa`：編輯/問答模式
- `scheduling`：排班模式

## 模式行為

- `edit_qa`：
  - 可附帶 `attachedCsvText`
  - 後端不把排班規則寫入 system prompt
- `scheduling`：
  - 排班規則（`activeRules`）會寫入 system prompt
  - CSV 不會寫入 system prompt

## agentConfig.py

`MODE_CONFIG` 可讓你針對兩個模式各自設定：
- `provider`
- `model`
- `api_base_url`
- `api_key`

範例：

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
```

## 支援的 provider

- `anthropic`
- `openai_compatible`（例如 `https://api.openai.com/v1`）

## 回應格式

### 1) 排班更新

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

### 2) 問答模式（不改排班）

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
