# 服事提醒系統 (Week Clock Alarm)

自動發送每週服事提醒給所有有服事的用戶，支援多台 LINE Bot。

## ✨ 功能特色

- 📅 自動計算這週日的服事日期
- 🔔 根據用戶設定的提醒日（週一至週六）發送提醒
- 📋 整合所有崇拜的服事項目，一次提醒
- 🤖 支援多台 LINE Bot，根據用戶的 `line_bot_id` 使用正確的 Bot 發送

## 📁 檔案結構

```
week_clock_alarm/
├── week_clock_alarm.py   # 主程式，提醒邏輯
├── chatBotConfig.py      # LINE Bot 設定（多台 Bot 憑證）
├── serviceAccount.json   # Firebase 服務帳戶金鑰
├── local_run.py          # 本地測試用
└── README.md             # 說明文件
```

## 🔧 多台 LINE Bot 設定

本系統支援同時使用 **多台 LINE Bot** 發送提醒，根據每個用戶的 `line_bot_id` 選擇正確的 Bot。

### `line_bot_id` 規則

| line_bot_id | 意義 | 陣列索引 |
|-------------|------|---------|
| 0 | 未連線任何 LINE Bot（不發送提醒） | N/A |
| 1 | 第一台 LINE Bot | 0 |
| 2 | 第二台 LINE Bot | 1 |
| 3 | 第三台 LINE Bot | 2 |
| ... | ... | ... |

### 設定 `chatBotConfig.py`

```python
# =====================================================
# 多台 LINE Bot 設定 (week_clock_alarm 用)
# =====================================================
# 注意：此 GCF 會發送提醒給所有用戶，因此需要存取所有 Bot 的 token
# =====================================================

# LINE Bot Channel Secret (依順序排列: 第一台, 第二台, ...)
channel_secret = [
    'YOUR_BOT1_CHANNEL_SECRET',  # Bot 1 (line_bot_id=1)
    'YOUR_BOT2_CHANNEL_SECRET'   # Bot 2 (line_bot_id=2)
]

# LINE Bot Channel Access Token (依順序排列: 第一台, 第二台, ...)
channel_access_token = [
    'YOUR_BOT1_ACCESS_TOKEN',  # Bot 1
    'YOUR_BOT2_ACCESS_TOKEN'   # Bot 2
]
```

## 🚀 部署

### 設定 Cloud Scheduler

建立一個 Cloud Scheduler Job，每天在需要提醒的時間執行：

https://console.cloud.google.com/cloudscheduler

上面的 cron 表達式 `0 8 * * 1-6` 表示週一至週六的早上 8:00 執行。

## 📊 運作流程

```
1. Cloud Scheduler 觸發 cloud_Scheduler(request)
2. 從 _config/serve-list 取得所有崇拜清單
3. 計算這週日的日期
4. 遍歷每個崇拜，取得該週日的服事資料
5. 整理成 {人員: [崇拜名-服事項目, ...]} 的格式
6. 對每個有服事的用戶：
   a. 檢查用戶今天是否設定要被提醒 (alarm_type)
   b. 取得用戶的 line_bot_id
   c. 使用對應的 LineBotApi 發送提醒
```

## 📊 Firestore 資料結構

### 用戶提醒設定

```javascript
// users/{user_name}
{
  lineId: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  line_bot_id: 1,  // 用戶使用的 LINE Bot 編號
  alarm_type: [true, false, false, false, false, false]
  // 索引: [週一, 週二, 週三, 週四, 週五, 週六]
  // true = 該天提醒, false = 不提醒
}
```

### 崇拜清單

```javascript
// _config/serve-list
{
  serves: [
    { id: "youth-serve", name: "青年崇拜", emoji: "🎸" },
    { id: "kids-serve", name: "兒童崇拜", emoji: "🧒" }
  ]
}
```

### 班表資料

```javascript
// {collection_id}/{date}
// 例如: youth-serve/2026.01.05
{
  主領: ["劉婕"],
  音控: ["家睿", "芯芳"],
  字幕: ["捷希"]
}
```

## 📱 提醒訊息範例

```
提醒你這週有服事喔!

這週的服事（2026/01/05）:
• 🎸 青年崇拜-主領
• 🎸 青年崇拜-音控
• 🧒 兒童崇拜-司會
```

## 🔄 本地測試

```bash
python local_run.py
```

## 🛠️ 核心函數說明

| 函數名 | 用途 |
|--------|------|
| `reminder_all_serves()` | 主要提醒函數，遍歷所有用戶並發送提醒 |
| `get_line_bot_api_for_user_data(user_data)` | 根據用戶的 `line_bot_id` 取得正確的 LineBotApi |
| `cloud_Scheduler(request)` | GCF 進入點，處理 Cloud Scheduler 請求 |
| `force_reminder(...)` | 強制提醒特定服事人員（如主領選歌提醒） |

## ⚠️ 注意事項

**未連線用戶**：`line_bot_id = 0` 的用戶不會收到提醒，系統會在 log 中記錄這些用戶。

---

**Made with ❤️ for Church Ministry**
