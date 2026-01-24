# 教會服事班表系統

一個與 Firestore 連動的互動式教會服事班表網頁

## ✨ 功能特色

### 🎯 三種使用者介面

| 介面 | 路徑 | 功能 |
|------|------|------|
| 📖 **班表查看** | `schedule-app/` | 只能查看班表，支援使用者 highlight |
| ✏️ **班表編輯** | `edit-chart/` | 編輯班表、管理使用者，支援撤銷/重做 |
| 🔧 **編輯記錄** | `chart-difference/` | 查看編輯記錄，一鍵還原 |

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

### 👥 人員管理
- 點擊格子編輯服事人員
- 顯示在該服事有經驗的人員優先
- 人員以彩色積木（chip）方式顯示（30種顏色）

### 👤 使用者管理
- 📜 **編輯記錄**：查看班表編輯歷史並可一鍵還原
- 👥 **管理使用者**：統一管理所有服事人員資料
  - 🔄 自動加入使用者 & 更新服事
  - ⏰ 提醒設定（週一至週六）
  - 🔗 LINE ID 綁定
  - 📋 跨崇拜服事項目管理
- ⚠️ **即時警示**：當班表有未註冊或需更新的使用者時顯示提醒
- ℹ️ **資訊欄位排除**：標記為資訊欄位的項目不會納入使用者檢查

### ⛪ 崇拜管理（新功能）
- ➕ **新增崇拜**：管理員可新增最多 5 場崇拜
- ✏️ **編輯名稱**：可更改崇拜名稱和 Emoji
- 🗑️ **刪除崇拜**：需輸入崇拜名稱確認，防止誤刪
- 🎨 **10種 Emoji**：⛪ 🎸 🧒 👥 🎵 📖 🙏 ✝️ 🕊️ 💒

### 🔍 班表查看功能
- 🔦 **使用者專屬連結**：網址使用 `?user=名字` 只顯示該使用者有服事的崇拜
- 🎯 **單一崇拜自動跳轉**：若使用者只有一個崇拜，自動進入該崇拜班表
- 📅 **顯示歷史**：可選擇顯示過去的班表資料

### 🔄 撤銷/重做功能
- ⬅️ Ctrl+Z 撤銷（最多20步）
- ➡️ Ctrl+Y 重做
- 按鈕也可使用

### 📝 編輯記錄系統
- 自動記錄每次編輯的原始狀態和變更差異
- 儲存在 `_edit_chart_log` collection
- 管理員可查看並一鍵還原

### 🎯 進階功能
- 🖱️ **拖拉操作**：直接拖拉人員積木到其他格子
- 📋 **右鍵貼上**：從 Excel 複製資料，右鍵選擇起始格子貼上
- 🔄 **即時同步**：所有變更自動儲存到 Firestore

## 🚀 快速開始

### 1. 設定 Firebase

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 建立新專案或選擇現有專案
3. 啟用 Firestore Database
4. 取得 Firebase 配置

### 2. 更新配置檔案

開啟 `firebase-config.js`，替換為您的實際配置。

### 3. 啟動應用程式

已使用 Firebase Hosting 部署，且使用reCAPTCHA v3限定網域，只能從[這裡](https://bol-line-bot-3.web.app/)進入

## 📂 檔案結構

```
schedule-app/
├── index.html           # 班表選擇頁面（唯讀版本）
├── view.html            # 班表查看頁面（支援 ?user= highlight）
├── styles.css           # Airbnb 風格樣式
├── firebase-config.js   # Firebase 配置
├── README.md            # 說明文件
│
├── edit-chart/          # 編輯班表（給管理員）
│   ├── index.html       # 班表選擇頁面
│   ├── edit-chart.html  # 班表編輯頁面
│   ├── edit-user.html   # 使用者管理頁面
│   └── app.js           # 核心應用程式邏輯
│
└── chart-difference/    # 編輯記錄（給管理員）
    ├── index.html       # 班表選擇頁面
    └── difference.html  # 編輯記錄查看與還原
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
  字幕: ["捷希"]
}

// Document ID: "_metadata"
{
  serviceItems: ["主領", "音控", "字幕", "彩排", ...],
  nonUserColumns: ["彩排"],  // 資訊欄位（不包含人名的欄位）
  displayConfig: {
    groups: [...],
    hidden: [...]
  }
}
```

### 使用者 Collection（users）

```javascript
// Document ID: "小明"（使用者名稱）
{
  alarm_type: [false, false, false, false, false, false], // 週一至週六提醒
  lineId: "",                                              // LINE 使用者 ID
  serve_types: {
    "youth-serve": ["主領", "音控"],                        // 各場崇拜的服事項目
    "kids-serve": ["司會"]
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

## ❓ 常見問題

### Q: 貼上 Excel 資料時為什麼是空的？
A: 請使用右鍵選單選擇起始格子，再點擊「從此格貼上」。

### Q: 如何還原誤刪的資料？
A: 管理員可在 `chart-difference/` 頁面查看編輯記錄並一鍵還原。

### Q: 撤銷功能有限制嗎？
A: 最多記錄20步操作，超過會覆蓋最舊的記錄。

### Q: 什麼是資訊欄位？
A: 資訊欄位是不包含人名的欄位（如「彩排」、「備註」），標記為資訊欄位後，該欄位的內容不會納入使用者管理的檢查。

### Q: 如何查看特定使用者的服事？
A: 在班表選擇頁面的網址加上 `?user=名字`，例如 `index.html?user=小美`，系統會自動只顯示該使用者有服事的崇拜。

---

**Made with ❤️ for Church Ministry**
