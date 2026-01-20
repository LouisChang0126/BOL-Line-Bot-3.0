# LINE Bot 服事系統 (Google Cloud Function)

串聯 LINE Bot 與 Firebase Firestore 的服事管理系統，提供調班、代班、服事提醒等功能。

## ✨ 功能特色

### 🔐 邀請碼登入
- 使用 16 位英數字邀請碼登入
- 管理員在 schedule-app 建立使用者後產生邀請碼
- 登入後自動綁定 LINE ID

### 🔄 調班/代班功能
- **調班**：與其他同工交換服事日期
- **代班**：請其他同工幫忙代為服事
- 支援多場崇拜選擇
- 自動顯示崇拜名稱 (如 🎸 青年崇拜)
- 雙方確認機制，保障權益

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
├── main.py           # 主程式，LINE Bot Webhook 處理
├── chatBotConfig.py  # LINE Bot 設定（channel_secret, channel_access_token）
├── week_alarm.py     # Flex Message 模板（alarm, menu）
└── README.md         # 說明文件
```

## 🔧 環境設定

### 1. 設定 LINE Bot 憑證

建立 `chatBotConfig.py`：

```python
channel_secret = "YOUR_CHANNEL_SECRET"
channel_access_token = "YOUR_CHANNEL_ACCESS_TOKEN"
```

### 2. 設定 Firebase 服務帳戶

將 `serviceAccount.json` 放在上層目錄。

### 3. 部署到 Google Cloud Function

```bash
gcloud functions deploy lineWebhook \
  --runtime python39 \
  --trigger-http \
  --allow-unauthenticated
```

## 📊 Firestore 資料結構

### 使用者 Collection（users）

```javascript
// Document ID: "小明"（使用者名稱）
{
  alarm_type: [true, false, false, false, false, false],  // 週一至週六提醒
  lineId: "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",            // LINE 使用者 ID
  login_token: "ABC123DEF456GHIJ",                        // 16位邀請碼（登入後保留）
  serve_types: {
    "youth-serve": ["主領", "音控"],                       // 各場崇拜的服事項目
    "kids-serve": ["司會"]
  },
  "youth-serve": {                                        // 該崇拜的服事日期
    "主領": ["2026.01.05", "2026.02.02"],
    "音控": ["2026.01.12"]
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
5. 對方收到通知
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

---

**Made with ❤️ for Church Ministry**
