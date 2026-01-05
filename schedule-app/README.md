# 教會服事班表系統

一個與 Firestore 連動的互動式教會服事班表網頁，採用 Airbnb 風格設計。

## ✨ 功能特色

### 📅 日期管理
- ✏️ 編輯任一日期，其他日期自動調整（保持7天間隔）
- ➕ 新增週次（自動加7天）
- ➖ 刪除最後一週

### 📋 服事項目管理
- ✨ 新增自訂服事項目
- ✏️ 編輯服事項目名稱
- 🗑️ 刪除服事項目

### 👥 人員管理
- 點擊格子編輯服事人員
- Dropdown 顯示所有出現過的人名
- 快速新增/刪除人員
- 人員以精美的積木（chip）方式顯示

### 🎯 進階功能
- 🖱️ **拖拉操作**：直接拖拉人員積木到其他格子
- 📋 **Excel 複製貼上**：從 Excel 複製資料，直接貼上到網頁（自動轉換格式）
- 🔄 **即時同步**：所有變更自動儲存到 Firestore

## 🚀 快速開始

### 1. 設定 Firebase

1. 前往 [Firebase Console](https://console.firebase.google.com/)
2. 建立新專案或選擇現有專案
3. 啟用 Firestore Database：
   - 在左側選單選擇「Firestore Database」
   - 點擊「建立資料庫」
   - 選擇「測試模式」（開發階段）或設定安全規則
4. 取得 Firebase 配置：
   - 前往「專案設定」 > 「一般」
   - 在「您的應用程式」區域，選擇 Web 應用程式（</>圖示）
   - 複製 Firebase 配置物件

### 2. 更新配置檔案

開啟 `firebase-config.js`，將示範配置替換為您的實際配置：

```javascript
export const firebaseConfig = {
  apiKey: "您的API金鑰",
  authDomain: "您的專案ID.firebaseapp.com",
  projectId: "您的專案ID",
  storageBucket: "您的專案ID.appspot.com",
  messagingSenderId: "您的messaging sender ID",
  appId: "您的app ID"
};
```

### 3. 啟動應用程式

由於使用了 ES6 模組，需要透過 HTTP 伺服器執行（不能直接開啟 HTML 檔案）。

**方法1：使用 Python（推薦）**
```bash
# Python 3
python -m http.server 8000

# 然後在瀏覽器開啟 http://localhost:8000
```

**方法2：使用 Node.js**
```bash
# 安裝 http-server
npm install -g http-server

# 啟動伺服器
http-server -p 8000

# 然後在瀏覽器開啟 http://localhost:8000
```

**方法3：使用 VS Code**
- 安裝 「Live Server」擴充功能
- 右鍵點擊 `index.html`，選擇「Open with Live Server」

### 4. 匯入初始資料（選用）

如果您有現有的 Excel 班表：

1. 開啟 Excel 檔案
2. 選擇並複製資料（包含日期和服事項目）
3. 在網頁中點擊表格左上角的格子
4. 按 `Ctrl+V`（Windows）或 `Cmd+V`（Mac）貼上
5. 確認匯入

**格式注意事項**：
- 複製時第一欄應該是日期
- 人名可以用 "/" 分隔（例如："佳柔/詠晴" 會自動分成兩個人）

## 📖 使用指南

### 編輯日期
1. 點擊任一日期
2. 輸入新日期（格式：yyyy.mm.dd，例如：2026.01.04）
3. 點擊「儲存」
4. 所有日期會自動調整，保持7天間隔

### 管理服事項目
1. **新增**：點擊「✨ 新增服事項目」按鈕
2. **編輯**：點擊表頭的 ✏️ 圖示
3. **刪除**：點擊表頭的 🗑️ 圖示

### 管理服事人員
1. **新增人員**：點擊格子，從下拉選單選擇或輸入新人名
2. **刪除人員**：點擊人員積木上的 × 按鈕
3. **移動人員**：直接拖拉人員積木到其他格子

### 拖拉操作
1. 滑鼠按住人員積木
2. 拖拉到目標格子
3. 放開滑鼠
4. 人員會從原格子移到新格子

### Excel 複製貼上
1. 在 Excel 中選擇要複製的資料範圍
2. 複製（Ctrl+C 或 Cmd+C）
3. 在網頁中按 Ctrl+V 或 Cmd+V
4. 確認匯入對話框
5. 資料會自動填入並儲存

## 🎨 設計特色

採用 Airbnb 風格設計系統：
- 🎨 柔和的色彩搭配
- ✨ 流暢的動畫效果
- 💎 精緻的陰影和圓角
- 📱 響應式設計（支援手機、平板、桌面）

## 🔒 安全性建議

### Firestore 安全規則

在正式環境中，建議設定適當的安全規則。在 Firebase Console > Firestore Database > 規則，設定：

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // 允許已驗證的使用者讀寫班表
    match /schedules/{document=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null;
    }
  }
}
```

**注意**：如果需要讓未登入的使用者也能存取，可以使用：
```javascript
match /schedules/{document=**} {
  allow read, write: if true;
}
```
但這樣任何人都可以修改資料，僅適合測試或內部使用。

## 📂 檔案結構

```
schedule-app/
├── index.html          # 主頁面
├── styles.css          # Airbnb 風格樣式
├── app.js              # 核心應用程式邏輯
├── firebase-config.js  # Firebase 配置
└── README.md           # 說明文件
```

## 🛠️ 技術架構

- **前端**：原生 HTML、CSS、JavaScript（無框架依賴）
- **資料庫**：Google Firestore（NoSQL 雲端資料庫）
- **設計**：Airbnb 風格設計系統
- **字體**：Google Fonts - Inter

## 📊 Firestore 資料結構

```javascript
// 集合名稱：schedules

// Document ID: "2026.01.04"（日期）
{
  彩排: ["1/3(六)4:30PM"],
  音控: ["家睿", "芯芳"],
  字幕: ["捷希"],
  招待: ["佳柔", "詠晴"]
}

// Document ID: "_metadata"（服事項目列表）
{
  serviceItems: ["彩排", "音控", "字幕", "招待"]
}
```

## ❓ 常見問題

### Q: 為什麼直接開啟 HTML 檔案無法運作？
A: 因為使用了 ES6 模組（`import`），瀏覽器安全性限制需要透過 HTTP 伺服器執行。請參考「啟動應用程式」章節。

### Q: 可以離線使用嗎？
A: 不行，需要網路連線才能與 Firestore 同步。未來可以考慮加入 Firestore 離線持久化功能。

### Q: 資料會自動儲存嗎？
A: 是的，所有變更都會立即儲存到 Firestore。

### Q: 可以多人同時編輯嗎？
A: 理論上可以，但目前版本沒有即時同步顯示其他人的變更。需要重新整理頁面才能看到最新資料。

### Q: 如何備份資料？
A: 可以在 Firebase Console 中匯出 Firestore 資料，或使用 Firebase CLI 工具。

## 🌟 未來改進方向

- [ ] 即時多人協作（使用 Firestore `onSnapshot`）
- [ ] 使用者登入與權限管理
- [ ] 匯出為 Excel 或 PDF
- [ ] 行動裝置 App 版本
- [ ] 自動提醒功能（email/LINE 通知）
- [ ] 服事人員統計與報表

## 📝 授權

此專案為教會內部使用，歡迎自由修改與使用。

## 💬 聯絡與支援

如有任何問題或建議，歡迎聯繫開發團隊。

---

**Made with ❤️ for Church Ministry**
