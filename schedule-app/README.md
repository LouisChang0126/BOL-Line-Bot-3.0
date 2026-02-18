# 教會服事班表系統

一個與 Firestore 連動的互動式教會服事班表網頁

## ✨ 功能特色

### 🎯 三種使用者介面

| 介面 | 路徑 | 功能 |
|------|------|------|
| 📖 **班表查看** | `schedule-app/` | 只能查看班表，支援使用者 highlight |
| ✏️ **班表編輯** | `edit-chart/` | 編輯班表、管理使用者，支援撤銷/重做 |
| 📊 **使用數據觀察** | `edit-chart/observation.html` | 查看 LINE Bot 使用統計與分析 |

### 📅 日期管理
- ✏️ 編輯任一日期，其他日期自動調整（保持7天間隔）
- ➕ 新增週次（自動加7天）
- ➖ 刪除最後一週

### 📋 服事項目管理
- ✨ 新增自訂服事項目
- 📝 新增資訊欄位（不包含人名的欄位，如「彩排」、「備註」）
- ✏️ 編輯服事項目名稱（點擊標題即可編輯）
- ☑️ 可標記欄位為「資訊欄位」（資訊欄位不會被計入使用者檢查）
- 🗑️ 在編輯對話框中移除服事項目
- 🔀 拖拉排序服事項目（拖拉表頭）
- 📊 編輯顯示欄位（分組管理、隱藏項目）
- 🔄 **同步更新**：重新命名服事項目時，displayConfig 會自動同步更新

### 👥 人員管理
- 點擊格子編輯服事人員
- 顯示在該服事有經驗的人員優先
- 人員以彩色積木（chip）方式顯示（30種顏色）
- 點擊資訊欄位時，顯示多文字輸入框介面（適用於彩排時間、備註等）

### 👤 使用者管理
- 📜 **編輯記錄**：查看班表編輯歷史並可一鍵還原
- 👥 **管理使用者**：統一管理所有服事人員資料
  - 🔄 自動加入使用者 & 更新服事
  - ⏰ 提醒設定（週一至週六）
  - 🔗 LINE ID 綁定
  - 📋 跨崇拜服事項目管理
  - 🤖 **LINE Bot 分配**：可為每位使用者指定使用的 LINE Bot（0=未連線，1-4 對應不同的 Bot）
  - 📊 **使用統計**：記錄每位使用者的功能使用次數（usage_count）
- ⚠️ **即時警示**：當班表有未註冊或需更新的使用者時顯示提醒
- ℹ️ **資訊欄位排除**：標記為資訊欄位的項目不會納入使用者檢查

### ⛪ 崇拜管理
- ➕ **新增崇拜**：管理員可新增最多 5 場崇拜
- ✏️ **編輯名稱**：可更改崇拜名稱和 Emoji
- 🗑️ **刪除崇拜**：需輸入崇拜名稱確認，防止誤刪
- 🎨 **10種 Emoji**：⛪ 🎸 🧒 👥 🎵 📖 🙏 ✝️ 🕊️ 💒

### 📊 使用數據觀察儀表板（新功能）
- 📈 **多維度統計**：
  - Push Message 使用量（依 LINE Bot 分組顯示）
  - 指令使用分布（圓餅圖）
  - 調班通知分布（成功/失敗/請求）
  - 調班成功率統計
  - 用戶活躍度分析
  - 活躍用戶排行榜（Top 10）
  - 使用趨勢（6 條折線分別顯示不同功能）
- 🗓️ **月份篩選**：可選擇不同月份查看統計數據
- 📊 **視覺化圖表**：使用 Chart.js 呈現清晰易讀的圖表
- 🔄 **即時刷新**：支援手動刷新最新數據

### 🔍 班表查看功能
- 🔦 **使用者專屬連結**：網址使用 `?user=名字` 只顯示該使用者有服事的崇拜
- 🎯 **單一崇拜自動跳轉**：若使用者只有一個崇拜，自動進入該崇拜班表
- 📅 **顯示歷史**：可選擇顯示過去的班表資料
- 💡 **智慧 highlight**：自動高亮顯示指定使用者的服事項目

### 🔄 撤銷/重做功能
- ⬅️ Ctrl+Z 撤銷（最多20步）
- ➡️ Ctrl+Y 重做
- 按鈕也可使用

### 📝 編輯記錄系統
- 自動記錄每次編輯的原始狀態和變更差異
- 儲存在 `_edit_chart_log` collection
- 管理員可查看並一鍵還原
- 🔍 **詳細差異顯示**：清楚標示新增、修改、刪除的內容

### 🎯 進階功能
- 🖱️ **拖拉操作**：直接拖拉人員積木到其他格子
- 📋 **右鍵貼上**：從 Excel 複製資料，右鍵選擇起始格子貼上
- 🔄 **即時同步**：所有變更自動儲存到 Firestore
- 📱 **螢幕方向提示**（可選）：在行動裝置上建議橫向瀏覽（目前已停用）

## 🚀 快速開始

### 1. 設定 Firebase

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 建立新專案或選擇現有專案
3. 啟用 Firestore Database
4. 取得 Firebase 配置

### 2. 更新配置檔案

開啟 `firebase-config.js`，替換為您的實際配置。

### 3. 啟動應用程式

已使用 Firebase Hosting 部署，且使用 reCAPTCHA v3 限定網域，只能從[這裡](https://bol-line-bot-3.web.app/)進入

## 📂 檔案結構

```
schedule-app/
├── index.html              # 班表選擇頁面（唯讀版本）
├── view.html               # 班表查看頁面（支援 ?user= highlight）
├── styles.css              # Airbnb 風格樣式
├── firebase-config.js      # Firebase 配置
├── README.md               # 說明文件
│
└── edit-chart/             # 編輯班表（給管理員）
    ├── index.html          # 班表選擇頁面
    ├── edit-chart.html     # 班表編輯頁面
    ├── edit-user.html      # 使用者管理頁面
    ├── observation.html    # 使用數據觀察儀表板
    ├── difference.html     # 編輯記錄查看與還原
    └── app.js              # 核心應用程式邏輯

```

## 📊 Firestore 資料結構

### 系統設定 Collection（_config）

```javascript
// Document ID: "serve-list"
{
  serves: [
    { id: "youth-serve", name: "青年崇拜", emoji: "🎸" },
    { id: "kids-serve", name: "兒童崇拜", emoji: "🧒" },
    { id: "adult-serve", name: "成人崇拜", emoji: "⛪" }
  ]
}
```

### 班表 Collection（動態建立，如 youth-serve）

```javascript
// Document ID: "2026.01.04"（日期）
{
  主領: ["劉婕"],
  音控: ["家睿", "芯芳"],
  字幕: ["捷希"],
  彩排: ["週六 14:00"]  // 資訊欄位範例
}

// Document ID: "_metadata"
{
  serviceItems: ["主領", "音控", "字幕", "彩排", ...],
  nonUserColumns: ["彩排"],  // 資訊欄位（不包含人名的欄位）
  displayConfig: {
    groups: [
      {
        id: "worship-team",
        name: "敬拜團隊",
        items: ["主領", "音控", "字幕"],
        defaultVisible: true
      },
      {
        id: "ungrouped",
        name: "未分組",
        items: ["彩排"]
      }
    ],
    hidden: []  // 隱藏的服事項目
  }
}
```

### 使用者 Collection（users）

```javascript
// Document ID: "小明"（使用者名稱）
{
  alarm_type: [false, false, false, false, false, false], // 週一至週六提醒
  lineId: "",                    // LINE 使用者 ID
  line_bot_id: 1,                // 使用的 LINE Bot（0=未連線，1-4=Bot編號）
  login_token: "abc123...",      // 16字元登入邀請碼
  serve_types: {
    "youth-serve": ["主領", "音控"],  // 各場崇拜的服事項目
    "kids-serve": ["司會"]
  },
  usage_count: {                  // 使用統計
    "2026.01": {
      "全部班表": 15,
      "當週班表": 8,
      "換班": 2,
      "調班/代班成功通知": 3,
      "調班/代班失敗通知": 1
    }
  }
}
```

### 過期班表 Collection（Expired-{collection}）

```javascript
// 例如: Expired-youth-serve
// Document ID: "2025.12.28"（過期日期）
{
  主領: ["劉婕"],
  音控: ["家睿"]
}
```

### 編輯記錄 Collection（_edit_chart_log）

```javascript
// Document ID: "2026.01.07.19.22"（進入時間）
{
  "serve-id": "youth-serve",
  "origin-chart": { ... },      // 編輯前的完整班表
  "difference": { ... },        // 變更內容
  "last-edited-time": "2026.01.07.21.45"
}
```

## 🎨 設計特色

- 🎨 柔和的 Airbnb 風格色彩
- ✨ 流暢的動畫效果
- 💎 精緻的陰影和圓角
- 📱 響應式設計
- 🎯 30種人員顏色自動分配
- 🌊 平滑的過渡與互動效果

## 🔧 技術棧

- **前端框架**：原生 JavaScript（ES6+）
- **資料庫**：Firebase Firestore
- **安全性**：Firebase App Check + reCAPTCHA v3
- **部署**：Firebase Hosting
- **圖表**：Chart.js 4.4.1
- **模組化**：ES6 Modules
- **樣式**：CSS3 + CSS Variables

## ❓ 常見問題

### Q: 貼上 Excel 資料時為什麼是空的？
A: 請使用右鍵選單選擇起始格子，再點擊「從此格貼上」。

### Q: 如何還原誤刪的資料？
A: 管理員可在 `edit-chart/difference.html` 頁面查看編輯記錄並一鍵還原。

### Q: 撤銷功能有限制嗎？
A: 最多記錄20步操作，超過會覆蓋最舊的記錄。

### Q: 什麼是資訊欄位？
A: 資訊欄位是不包含人名的欄位（如「彩排」、「備註」），標記為資訊欄位後，該欄位的內容不會納入使用者管理的檢查，且在編輯時會顯示多文字輸入框介面而非人員選擇器。

### Q: 如何查看特定使用者的服事？
A: 在班表選擇頁面的網址加上 `?user=名字`，例如 `index.html?user=小美`，系統會自動只顯示該使用者有服事的崇拜。

### Q: 如何查看 LINE Bot 使用統計？
A: 管理員可進入 `edit-chart/observation.html` 查看詳細的使用數據分析，包含 Push Message 使用量、指令統計、調班成功率等。

### Q: 重新命名服事項目會影響 displayConfig 嗎？
A: 不會！系統會自動同步更新 displayConfig 中的所有相關引用，確保分組設定正常運作。

### Q: line_bot_id 的數字代表什麼？
A: 
- `0`：未連線（用戶未綁定任何 LINE Bot）
- `1`：使用第一台 LINE Bot
- `2`：使用第二台 LINE Bot
- `3-4`：預留給未來擴充

## 📝 更新日誌

### v3.5.0 (2026-02-01)
- 🆕 新增使用數據觀察儀表板
- 🐛 修正服事項目改名時 displayConfig 不同步的問題
- ✨ 資訊欄位支援多文字輸入框介面
- 🔧 優化 LINE Bot 分配邏輯

### v3.0.0 (2026-01-20)
- 🆕 支援多場崇拜管理
- 🆕 使用者可跨崇拜管理服事項目
- 🆕 支援多台 LINE Bot
- 🔧 重構資料結構

---

**Made with ❤️ for Church Ministry**
