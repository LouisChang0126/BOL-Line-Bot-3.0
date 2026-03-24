# Agent Schedule Generator (Cloud Function)

Claude API Proxy，接收前端排班指令並呼叫 Claude API 產生排班建議。

## 架構

```
agent_schedule_GCF/
├── main.py           # Cloud Function 主程式
├── agentConfig.py    # API Key 設定（.gitignore 排除）
└── requirements.txt  # Python 依賴
```

## 設定

1. 複製設定檔並填入 API Key：
```python
# agentConfig.py
ANTHROPIC_API_KEY = "your-key-here"
```

2. 安裝依賴（本地測試用）：
```bash
pip install -r requirements.txt
```

## 部署

```bash
gcloud functions deploy generate_agent_schedule \
  --runtime python312 \
  --trigger-http \
  --allow-unauthenticated \
  --region us-central1
```

> **注意**：若不使用 `agentConfig.py`，可改用環境變數：
> ```bash
> --set-env-vars ANTHROPIC_API_KEY=your-key-here
> ```

## API 規格

### POST `/generate_agent_schedule`

**Request Body:**
```json
{
  "prompt": "幫我排下週的班表",
  "currentSchedule": "{scheduleData, serviceItems, nonUserColumns}",
  "selectedModel": "claude-sonnet-4-6",
  "activeRules": { "consecutive": true, "maxRoles": true },
  "attachedCsvText": "(optional) CSV 純文字"
}
```

**Response:**
```json
{
  "scheduleData": [{ "date": "2026-03-29", "主領": ["小明"], ... }],
  "explanation": "排班邏輯說明",
  "model": "claude-sonnet-4-6",
  "usage": { "input_tokens": 1234, "output_tokens": 567 }
}
```

### CORS 白名單
- `bol-line-bot-3.web.app`
- `bol-line-bot-3.firebaseapp.com`
- `localhost:5000`（本地開發）

## Claude Tool Schema

使用 Function Calling 強制 Claude 回傳 `scheduleData` JSON 格式，確保結構一致。
