# 教會服事班表系統 — Vue + TypeScript 重構版

舊版 `schedule-app/`（原生 JS、無 build、CDN import）重構為 **Vite + Vue 3 + TypeScript** 的單頁應用（SPA），目標：

1. **管理端登入保護** — `edit-chart` 系列頁面需 Google 登入，且只有允許名單內的帳號可用（前端 guard + Firestore Security Rules 雙重把關）。
2. **大眾 Landing 頁** — 公開端新增首頁。
3. **可維護的程式結構** — 把 2000+ 行的 `app.js` / `ui.js` / `agent.js` 拆成型別化的 composables + 元件，對 vibe coding 友善。
4. **服務更多使用者** — 真正的安全規則、型別安全、模組化、向後相容的 URL。

> 採「新舊並存」策略：本專案獨立於舊的 `schedule-app/`，舊站維持線上；待驗證完成再把 Firebase Hosting 切到本專案（見最後「部署」一節）。

---

## 技術棧

| 項目 | 選擇 |
|------|------|
| 框架 | Vue 3（`<script setup>` + Composition API） |
| 語言 | TypeScript（strict） |
| 建置 | Vite |
| 路由 | Vue Router（history mode） |
| 狀態 | Pinia |
| 後端 | Firebase（Firestore + Auth + App Check）|
| 圖表 | Chart.js（儀表板用）|
| 試算表 | xlsx（匯入/匯出）|

---

## 快速開始

```bash
cd schedule-app-vue
npm install
npm run dev        # 本機開發 (http://localhost:5173)
npm run build      # 型別檢查 + 打包到 dist/
npm run preview    # 預覽打包結果
npm run typecheck  # 只跑型別檢查
```

### 環境設定

Firebase web 設定屬於「公開值」（安全性靠 Security Rules + App Check），因此 `src/firebase/config.ts`
內建了 `bol-line-bot-3` 專案的預設值，**開箱即可跑**。換專案時再複製 `.env.example` 成 `.env` 覆寫。

本機開發建議在 `.env` 設 `VITE_DISABLE_APP_CHECK=true`，避免 reCAPTCHA 網域限制擋住 localhost。

---

## 專案結構

```
src/
├── main.ts                      # 進入點：掛 Pinia + Router + 全域 CSS
├── App.vue                      # 只有 <router-view>
├── assets/styles/main.css       # 沿用舊版 styles.css（Airbnb 風格，含所有 CSS 變數）
├── firebase/
│   ├── config.ts                # 從 env 讀設定（含公開預設值 fallback）
│   └── index.ts                 # 初始化 app / App Check / Auth / Firestore，export db、auth
├── types/                       # 所有 Firestore 資料型別（單一真實來源）
│   ├── serve.ts schedule.ts user.ts log.ts agent.ts index.ts
├── utils/                       # 純函式（可測試、無副作用）
│   ├── dates.ts                 # getCurrentSunday(UTC+8)、format/parse、未來週日候選…
│   ├── colors.ts                # 30 色人名積木對應
│   └── schedule.ts              # cellOf、getVisibleServiceItems、collectPersonNames…
├── services/                    # 資料存取層（取代舊版 window.firestore 注入）
│   ├── serves.ts admins.ts schedule.ts users.ts
├── composables/
│   └── useAsyncData.ts          # 統一 loading/error/data
├── stores/                      # Pinia
│   ├── auth.ts                  # Google 登入 + 管理員允許名單 + whenReady()
│   └── serves.ts                # 崇拜清單快取
├── components/common/
│   ├── BaseModal.vue            # 共用彈窗（v-model）
│   └── AdminPlaceholder.vue     # 重構中頁面的佔位元件
├── router/index.ts              # 路由表 + .html alias + 管理員 guard
└── views/
    ├── public/
    │   ├── PublicHomeView.vue     # `/` 分派：有 ?user= → 選擇頁；無 → Landing
    │   ├── LandingView.vue        # 大眾 Landing（新需求 2）
    │   ├── PublicSelectView.vue   # 個人班表選擇（舊 index.html）
    │   └── PublicScheduleView.vue # 班表查看（舊 view.html）
    └── admin/
        ├── AdminLoginView.vue      # Google 登入 + 無權限提示
        ├── CollectionPickerView.vue# 崇拜選擇 + CRUD（舊 edit-chart/index.html）
        ├── EditChartView.vue       # 🚧 編輯器（待實作，見下）
        ├── EditUserView.vue        # 🚧 使用者管理（待實作）
        ├── ObservationView.vue     # 🚧 數據儀表板（待實作）
        ├── DifferenceView.vue      # 🚧 編輯記錄（待實作）
        └── AgentLogView.vue        # 🚧 AI 記錄（待實作）
```

---

## 認證與安全模型

### 允許名單
管理員 email 存在 Firestore `_config/admins`：

```json
// _config/admins
{ "emails": ["hcislab02@gmail.com"] }
```

需先在 Firebase Console 手動建立這份文件（或由現有管理員透過未來的管理 UI 維護）。
要新增管理員，把 email 加進陣列即可，**不需重新部署**。

### 雙重把關
1. **前端**：`router.beforeEach` 對 `meta.requiresAdmin` 的路由先 `auth.whenReady()`，再檢查
   `auth.user`（已登入）與 `auth.isAdmin`（在名單內）。未登入 → 導到 `/admin/login`。
2. **後端**：`firestore.rules` 的 `isAdmin()` 用 `get(_config/admins)` 在伺服器端再驗一次。
   公開端只能「讀」班表；所有「寫」都需要管理員。

### 啟用 Google 登入
Firebase Console → Authentication → Sign-in method → 啟用 **Google**，並把網域加進
Authorized domains（`localhost`、`bol-line-bot-3.web.app` 等）。

### 部署安全規則
```bash
# 在 repo 根目錄，firebase.json 需加入 firestore 設定（見「部署」），然後：
firebase deploy --only firestore:rules
```

> **殘留風險備註**：`users/{name}` 開放單筆 `get`（個人選擇頁需要），因此知道某人姓名者可讀到其
> `login_token`。如需更嚴格，建議後續把 `login_token` 移到僅管理員可讀的子文件。`list`（撈全部）
> 已限管理員，避免一次匯出所有人。

---

## 路由與向後相容

公開端入口維持在 `/`，相容 LINE Bot 發出的 `https://.../?user=名字`：

| 路徑 | 頁面 | 舊版 alias |
|------|------|-----------|
| `/`（有 `?user=`）| 個人班表選擇 | `/index.html` |
| `/`（無 `?user=`）| 大眾 Landing | — |
| `/view?service=&user=` | 班表查看 | `/view.html` |
| `/admin` | 崇拜選擇 | `/edit-chart`, `/edit-chart/index.html` |
| `/admin/edit?collection=` | 編輯器 | `/edit-chart/edit-chart.html` |
| `/admin/users` `/observation` `/difference` `/agent-log` | 各管理頁 | 對應 `/edit-chart/*.html` |

每條路由都掛了舊 `.html` 的 alias，未來切換 Hosting 時舊深層連結與書籤仍可運作。

---

## 目前進度

✅ **已完成（本階段）**
- 完整 Vite + Vue + TS 專案骨架、型別、工具、services、Pinia、router
- Firebase 整合（Auth / App Check / Firestore）
- Google 登入 + 管理員允許名單 + 路由 guard
- 公開端：Landing（新）、個人選擇、班表查看（含 displayConfig 分組、歷史週、人名標示）
- 管理端：崇拜選擇 + 新增/編輯/刪除（連動清理）
- Firestore Security Rules

✅ **班表編輯器**（取代 `app.js`/`ui.js`/`agent.js`）
- 資料/CRUD/撤銷重做/編輯記錄/分頁鎖/匯出 → [`stores/editor.ts`](src/stores/editor.ts) + [`services/scheduleWrite.ts`](src/services/scheduleWrite.ts)
- 表格、人員/服事/欄位/分組/貼上 modal、右鍵複製剪下貼上 → [`components/editor/`](src/components/editor/)
- AI 助手（模式/規則/參考·生成範圍/請假/送出/逐格審核）→ [`stores/agent.ts`](src/stores/agent.ts) + [`components/editor/AgentSidebar.vue`](src/components/editor/AgentSidebar.vue)
- 規則引擎（純函式）→ [`utils/ruleEngine.ts`](src/utils/ruleEngine.ts)

✅ **四個管理頁**：EditUserView、ObservationView（Chart.js）、DifferenceView、AgentLogView，
   及其 services（`editLogs.ts`、`agentLogs.ts`、`users.ts` 擴充）與元件（`components/admin/`）。

- **多格矩形選取**：長按拖選 + Ctrl+C/X/Delete + 外框，於 [composables/editor/useMultiSelect.ts](src/composables/editor/useMultiSelect.ts)。
- **AI 非線性進度條**：排班等待的分段進度條（含重試延長），於 [stores/agent.ts](src/stores/agent.ts) + AgentSidebar。

### 已知簡化（與舊版差異，皆為非核心）
- **人名匿名化實驗**：未移植（舊版 `USE_ANONYMIZATION` 預設關閉）。

---

## 本機讀取線上資料（App Check）

線上 Firestore 有 **App Check 強制**，localhost 預設讀不到資料（`permission-denied`）。要在本機看到真資料：

1. Firebase Console → App Check → Apps → 管理 debug token → 新增一組。
2. `.env` 設 `VITE_APPCHECK_DEBUG_TOKEN=<該 token>`，並移除/設 `VITE_DISABLE_APP_CHECK=false`。
3. `npm run dev`。

另有 `VITE_DEV_BYPASS_AUTH=true`（**僅 dev build 生效**）可略過管理端登入，方便本機截圖/比對。

---

## 部署（切換 Hosting）

1. `npm run build` → 產出 `dist/`。
2. 在 repo 根 `firebase.json` 把 hosting `public` 指向 `schedule-app-vue/dist`，並保留 SPA rewrite：
   ```json
   {
     "hosting": {
       "public": "schedule-app-vue/dist",
       "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
       "rewrites": [{ "source": "**", "destination": "/index.html" }]
     },
     "firestore": { "rules": "schedule-app-vue/firestore.rules" }
   }
   ```
3. `firebase deploy --only hosting,firestore:rules`
4. 先在 Firebase Hosting preview channel 驗證（`firebase hosting:channel:deploy preview`）再切正式。

> ⚠️ 切換前務必確認 `_config/admins` 已建立、Google 登入已啟用、且 `_service_*` 班表讀取在
> 規則生效後仍正常（公開讀），否則大眾頁會壞掉。
