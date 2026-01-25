# LINE Bot 服事系統 (Google Cloud Function)

串聯 LINE Bot 與 Firebase Firestore 的服事管理系統，提供調班、代班、服事提醒等功能。

## ✨ 功能特色

### 🔐 邀請碼登入
- 使用 16 位英數字邀請碼登入
- 管理員在 schedule-app 建立使用者後產生邀請碼
- 登入後自動綁定 LINE ID 與 `line_bot_id`

### 🔄 調班/代班功能
- **調班**：與其他同工交換服事日期
- **代班**：請其他同工幫忙代為服事
- 支援多場崇拜選擇
- 自動顯示崇拜名稱 (如 🎸 青年崇拜)
- 雙方確認機制，保障權益
- **支援跨 LINE Bot 調班通知**（不同 Bot 的用戶可互相調班）

### ⏰ 服事提醒
- 可設定週一至週六提醒
- 自訂化提醒日期
- 跨崇拜服事提醒

### 📅 班表查詢
- 查看當週班表
- 動態取得服事項目順序
- 總班表連結（帶有使用者 highlight）

## 📁 檔案結構

```
line_bot_GCF/
├── main.py              # 主程式，LINE Bot Webhook 處理
├── chatBotConfig.py     # LINE Bot 設定（多台 Bot 憑證）
├── week_alarm.py        # Flex Message 模板（alarm, menu）
├── serviceAccount.json  # Firebase 服務帳戶金鑰
└── README.md            # 說明文件
```

## 🔧 多台 LINE Bot 設定

本系統支援同時連接 **1-4 台 LINE Bot**，每台 Bot 部署獨立的 GCF。

### `line_bot_id` 規則

| line_bot_id | 意義 | 陣列索引 |
|-------------|------|---------|
| 0 | 未連線任何 LINE Bot | N/A |
| 1 | 第一台 LINE Bot | 0 |
| 2 | 第二台 LINE Bot | 1 |
| 3 | 第三台 LINE Bot | 2 |
| ... | ... | ... |

### 設定 `chatBotConfig.py`

```python
# =====================================================
# 多台 LINE Bot 設定
# =====================================================
# line_bot_id: 對應此 GCF 部署的 LINE Bot 編號
# 規則：
#   - line_bot_id = 0: 未連線任何 LINE Bot
#   - line_bot_id = 1: 第一台 LINE Bot (陣列索引 0)
#   - line_bot_id = 2: 第二台 LINE Bot (陣列索引 1)
#   - 以此類推...
# =====================================================

line_bot_id = 1  # 請根據部署的 LINE Bot 修改此值

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

### 部署多台 GCF

**GCF #1（第一台 Bot）**：
```bash
# 修改 chatBotConfig.py: line_bot_id = 1
gcloud functions deploy lineWebhook-bot1 \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated
```

**GCF #2（第二台 Bot）**：
```bash
# 修改 chatBotConfig.py: line_bot_id = 2
gcloud functions deploy lineWebhook-bot2 \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated
```

### 跨 Bot 調班運作原理

當 Bot 1 的用戶 A 向 Bot 2 的用戶 B 發送調班請求時：
1. 用戶 A 在 Bot 1 發起調班請求
2. 系統查詢用戶 B 的 `line_bot_id`（值為 2）
3. 系統使用 Bot 2 的 `channel_access_token` 發送 push message 給用戶 B
4. 用戶 B 透過 Bot 2 回應確認/拒絕
5. 系統使用 Bot 1 的 token 通知用戶 A 結果

## 🔧 其他環境設定

### 設定 Firebase 服務帳戶

將 `serviceAccount.json` 放在目錄中。

### 本地測試

```bash
# 安裝依賴
pip install flask line-bot-sdk firebase-admin

# 執行本地伺服器
python local_run.py

# 使用 ngrok 建立外部連接（另一個終端機）
ngrok http 5000
```

## 📊 Firestore 資料結構

### 使用者 Collection（users）

```javascript
// Document ID: "小明"（使用者名稱）
{
  alarm_type: [true, false, false, false, false, false],  // 週一至週六提醒
  lineId: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",            // LINE 使用者 ID
  line_bot_id: 1,                                         // 用戶使用的 LINE Bot 編號 (1, 2, ...)
  login_token: "ABC123DEF456GHIJ",                        // 16位邀請碼
  usage_count: { "2026.01": { "當週班表": 5, "調班": 2 } }, // 使用統計
  serve_types: {
    "youth-serve": ["主領", "音控"],                       // 各場崇拜的服事項目
    "kids-serve": ["司會"]
  }
}
```

### 崇拜設定 Collection（_config）

```javascript
// Document ID: "serve-list"
{
  serves: [
    { id: "youth-serve", name: "青年崇拜", emoji: "🎸" },
    { id: "kids-serve", name: "兒童崇拜", emoji: "🧒" }
  ]
}
```

### 班表 Collection（如 youth-serve）

```javascript
// Document ID: "2026.01.05"（日期）
{
  主領: ["劉婕"],
  音控: ["家睿", "芯芳"],
  字幕: ["捷希"]
}

// Document ID: "_metadata"
{
  serviceItems: ["主領", "音控", "字幕", ...]
}
```

### 調班記錄 Collection（_shift）

```javascript
{
  狀態: "等待",           // 等待 / 成功 / 拒絕
  種類: "主領",
  collection: "youth-serve",
  申請人: "小明",
  被申請人: "小華",
  申請日: "2026.01.05",
  被申請日: "2026.01.12"  // 代班時為 "none"
}
```

## 💬 使用者指令

### 文字訊息

| 指令 | 功能 |
|------|------|
| `總班表` / `全部班表` | 取得班表網頁連結 |
| `班表` / `本週班表` | 查看當週服事內容 |
| `換班` / `調班` | 開始調班流程 |
| `代班` | 開始代班流程 |
| `設定提醒` / `設定` | 開啟提醒設定 |
| `目錄` / `Menu` | 開啟功能選單 |

### 登入

傳送 16 位邀請碼即可登入：
```
ABC123DEF456GHIJ
```

## 🔄 調班/代班流程

```
1. 選擇服事種類（含崇拜名稱）
2. 選擇要調換的日期
3. 選擇對象（調班：選日期+人、代班：選人）
4. 確認申請
5. 對方收到通知（跨 Bot 時使用對方的 Bot 發送）
6. 對方確認/拒絕
7. 雙方收到結果通知
```

## 🛠️ 技術細節

### Postback 資料格式

| Prefix | 用途 |
|--------|------|
| `A*` | 選擇服事種類 |
| `A&` | 選擇日期 |
| `B&` | 單人調班確認 |
| `B#` | 多人選擇 |
| `G#` | 代班確認 |
| `C&` | 發送調班請求 |
| `G&` | 發送代班請求 |
| `D&` | 被申請人確認 |
| `E&` | 被申請人拒絕 |
| `F&` | 執行調班 |
| `C*` | 更改提醒設定 |
| `W&` | 查看指定崇拜班表 |

### 核心函數說明

| 函數名 | 用途 |
|--------|------|
| `get_line_bot_api_for_user(user_name)` | 根據用戶的 `line_bot_id` 取得正確的 LineBotApi，用於跨 Bot 發送訊息 |
| `sign_in_with_token(login_token, line_id)` | 使用邀請碼登入，同時更新 `line_bot_id` |
| `send_shift_request(data_parts, mode)` | 發送調班/代班請求，使用對方的 Bot 發送通知 |

---

**Made with ❤️ for Church Ministry**
