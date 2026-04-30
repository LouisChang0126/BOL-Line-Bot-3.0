// --- 引入 Agent 功能 ---
import { initAgentFeature, showModalAlert } from './agent.js';

// --- 引入 UI 渲染與彈窗 ---
import {
    renderTable, renderTableHead, renderTableBody, renderSingleCell,
    initDisplayConfigEditor,
    openEditPersonModal, renderPersonDropdown, renderCurrentPersonChips, renderInfoInputs,
    setUIContext, showConfirm
} from './ui.js';

// ===========================
// 全域變數
// ===========================
export let scheduleData = []; // 所有班表資料（今天以後）
let pastData = []; // 過去的資料（今天之前，最多26筆）
let pastDataLoaded = false; // 歷史資料是否已載入
let showingPast = false; // 是否顯示過去資料
export let serviceItems = []; // 服事項目列表
export let nonUserColumns = []; // 資訊欄位列表（不包含人名的欄位）
export let allPersonNames = new Set(); // 所有出現過的人名
let currentEditingCell = null; // 目前編輯的儲存格（ui.js 開啟 modal 時透過 setCurrentEditingCell 同步）
let displayConfig = null; // 服事項目分組顯示設定
let registeredUsersCache = {};
let usersCacheReady = false;
let usersCacheInitPromise = null;
let usersUnsubscribe = null;

/**
 * 取消既有的 users Firestore listener，並把 cache 狀態重置，
 * 讓下次 ensureUsersCache() 會重新建立訂閱。
 * 於 loadData 入口、beforeunload、pagehide 時呼叫，避免 listener 殘留 / 重複訂閱。
 */
function cancelUsersListener() {
    if (typeof usersUnsubscribe === 'function') {
        try { usersUnsubscribe(); } catch (_) { /* ignore */ }
    }
    usersUnsubscribe = null;
    usersCacheReady = false;
    usersCacheInitPromise = null;
}

// ===========================
// 單一編輯分頁鎖（per-collection）
// ===========================
// 系統假設「同一個 collection 同一時間只有一個管理員編輯」。實作方式：
// - 每個分頁開啟時生成 tabId（sessionStorage，per-tab），同時把 tabId 寫進
//   localStorage.editor_active_tab__{collection} —— key 包含 collection 名稱
// - 監聽 storage event：別的分頁覆寫「同一個 collection 的 key」時才鎖定自己；
//   不同 collection 的 key 互不影響（_service_5 / _service_4 可同時編輯）
// - 鎖定後：所有寫入路徑開頭呼叫 _assertEditing()，未持有 active 身份直接 throw 並彈出 modal
// - 使用者按 modal 上的「在此分頁繼續編輯」→ reload 頁面（拿到最新資料、重新 claim）
//
// 注意：localStorage 只在同一個瀏覽器同 origin 共享。跨裝置 / 跨瀏覽器無保護，
// 但這個系統只有一個管理員，跨裝置同時編輯是邊角案例。
const TAB_LOCK_STORAGE_KEY_PREFIX = 'editor_active_tab__';
const TAB_LOCK_SESSION_KEY = 'editor_tab_id';

let _myTabId = null;
let _isLockedTab = false;
let _tabLockStorageKey = null;  // 含 collection 後綴的完整 localStorage key

function _initTabLock() {
    try {
        // collection 名稱在 edit-chart.html 的 inline module 已經 set 到 window 上才 import app.js
        const collection = String(window.COLLECTION_NAME || '_default');
        _tabLockStorageKey = TAB_LOCK_STORAGE_KEY_PREFIX + collection;

        _myTabId = sessionStorage.getItem(TAB_LOCK_SESSION_KEY);
        if (!_myTabId) {
            _myTabId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
            sessionStorage.setItem(TAB_LOCK_SESSION_KEY, _myTabId);
        }
        // 一進入頁面就 claim active editor（per collection）
        localStorage.setItem(_tabLockStorageKey, _myTabId);
        _isLockedTab = false;

        // 監聽其他分頁搶走「同一個 collection 的」active 身份；其他 collection 無視
        window.addEventListener('storage', (e) => {
            if (e.key !== _tabLockStorageKey) return;
            if (e.newValue && e.newValue !== _myTabId) {
                _enterLockedState();
            }
        });
    } catch (err) {
        // 儲存層異常（隱私模式 / quota）退回單分頁假設，不擋功能
        console.warn('Tab lock init failed:', err);
        _isLockedTab = false;
    }
}

function _enterLockedState() {
    if (_isLockedTab) return;
    _isLockedTab = true;
    _showTabLockOverlay();
}

/**
 * 寫入路徑都先呼叫這個。被鎖時拋 TAB_LOCKED，呼叫端可選擇靜默 swallow（修法：UI 已經
 * 顯示 modal、不需額外 alert）。
 */
function _assertEditing() {
    if (_isLockedTab) {
        _showTabLockOverlay();
        throw new Error('TAB_LOCKED');
    }
}

// 對外導出讓其他模組（agent.js 等）可以提前 gate
export function isTabLocked() { return _isLockedTab; }
export function assertEditing() { _assertEditing(); }

function _showTabLockOverlay() {
    let overlay = document.getElementById('tabLockOverlay');
    if (overlay) {
        overlay.classList.remove('hidden');
        return;
    }
    overlay = document.createElement('div');
    overlay.id = 'tabLockOverlay';
    overlay.innerHTML = `
        <div class="tab-lock-modal">
            <div class="tab-lock-icon">🔒</div>
            <h2>你已在其他分頁開啟編輯</h2>
            <p>為避免資料衝突，同時間只能有一個分頁進行編輯</p>
            <div class="tab-lock-btns">
                <button id="tabLockCloseBtn" class="tab-lock-btn tab-lock-btn-secondary">關閉這個分頁</button>
                <button id="tabLockTakeoverBtn" class="tab-lock-btn">在此分頁繼續編輯</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // 「在此分頁繼續編輯」→ reload，重新 claim active 並拿最新資料
    const takeoverBtn = document.getElementById('tabLockTakeoverBtn');
    if (takeoverBtn) {
        takeoverBtn.addEventListener('click', () => {
            try { if (_tabLockStorageKey) localStorage.setItem(_tabLockStorageKey, _myTabId); } catch (_) {}
            window.location.reload();
        });
    }

    // 「關閉這個分頁」→ window.close()。
    // 注意：瀏覽器只允許關閉「由 script 開啟」的分頁；使用者直接打 URL 開的分頁會 silently fail。
    // fallback：把頁面導到 about:blank，讓使用者明確知道關閉動作沒生效、可以手動關掉。
    const closeBtn = document.getElementById('tabLockCloseBtn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            window.close();
            // 若 window.close 被瀏覽器擋下，這行才會執行
            setTimeout(() => {
                if (!window.closed) {
                    document.title = '請手動關閉此分頁';
                    document.body.innerHTML = '<div style="padding:40px;text-align:center;font-family:system-ui">瀏覽器不允許 script 關閉這個分頁，請手動關閉。</div>';
                }
            }, 200);
        });
    }
}

// 在 module load 時就 claim
_initTabLock();

// 最大顯示/新增限制
const MAX_FUTURE_ROWS = 52; // 未來資料最多52筆
const MAX_PAST_ROWS = 26; // 歷史資料最多26筆

// ===========================
// 編輯記錄系統
// ===========================
let originalChart = null; // 進入頁面時的班表快照
let hasEdited = false; // 是否有編輯過
let editDifference = {}; // 記錄編輯差異
let currentSessionSources = new Set(); // 記錄當前 session 所有的編輯來源
let logWasWritten = false; // 本 session 是否曾寫入過 Firestore log
let _saveDebounceTimer = null; // 自動存檔的 debounce timer

// ===========================
// 撤銷/重做系統 (最多 20 步)
// ===========================
const MAX_HISTORY_SIZE = 20;
let historyStack = []; // 歷史記錄堆疊
let historyIndex = -1; // 目前在歷史中的位置
let isRestoring = false; // 防止 undo/redo 並發

// ===========================
// 日期工具函數
// ===========================
// 取得當前週日日期（UTC+8 時區，週日為基準）
// 如果今天是週日，返回今天；否則返回下一個週日
function getCurrentSunday() {
    const now = new Date();
    const utc8Offset = 8 * 60 * 60 * 1000;
    const utc8Now = new Date(now.getTime() + utc8Offset + now.getTimezoneOffset() * 60000);

    const dayOfWeek = utc8Now.getDay();
    const sunday = new Date(utc8Now);

    if (dayOfWeek === 0) {
        // 今天是週日，返回今天
        sunday.setHours(0, 0, 0, 0);
    } else {
        // 今天不是週日，返回下一個週日
        sunday.setDate(utc8Now.getDate() + (7 - dayOfWeek));
        sunday.setHours(0, 0, 0, 0);
    }
    return sunday;
}

// ===========================
// 30 種固定顏色供人名積木使用
// ===========================
const PERSON_CHIP_COLORS = [
    '#E74C3C', '#3498DB', '#2ECC71', '#9B59B6', '#F39C12', '#1ABC9C', '#E91E63', '#00BCD4',
    '#8BC34A', '#FF5722', '#673AB7', '#009688', '#3949AB', '#795548', '#7CB342', '#FF9800',
    '#4CAF50', '#2196F3', '#F44336', '#9C27B0', '#00ACC1', '#AD1457', '#C0392B', '#D35400',
    '#16A085', '#8E44AD', '#27AE60', '#2980B9', '#283593', '#34495E'
];

// 人名到顏色的映射快取
export let personColorMap = new Map();

// ===========================
// 初始化應用程式
// ===========================
async function initApp() {
    console.log('應用程式初始化中...');

    // 等待 Firebase 初始化
    await waitForFirebase();

    // 載入資料
    await loadData();

    // 保存原始班表快照（用於編輯記錄）
    saveOriginalChartSnapshot();

    // 初始化歷史記錄
    initHistory();

    // 設定事件監聽器
    setupEventListeners();

    // 設定貼上事件
    setupPasteHandler();

    // 設定貼上預覽 Modal
    setupPastePreviewModal();

    // 設定撤銷/重做事件
    setupUndoRedoHandler();

    // 設定頁面離開前儲存編輯記錄
    setupBeforeUnloadHandler();

    // 初始化分組編輯功能
    initDisplayConfigEditor();
    await loadDisplayConfig();

    // 初始同步 UI 狀態
    syncUIContext();

    updateStatus('就緒');
    console.log('應用程式初始化完成');
}

// 根據載入狀態決定何時執行
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

// 等待 Firebase 初始化
function waitForFirebase() {
    return new Promise((resolve) => {
        const checkFirebase = setInterval(() => {
            if (window.db && window.firestore) {
                clearInterval(checkFirebase);
                resolve();
            }
        }, 100);
    });
}

// ===========================
// 資料載入與同步
// ===========================
async function loadData() {
    updateStatus('載入資料中...');

    // 取消上一輪可能殘留的 users listener，避免重複訂閱 / 記憶體洩漏
    cancelUsersListener();

    try {
        const { collection, getDocs, query, orderBy, doc, getDoc, where, limit } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;

        // 載入服事項目
        const metadataDoc = await getDoc(doc(db, COLLECTION_NAME, '_metadata'));
        if (metadataDoc.exists()) {
            const md = metadataDoc.data();
            serviceItems = md.serviceItems || [];
            nonUserColumns = md.nonUserColumns || [];
        } else {
            throw new Error('沒有 metadata');
        }

        // 取得當前週日字串
        const currentSundayStr = formatDateString(getCurrentSunday());

        // 使用 Firestore query 只載入當前週日以後的資料
        const q = query(
            collection(db, COLLECTION_NAME),
            where('__name__', '>=', currentSundayStr),
            orderBy('__name__'),
            limit(MAX_FUTURE_ROWS)
        );
        const querySnapshot = await getDocs(q);

        scheduleData = [];
        querySnapshot.forEach((docRef) => {
            if (docRef.id !== '_metadata') {
                const data = docRef.data();
                const row = { date: docRef.id, ...data };
                scheduleData.push(row);

                // 收集所有人名
                serviceItems.forEach(item => {
                    // 跳過資訊欄位
                    if (nonUserColumns.includes(item)) {
                        return;
                    }

                    if (data[item] && Array.isArray(data[item])) {
                        data[item].forEach(name => allPersonNames.add(name));
                    }
                });
            }
        });

        // 如果沒有未來資料，建立初始資料
        if (scheduleData.length === 0) {
            await createInitialData();
            console.log('已建立初始資料');
        }

        // 更新顯示歷史資料按鈕狀態
        updateShowPastButton();

        // 重建人名顏色映射
        rebuildPersonColorMap();

        // 渲染表格
        renderTable();

    } catch (error) {
        console.error('載入資料失敗:', error);
        updateStatus('載入失敗');
        alert('載入資料失敗，請檢查 Firebase 配置與網路連線。');
    }
}

// 載入歷史資料（延遲載入，第一次點擊時才調用）
async function loadPastData() {
    if (pastDataLoaded) return; // 已載入則跳過
    pastDataLoaded = true;

    updateStatus('載入歷史資料中...');

    try {
        const { collection, getDocs, query, orderBy, where } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;
        const currentSundayStr = formatDateString(getCurrentSunday());

        // 使用 Firestore query 載入當前週日之前的資料
        // 注意：不使用 desc 排序以避免需要索引
        // 計算 MAX_PAST_ROWS 週前的日期
        const minPastDate = new Date(getCurrentSunday());
        minPastDate.setDate(minPastDate.getDate() - (MAX_PAST_ROWS * 7));
        const minPastDateStr = formatDateString(minPastDate);

        const q = query(
            collection(db, COLLECTION_NAME),
            where('__name__', '>=', minPastDateStr),
            where('__name__', '<', currentSundayStr),
            orderBy('__name__')
        );
        const snapshot = await getDocs(q);

        pastData = [];
        snapshot.forEach((docRef) => {
            if (docRef.id !== '_metadata') {
                const data = docRef.data();
                pastData.push({ date: docRef.id, ...data });
            }
        });

        updateStatus('就緒');
    } catch (error) {
        console.error('載入歷史資料失敗:', error);
        pastData = [];
        updateStatus('就緒');
    }

    // 通知其他模組（例如 agent.js 的參考週次下拉）pastData 已就緒
    try { window.dispatchEvent(new CustomEvent('pastDataLoaded')); } catch (_) { /* noop */ }
}

// 更新顯示歷史資料按鈕狀態
function updateShowPastButton() {
    const btn = document.getElementById('showPastBtn');
    if (btn) {
        // 始終顯示按鈕，因為延遲載入
        btn.style.display = 'inline-flex';
        if (pastDataLoaded && pastData.length > 0) {
            btn.textContent = showingPast ? '📅 隱藏歷史' : `📅 顯示歷史 (${pastData.length}筆)`;
        } else if (pastDataLoaded && pastData.length === 0) {
            btn.textContent = '📅 無歷史';
            btn.disabled = true;
        } else {
            btn.textContent = '📅 顯示歷史';
        }
    }
}

// 切換顯示歷史資料
async function togglePastData() {
    if (!showingPast && !pastDataLoaded) {
        // 第一次點擊時載入歷史資料
        await loadPastData();
    }
    showingPast = !showingPast;
    syncUIContext();
    updateShowPastButton();
    renderTable();
}

// 建立初始資料（從下個週日開始的 4 週）
async function createInitialData() {
    // 取得下個週日日期（使用 getCurrentSunday，它已經計算下個週日）
    const startDate = getCurrentSunday();

    // 設定預設服事項目
    serviceItems = ['範例服事'];
    await saveMetadata();

    for (let i = 0; i < 4; i++) {
        const date = new Date(startDate);
        date.setDate(date.getDate() + (i * 7));

        const dateStr = formatDateString(date);
        const data = {};

        serviceItems.forEach(item => {
            data[item] = [];
        });

        scheduleData.push({
            date: dateStr,
            ...data
        });

        // 儲存到 Firestore
        await saveSchedule(dateStr, data);
    }
}

/**
 * 多 doc 批次寫入。配合分頁鎖（_assertEditing）就足以保證單一管理員的一致性
 *
 * @param {Object} opts
 * @param {Array<{date:string,data:Object}>} opts.rowUpdates - 要 set 的班表列；data 不含 date
 * @param {Array<string>} opts.rowDeletes - 要刪除的日期
 * @param {Object|null} opts.metadata - { serviceItems, nonUserColumns, displayConfig? }；null = 不動 metadata
 */
async function _bulkWrite({ rowUpdates = [], rowDeletes = [], metadata = null } = {}) {
    _assertEditing();
    const { writeBatch, doc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;
    const batch = writeBatch(db);

    rowUpdates.forEach(({ date, data }) => {
        const ref = doc(db, COLLECTION_NAME, date);
        const cleanData = { ...data };
        delete cleanData.date;
        batch.set(ref, cleanData);
    });
    rowDeletes.forEach(date => {
        batch.delete(doc(db, COLLECTION_NAME, date));
    });
    if (metadata) {
        const metaRef = doc(db, COLLECTION_NAME, '_metadata');
        batch.set(metaRef, metadata);
    }

    await batch.commit();
}

// 儲存 metadata（受分頁鎖保護）
export async function saveMetadata() {
    _assertEditing();
    const { doc, setDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    const metadata = {
        serviceItems: serviceItems,
        nonUserColumns: nonUserColumns
    };
    if (displayConfig) {
        metadata.displayConfig = displayConfig;
    }

    const ref = doc(db, COLLECTION_NAME, '_metadata');
    await setDoc(ref, metadata);
}

// 儲存班表資料（受分頁鎖保護）
export async function saveSchedule(dateStr, data) {
    _assertEditing();
    const { doc, setDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    const saveData = { ...data };
    delete saveData.date;

    const ref = doc(db, COLLECTION_NAME, dateStr);
    await setDoc(ref, saveData);
}

// 刪除班表資料
async function deleteSchedule(dateStr) {
    _assertEditing();
    const { doc, deleteDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    await deleteDoc(doc(db, COLLECTION_NAME, dateStr));
}

// ===========================
// 表格渲染 — 已移至 ui.js，由此重新匯出
// ===========================
export { renderTable, renderTableHead, renderTableBody };

// ===========================
// 日期管理
// ===========================
export async function addNewRow(skipConfirm = false) {
    if (scheduleData.length === 0) {
        if (!skipConfirm) alert('請先建立初始資料');
        return;
    }

    // 檢查是否已達到最大筆數限制
    if (scheduleData.length >= MAX_FUTURE_ROWS) {
        alert(`已達到最大筆數限制（${MAX_FUTURE_ROWS}週），無法新增更多資料。`);
        return;
    }

    updateStatus('新增一週中...');

    try {
        // 取得最後一個日期
        const lastDate = parseDateString(scheduleData[scheduleData.length - 1].date);

        // 加 7 天
        const newDate = new Date(lastDate);
        newDate.setDate(newDate.getDate() + 7);
        const newDateStr = formatDateString(newDate);

        // 建立新資料
        const data = {};
        serviceItems.forEach(item => {
            data[item] = [];
        });

        scheduleData.push({
            date: newDateStr,
            ...data
        });

        // 儲存到 Firestore
        await saveSchedule(newDateStr, data);

        pushHistory();
        updateEditDifference();
        renderTable();
        updateStatus('已新增一週');

    } catch (error) {
        console.error('新增一週失敗:', error);
        alert('新增一週失敗');
        updateStatus('就緒');
    }
}

export async function deleteLastRow(skipConfirm = false) {
    if (scheduleData.length === 0) {
        if (!skipConfirm) alert('沒有資料可刪除');
        return;
    }

    if (!skipConfirm) {
        const confirmResult = await showConfirm('確定要刪除最後一週的資料嗎？');
        if (!confirmResult) return;
    }

    updateStatus('刪除中...');

    let lastRow = null;

    try {
        lastRow = scheduleData.pop();

        // 判斷被刪除的那週是否有任何非空白的服事資料
        const rowHasData = serviceItems.some(s => {
            const val = lastRow[s];
            return Array.isArray(val) ? val.length > 0 : !!val;
        });

        await deleteSchedule(lastRow.date);

        pushHistory();
        updateEditDifference();
        renderTable();
        updateStatus('已刪除最後一週');

    } catch (error) {
        console.error('刪除失敗:', error);
        alert('刪除失敗');
        if (lastRow) scheduleData.push(lastRow); // 還原
        updateStatus('就緒');
    }
}

// ===========================
// 服事項目管理
// ===========================



export async function doAddColumn(trimmedName, isInfo = false) {
    const label = isInfo ? '資訊欄位' : '服事項目';
    updateStatus(`新增${label}中...`);
    try {
        serviceItems.push(trimmedName);
        if (isInfo) nonUserColumns.push(trimmedName);

        // 將新欄位加入 displayConfig 的「未分組」群組
        if (displayConfig && displayConfig.groups) {
            const ungrouped = displayConfig.groups.find(g => g.id === 'ungrouped');
            if (ungrouped) ungrouped.items.push(trimmedName);
        }

        // 為每列加上新欄位空陣列
        scheduleData.forEach(row => { row[trimmedName] = []; });

        const rowUpdates = scheduleData.map(row => ({ date: row.date, data: { ...row } }));
        const metadata = { serviceItems, nonUserColumns };
        if (displayConfig) metadata.displayConfig = displayConfig;

        await _bulkWrite({ rowUpdates, metadata });

        pushHistory();
        updateEditDifference();
        renderTable();
        updateStatus(`${label}已新增`);
    } catch (error) {
        // 分頁鎖定 → modal 已顯示，靜默 swallow；其他 → 回滾記憶體
        if (error && error.message === 'TAB_LOCKED') return;
        console.error(`新增${label}失敗:`, error);
        showModalAlert(`新增${label}失敗`);
        serviceItems.pop();
        if (isInfo) nonUserColumns.pop();
        scheduleData.forEach(row => { delete row[trimmedName]; });
        if (displayConfig && displayConfig.groups) {
            const ungrouped = displayConfig.groups.find(g => g.id === 'ungrouped');
            if (ungrouped) {
                const idx = ungrouped.items.indexOf(trimmedName);
                if (idx > -1) ungrouped.items.splice(idx, 1);
            }
        }
        updateStatus('就緒');
    }
}


export async function deleteServiceItem(serviceName, skipConfirm = false) {
    if (!skipConfirm) {
        const confirmResult = await showConfirm(`確定要刪除服事項目「${serviceName}」嗎？這將刪除所有相關資料。`);
        if (!confirmResult) return;
    }

    updateStatus('刪除服事項目中...');

    try {
        // 從列表中移除
        const index = serviceItems.indexOf(serviceName);
        serviceItems.splice(index, 1);

        // 從 displayConfig 中移除該服事項目
        if (displayConfig) {
            // 從所有群組中移除
            if (displayConfig.groups) {
                displayConfig.groups.forEach(group => {
                    const itemIndex = group.items.indexOf(serviceName);
                    if (itemIndex > -1) group.items.splice(itemIndex, 1);
                });
            }
            // 從隱藏列表中移除
            if (displayConfig.hidden) {
                const hiddenIndex = displayConfig.hidden.indexOf(serviceName);
                if (hiddenIndex > -1) displayConfig.hidden.splice(hiddenIndex, 1);
            }
        }

        // 從 nonUserColumns 中移除
        const nIdx = nonUserColumns.indexOf(serviceName);
        if (nIdx > -1) nonUserColumns.splice(nIdx, 1);

        scheduleData.forEach(row => { delete row[serviceName]; });

        const rowUpdates = scheduleData.map(row => ({ date: row.date, data: { ...row } }));
        const metadata = { serviceItems, nonUserColumns };
        if (displayConfig) metadata.displayConfig = displayConfig;

        await _bulkWrite({ rowUpdates, metadata });

        pushHistory();
        updateEditDifference();
        renderTable();
        closeModal('editServiceModal');
        updateStatus('服事項目已刪除');

    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        console.error('刪除服事項目失敗:', error);
        alert('刪除服事項目失敗');
        updateStatus('就緒');
    }
}

// ===========================
// 人員管理
// ===========================

// 新增資訊項目
export async function applyAgentStructuralChanges({
    addWeeks = 0,
    removeWeeks = 0,
    addServiceColumns = [],
    removeServiceColumns = []
} = {}) {
    const normalizedAddWeeks = Math.max(0, Number(addWeeks) || 0);
    const normalizedRemoveWeeks = Math.max(0, Number(removeWeeks) || 0);
    const normalizedAddCols = Array.isArray(addServiceColumns) ? addServiceColumns : [];
    const normalizedRemoveCols = Array.isArray(removeServiceColumns) ? removeServiceColumns : [];

    if (
        normalizedAddWeeks === 0 &&
        normalizedRemoveWeeks === 0 &&
        normalizedAddCols.length === 0 &&
        normalizedRemoveCols.length === 0
    ) {
        return;
    }

    const removedDates = [];

    const removable = Math.min(normalizedRemoveWeeks, scheduleData.length);
    for (let i = 0; i < removable; i++) {
        const removed = scheduleData.pop();
        if (removed?.date) removedDates.push(removed.date);
    }

    const addable = Math.min(normalizedAddWeeks, Math.max(0, MAX_FUTURE_ROWS - scheduleData.length));
    for (let i = 0; i < addable; i++) {
        if (scheduleData.length === 0) break;

        const lastDate = parseDateString(scheduleData[scheduleData.length - 1].date);
        const newDate = new Date(lastDate);
        newDate.setDate(newDate.getDate() + 7);
        const newDateStr = formatDateString(newDate);

        const rowData = {};
        serviceItems.forEach(item => { rowData[item] = []; });
        scheduleData.push({ date: newDateStr, ...rowData });
    }

    for (const colName of normalizedRemoveCols) {
        if (!serviceItems.includes(colName)) continue;

        const idx = serviceItems.indexOf(colName);
        if (idx > -1) serviceItems.splice(idx, 1);

        const nIdx = nonUserColumns.indexOf(colName);
        if (nIdx > -1) nonUserColumns.splice(nIdx, 1);

        if (displayConfig) {
            if (displayConfig.groups) {
                displayConfig.groups.forEach(group => {
                    const itemIndex = group.items.indexOf(colName);
                    if (itemIndex > -1) group.items.splice(itemIndex, 1);
                });
            }
            if (displayConfig.hidden) {
                const hiddenIndex = displayConfig.hidden.indexOf(colName);
                if (hiddenIndex > -1) displayConfig.hidden.splice(hiddenIndex, 1);
            }
        }

        scheduleData.forEach(row => {
            delete row[colName];
        });
    }

    for (const colName of normalizedAddCols) {
        if (!colName || serviceItems.includes(colName)) continue;

        serviceItems.push(colName);
        scheduleData.forEach(row => {
            row[colName] = [];
        });

        if (displayConfig && displayConfig.groups) {
            const ungrouped = displayConfig.groups.find(g => g.id === 'ungrouped');
            if (ungrouped && !ungrouped.items.includes(colName)) {
                ungrouped.items.push(colName);
            }
        }
    }

    const rowUpdates = scheduleData.map(row => ({ date: row.date, data: { ...row } }));
    const metadata = { serviceItems, nonUserColumns };
    if (displayConfig) metadata.displayConfig = displayConfig;

    try {
        await _bulkWrite({
            rowUpdates,
            rowDeletes: removedDates,
            metadata
        });
    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        throw error;
    }

    pushHistory();
    updateEditDifference();
    renderTable();
    checkMissingUsers();
}

export async function addInfoItem(date, service, value) {
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    if (!row[service]) {
        row[service] = [];
    }

    // 新增項目
    row[service].push(value);

    // 儲存
    const data = { ...row };
    delete data.date;
    await saveSchedule(date, data);

    // 記錄歷史和差異
    pushHistory();
    updateEditDifference();

    renderTable();
}

// 更新資訊項目
export async function updateInfoItem(date, service, index, newValue) {
    const row = scheduleData.find(r => r.date === date);
    if (!row || !row[service]) return;

    row[service][index] = newValue;

    // 儲存
    const data = { ...row };
    delete data.date;
    await saveSchedule(date, data);

    // 記錄歷史和差異
    pushHistory();
    updateEditDifference();

    renderTable();
}

// 刪除資訊項目
export async function removeInfoItem(date, service, index) {
    const row = scheduleData.find(r => r.date === date);
    if (!row || !row[service]) return;

    row[service].splice(index, 1);

    // 儲存
    const data = { ...row };
    delete data.date;
    await saveSchedule(date, data);

    // 記錄歷史和差異
    pushHistory();
    updateEditDifference();

    renderTable();
}


export async function addPersonToCell(date, service, person) {
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    const current = Array.isArray(row[service]) ? row[service] : [];
    if (current.includes(person)) {
        alert('此人員已在此服事項目中');
        return;
    }

    // 先在 local copy 上構造新陣列，不動 row[service] —— 等 saveSchedule 成功後才 commit。
    // 否則 saveSchedule 拋錯（離線、分頁鎖定）時，記憶體會殘留沒寫進去的變更，
    // pushHistory 也會記到幻影 edit。
    const newArr = [...current, person];
    const data = { ...row, [service]: newArr };
    delete data.date;

    try {
        await saveSchedule(date, data);
    } catch (err) {
        // 分頁鎖定 → modal 已顯示，靜默 swallow
        if (!err || err.message !== 'TAB_LOCKED') {
            alert('儲存失敗：' + (err && err.message ? err.message : err));
        }
        return;
    }

    // 寫入成功才 commit 到記憶體
    row[service] = newArr;
    allPersonNames.add(person);

    pushHistory();
    updateEditDifference();

    if (currentEditingCell) {
        renderCurrentPersonChips(currentEditingCell.date, currentEditingCell.service);
        renderPersonDropdown(currentEditingCell.date, currentEditingCell.service);
    }
    renderSingleCell(date, service);
    checkMissingUsers();
}

export async function removePerson(date, service, person) {
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    const current = Array.isArray(row[service]) ? row[service] : [];
    const index = current.indexOf(person);
    if (index < 0) return;

    // 同 addPersonToCell：先構造新陣列，等 saveSchedule 成功才 commit
    const newArr = current.slice(0, index).concat(current.slice(index + 1));
    const data = { ...row, [service]: newArr };
    delete data.date;

    try {
        await saveSchedule(date, data);
    } catch (err) {
        if (!err || err.message !== 'TAB_LOCKED') {
            alert('儲存失敗：' + (err && err.message ? err.message : err));
        }
        return;
    }

    row[service] = newArr;

    pushHistory();
    updateEditDifference();
    renderSingleCell(date, service);
    checkMissingUsers();
}

// ===========================
// 拖拉功能
// ===========================
// 拖拉狀態：module scope（不放在 setupDragAndDrop 的 closure 內，否則重複綁定會產生
// 多份不同步的 state）
let _draggedData = null;
let _dragSetupDone = false;

export function setupDragAndDrop() {
    // 用事件委派把 dragstart / dragover / drop 綁在 #scheduleTable 上，新 chip 元素
    // （由 renderSingleCell 動態建立的）也自動有效，不需要每次 render 都重綁。
    if (_dragSetupDone) return;
    const table = document.getElementById('scheduleTable');
    if (!table) return;

    table.addEventListener('dragstart', (e) => {
        const chip = e.target.closest('.person-chip[draggable="true"]');
        if (!chip || !table.contains(chip)) return;
        _draggedData = {
            date: chip.dataset.date,
            service: chip.dataset.service,
            person: chip.dataset.person
        };
        chip.classList.add('dragging');
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });

    table.addEventListener('dragend', (e) => {
        const chip = e.target.closest('.person-chip');
        if (chip) chip.classList.remove('dragging');
        // 清掉所有 drag-over 樣式（萬一 dragleave 沒觸發到）
        table.querySelectorAll('.service-cell.drag-over').forEach(c => c.classList.remove('drag-over'));
    });

    table.addEventListener('dragover', (e) => {
        const cell = e.target.closest('.service-cell[data-droppable="true"]');
        if (!cell) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        cell.classList.add('drag-over');
    });

    table.addEventListener('dragleave', (e) => {
        const cell = e.target.closest('.service-cell');
        if (cell) cell.classList.remove('drag-over');
    });

    table.addEventListener('drop', async (e) => {
        const cell = e.target.closest('.service-cell[data-droppable="true"]');
        if (!cell) return;
        e.preventDefault();
        cell.classList.remove('drag-over');

        if (!_draggedData) return;

        const targetDate = cell.dataset.date;
        const targetService = cell.dataset.service;

        // 同一格不做事
        if (_draggedData.date === targetDate && _draggedData.service === targetService) {
            _draggedData = null;
            return;
        }

        const data = _draggedData;
        _draggedData = null;
        updateStatus('移動人員中...');

        try {
            await movePersonBetweenCells(
                data.date,
                data.service,
                targetDate,
                targetService,
                data.person
            );
            updateStatus('人員已移動');
        } catch (error) {
            console.error('移動人員失敗:', error);
            alert('移動人員失敗');
            updateStatus('就緒');
        }
    });

    _dragSetupDone = true;
}

// ===========================
// 右鍵選單貼上功能
// ===========================
let pasteTargetCell = null; // 記錄右鍵點擊的格子位置
const INTERNAL_COPY_MARKER = '\u200B\u200B\u200B'; // 獨立一行標記，用於識別內部複製

// ===========================
// 多格選取功能
// ===========================
let multiSelectedCells = []; // 選取的格子 [{date, service, dateIndex, serviceIndex}, ...]
let isMultiSelecting = false; // 是否正在進行多格選取
let multiSelectAnchor = null; // 選取起點
let multiSelectTimer = null; // 長按計時器
let multiSelectStarted = false; // 長按是否已觸發

const MULTI_BORDER_CLASSES = ['multi-selected', 'multi-selecting', 'multi-select-top', 'multi-select-bottom', 'multi-select-left', 'multi-select-right'];

function clearMultiSelection() {
    multiSelectedCells = [];
    document.querySelectorAll('.service-cell.multi-selected, .service-cell.multi-selecting').forEach(c => {
        c.classList.remove(...MULTI_BORDER_CLASSES);
    });
}

// 根據選取範圍計算邊界並套用邊框類別（Excel 風格大外框）
function applySelectionBorders(cssClass) {
    // 先清除所有邊框類別
    document.querySelectorAll('.service-cell.multi-select-top, .service-cell.multi-select-bottom, .service-cell.multi-select-left, .service-cell.multi-select-right').forEach(c => {
        c.classList.remove('multi-select-top', 'multi-select-bottom', 'multi-select-left', 'multi-select-right');
    });

    const selectedCells = document.querySelectorAll(`.service-cell.${cssClass}`);
    if (selectedCells.length === 0) return;

    // 收集所有選取格子的 row/col 座標
    const positions = new Set();
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;

    selectedCells.forEach(c => {
        const dateIndex = scheduleData.findIndex(r => r.date === c.dataset.date);
        const serviceIndex = serviceItems.indexOf(c.dataset.service);
        if (dateIndex === -1 || serviceIndex === -1) return;
        positions.add(`${dateIndex},${serviceIndex}`);
        minRow = Math.min(minRow, dateIndex);
        maxRow = Math.max(maxRow, dateIndex);
        minCol = Math.min(minCol, serviceIndex);
        maxCol = Math.max(maxCol, serviceIndex);
    });

    // 對每個格子判斷是否在邊界
    selectedCells.forEach(c => {
        const dateIndex = scheduleData.findIndex(r => r.date === c.dataset.date);
        const serviceIndex = serviceItems.indexOf(c.dataset.service);
        if (dateIndex === -1 || serviceIndex === -1) return;

        if (dateIndex === minRow) c.classList.add('multi-select-top');
        if (dateIndex === maxRow) c.classList.add('multi-select-bottom');
        if (serviceIndex === minCol) c.classList.add('multi-select-left');
        if (serviceIndex === maxCol) c.classList.add('multi-select-right');
    });
}

function getCellKey(date, service) {
    return `${date}|${service}`;
}

function findCellElement(date, service) {
    return document.querySelector(`.service-cell[data-date="${date}"][data-service="${service}"]`);
}

// 計算矩形選取範圍內的所有格子
function getCellsInRange(anchor, current) {
    const minRow = Math.min(anchor.dateIndex, current.dateIndex);
    const maxRow = Math.max(anchor.dateIndex, current.dateIndex);
    const minCol = Math.min(anchor.serviceIndex, current.serviceIndex);
    const maxCol = Math.max(anchor.serviceIndex, current.serviceIndex);

    const cells = [];
    for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
            if (r < scheduleData.length && c < serviceItems.length) {
                cells.push({
                    date: scheduleData[r].date,
                    service: serviceItems[c],
                    dateIndex: r,
                    serviceIndex: c
                });
            }
        }
    }
    return cells;
}

// 新增一個變數來追蹤是否已經綁定過全域事件，避免 Memory Leak
let isGlobalMultiSelectBound = false;
// 設定多格選取事件（在 renderTableBody 中呼叫）
export function setupMultiCellSelection() {
    const cells = document.querySelectorAll('.service-cell[data-droppable="true"]');

    cells.forEach(cell => {
        // mousedown：開始長按計時
        cell.addEventListener('mousedown', (e) => {
            // 只處理左鍵且點擊在空白區域（placeholder 或 cell 本身）
            if (e.button !== 0) return;
            if (e.target.closest('.person-chip')) return;

            const date = cell.dataset.date;
            const service = cell.dataset.service;
            const dateIndex = scheduleData.findIndex(r => r.date === date);
            const serviceIndex = serviceItems.indexOf(service);
            if (dateIndex === -1 || serviceIndex === -1) return;

            multiSelectStarted = false;
            multiSelectTimer = setTimeout(() => {
                // 長按觸發：開始多格選取
                multiSelectStarted = true;
                isMultiSelecting = true;
                document.body.classList.add('multi-selecting-active');
                multiSelectAnchor = { date, service, dateIndex, serviceIndex };
                clearMultiSelection();

                const range = getCellsInRange(multiSelectAnchor, multiSelectAnchor);
                range.forEach(c => {
                    const el = findCellElement(c.date, c.service);
                    if (el) el.classList.add('multi-selecting');
                });
                applySelectionBorders('multi-selecting');

                // 防止文字選取
                e.preventDefault();
            }, 150); // 150ms 長按
        });

        // mouseover：拖拉延伸選取
        cell.addEventListener('mouseover', (e) => {
            if (!isMultiSelecting || !multiSelectAnchor) return;

            const date = cell.dataset.date;
            const service = cell.dataset.service;
            const dateIndex = scheduleData.findIndex(r => r.date === date);
            const serviceIndex = serviceItems.indexOf(service);
            if (dateIndex === -1 || serviceIndex === -1) return;

            // 清除舊的 selecting 樣式
            document.querySelectorAll('.service-cell.multi-selecting').forEach(c => {
                c.classList.remove(...MULTI_BORDER_CLASSES);
            });

            // 計算新的選取範圍
            const range = getCellsInRange(multiSelectAnchor, { dateIndex, serviceIndex });
            range.forEach(c => {
                const el = findCellElement(c.date, c.service);
                if (el) el.classList.add('multi-selecting');
            });
            applySelectionBorders('multi-selecting');
        });
    });

    // ==========================================
    // 確保 document 上的事件只綁定一次
    // ==========================================
    if (!isGlobalMultiSelectBound) {
        // mouseup：結束選取
        document.addEventListener('mouseup', (e) => {
            if (multiSelectTimer) {
                clearTimeout(multiSelectTimer);
                multiSelectTimer = null;
            }

            if (!isMultiSelecting) return;
            isMultiSelecting = false;
            document.body.classList.remove('multi-selecting-active');

            // 將 selecting 轉為 selected
            document.querySelectorAll('.service-cell.multi-selecting').forEach(c => {
                c.classList.remove('multi-selecting');
                c.classList.add('multi-selected');
            });
            applySelectionBorders('multi-selected');

            // 收集所有被選取的格子
            multiSelectedCells = [];
            document.querySelectorAll('.service-cell.multi-selected').forEach(c => {
                const date = c.dataset.date;
                const service = c.dataset.service;
                const dateIndex = scheduleData.findIndex(r => r.date === date);
                const serviceIndex = serviceItems.indexOf(service);
                if (dateIndex !== -1 && serviceIndex !== -1) {
                    multiSelectedCells.push({ date, service, dateIndex, serviceIndex });
                }
            });

            // 如果只選了一格，清除多格選取（保持原本的點擊行為）
            if (multiSelectedCells.length <= 1) {
                clearMultiSelection();
            }
        });

        // 點擊表格外時清除選取
        document.addEventListener('mousedown', (e) => {
            if (!e.target.closest('.service-cell') && !e.target.closest('.context-menu')) {
                clearMultiSelection();
            }
        });

        // 標記為已綁定
        isGlobalMultiSelectBound = true;
    }
}

// 取得多格選取的內容（以 tab-separated 格式）
function getMultiSelectedContent() {
    if (multiSelectedCells.length === 0) return '';

    // 找出選取範圍的行列邊界
    const rows = [...new Set(multiSelectedCells.map(c => c.dateIndex))].sort((a, b) => a - b);
    const cols = [...new Set(multiSelectedCells.map(c => c.serviceIndex))].sort((a, b) => a - b);

    const lines = [];
    rows.forEach(r => {
        const rowCells = [];
        cols.forEach(c => {
            const row = scheduleData[r];
            const service = serviceItems[c];
            const persons = row[service] || [];
            rowCells.push(persons.join('/'));
        });
        lines.push(rowCells.join('\t'));
    });
    return lines.join('\n');
}

// 複製多格選取的內容到剪貼簿
async function copyMultiSelectedCells() {
    const content = getMultiSelectedContent();
    if (!content) return;

    try {
        await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + content);
        updateStatus('已複製選取的格子');
    } catch (err) {
        console.error('複製失敗:', err);
        alert('無法寫入剪貼簿');
    }
}

// 剪下多格選取的內容
async function cutMultiSelectedCells() {
    const content = getMultiSelectedContent();
    if (!content) return;

    try {
        await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + content);
    } catch (err) {
        console.error('複製失敗:', err);
        alert('無法寫入剪貼簿');
        return;
    }

    // 清空被選取的格子
    updateStatus('剪下中...');

    // 構造 row updates（同 row 多格 → 合併到同一個 update），不在 await 前 mutate row
    const rowUpdatesMap = new Map();
    for (const cell of multiSelectedCells) {
        const row = scheduleData[cell.dateIndex];
        if (!row) continue;
        if (!rowUpdatesMap.has(row.date)) rowUpdatesMap.set(row.date, { ...row });
        rowUpdatesMap.get(row.date)[cell.service] = [];
    }
    const rowUpdates = [...rowUpdatesMap.entries()].map(([date, data]) => ({ date, data }));

    try {
        await _bulkWrite({ rowUpdates });

        // commit memory
        for (const cell of multiSelectedCells) {
            const row = scheduleData[cell.dateIndex];
            if (row) row[cell.service] = [];
        }

        pushHistory();
        updateEditDifference();
        clearMultiSelection();
        renderTable();
        updateStatus('已剪下選取的格子');
    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        console.error('剪下失敗:', error);
        alert('剪下失敗');
        updateStatus('就緒');
    }
}

// 刪除（清空）多格選取的內容
async function deleteMultiSelectedCells() {
    if (multiSelectedCells.length === 0) return;

    updateStatus('清空中...');

    const rowUpdatesMap = new Map();
    for (const cell of multiSelectedCells) {
        const row = scheduleData[cell.dateIndex];
        if (!row) continue;
        if (!rowUpdatesMap.has(row.date)) rowUpdatesMap.set(row.date, { ...row });
        rowUpdatesMap.get(row.date)[cell.service] = [];
    }
    const rowUpdates = [...rowUpdatesMap.entries()].map(([date, data]) => ({ date, data }));

    try {
        await _bulkWrite({ rowUpdates });

        for (const cell of multiSelectedCells) {
            const row = scheduleData[cell.dateIndex];
            if (row) row[cell.service] = [];
        }

        pushHistory();
        updateEditDifference();
        clearMultiSelection();
        renderTable();
        updateStatus('已清空選取的格子');
    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        console.error('清空失敗:', error);
        alert('清空失敗');
        updateStatus('就緒');
    }
}

function setupPasteHandler() {
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuPaste = document.getElementById('contextMenuPaste');
    const contextMenuCopy = document.getElementById('contextMenuCopy');
    const contextMenuCut = document.getElementById('contextMenuCut');

    // 點擊其他地方時關閉右鍵選單
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.classList.add('hidden');
        }
    });

    // 鍵盤快捷鍵
    document.addEventListener('keydown', (e) => {
        // ESC 關閉右鍵選單
        if (e.key === 'Escape') {
            contextMenu.classList.add('hidden');
            clearMultiSelection();
        }

        // Ctrl+C：複製多格選取
        if ((e.ctrlKey || e.metaKey) && e.key === 'c' && multiSelectedCells.length > 0) {
            e.preventDefault();
            copyMultiSelectedCells();
        }

        // Ctrl+X：剪下多格選取
        if ((e.ctrlKey || e.metaKey) && e.key === 'x' && multiSelectedCells.length > 0) {
            e.preventDefault();
            cutMultiSelectedCells();
        }

        // Delete / Backspace：清空多格選取
        if ((e.key === 'Delete' || e.key === 'Backspace') && multiSelectedCells.length > 0) {
            // 不在輸入框中時才觸發
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
            e.preventDefault();
            deleteMultiSelectedCells();
        }
    });

    // 複製按鈕
    contextMenuCopy.addEventListener('click', async () => {
        contextMenu.classList.add('hidden');
        if (contextMenuCopy.classList.contains('disabled')) return;

        if (multiSelectedCells.length > 0) {
            await copyMultiSelectedCells();
        } else if (pasteTargetCell) {
            // 單格複製
            const row = scheduleData[pasteTargetCell.dateIndex];
            const persons = row[pasteTargetCell.service] || [];
            try {
                await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + persons.join('/'));
                updateStatus('已複製格子內容');
            } catch (err) {
                console.error('複製失敗:', err);
            }
        }
    });

    // 剪下按鈕
    contextMenuCut.addEventListener('click', async () => {
        contextMenu.classList.add('hidden');
        if (contextMenuCut.classList.contains('disabled')) return;

        if (multiSelectedCells.length > 0) {
            await cutMultiSelectedCells();
        } else if (pasteTargetCell) {
            // 單格剪下
            const row = scheduleData[pasteTargetCell.dateIndex];
            const persons = row[pasteTargetCell.service] || [];
            try {
                await navigator.clipboard.writeText(INTERNAL_COPY_MARKER + persons.join('/'));
                row[pasteTargetCell.service] = [];
                const data = { ...row };
                delete data.date;
                await saveSchedule(row.date, data);
                pushHistory();
                updateEditDifference();
                renderTable();
                updateStatus('已剪下格子內容');
            } catch (err) {
                console.error('剪下失敗:', err);
            }
        }
    });

    // 貼上按鈕
    contextMenuPaste.addEventListener('click', async () => {
        contextMenu.classList.add('hidden');
        if (contextMenuPaste.classList.contains('disabled')) return;

        if (!pasteTargetCell) return;

        try {
            // 讀取剪貼簿
            const clipboardText = await navigator.clipboard.readText();
            if (!clipboardText) {
                alert('剪貼簿中沒有資料');
                return;
            }

            await pasteDataFromCell(pasteTargetCell.dateIndex, pasteTargetCell.serviceIndex, clipboardText);
        } catch (error) {
            console.error('讀取剪貼簿失敗:', error);
            alert('無法讀取剪貼簿，請確認已授予剪貼簿權限');
        }
    });
}

// 設定右鍵選單事件（在 renderTableBody 中呼叫）
export function setupContextMenu() {
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuCopy = document.getElementById('contextMenuCopy');
    const contextMenuCut = document.getElementById('contextMenuCut');
    const contextMenuPaste = document.getElementById('contextMenuPaste');

    document.querySelectorAll('.service-cell[data-date]').forEach(cell => {
        cell.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            // 取消長按計時器（避免右鍵觸發多格選取）
            if (multiSelectTimer) {
                clearTimeout(multiSelectTimer);
                multiSelectTimer = null;
            }

            const date = cell.dataset.date;
            const service = cell.dataset.service;

            // 找到日期和服事項目的索引
            const dateIndex = scheduleData.findIndex(r => r.date === date);
            const serviceIndex = serviceItems.indexOf(service);

            if (dateIndex === -1 || serviceIndex === -1) return;

            const isMultiSelected = multiSelectedCells.length > 0;
            const isCellInSelection = multiSelectedCells.some(
                c => c.date === date && c.service === service
            );

            if (isMultiSelected && isCellInSelection) {
                // 右鍵點在已選取的多格上：顯示複製、剪下，禁用貼上
                contextMenuCopy.classList.remove('disabled');
                contextMenuCut.classList.remove('disabled');
                contextMenuPaste.classList.add('disabled');
                pasteTargetCell = null;
            } else {
                // 右鍵點在單個格子上：清除多格選取，顯示全部選項
                clearMultiSelection();
                pasteTargetCell = { dateIndex, serviceIndex, date, service };
                contextMenuCopy.classList.remove('disabled');
                contextMenuCut.classList.remove('disabled');
                contextMenuPaste.classList.remove('disabled');
            }

            // 顯示右鍵選單
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.top = `${e.clientY}px`;
            contextMenu.classList.remove('hidden');
        });
    });
}

// 從指定格子開始貼上資料（入口函數）
async function pasteDataFromCell(startDateIndex, startServiceIndex, pastedData) {
    // 檢查是否為內部複製
    if (pastedData.startsWith(INTERNAL_COPY_MARKER)) {
        // 內部複製：移除標記後直接貼上
        const cleanData = pastedData.slice(INTERNAL_COPY_MARKER.length);
        await executePaste(startDateIndex, startServiceIndex, cleanData, '/');
    } else {
        // 外部貼上：開啟預覽 Modal
        openPastePreviewModal(startDateIndex, startServiceIndex, pastedData);
    }
}

// 暫存貼上預覽的資料
let pendingPasteData = null;

// 開啟貼上預覽 Modal
function openPastePreviewModal(startDateIndex, startServiceIndex, rawData) {
    pendingPasteData = { startDateIndex, startServiceIndex, rawData };

    // 偵測分隔符：依優先順序檢查貼上內容是否包含該字元
    const separatorPriority = ['/', '+', ',', '，', ' '];
    let detectedSeparator = ''; // 預設無分隔
    for (const sep of separatorPriority) {
        if (rawData.includes(sep)) {
            detectedSeparator = sep;
            break;
        }
    }

    const radios = document.querySelectorAll('input[name="pasteSeparator"]');
    radios.forEach(r => r.checked = (r.value === detectedSeparator));

    renderPastePreview(detectedSeparator);

    document.getElementById('pastePreviewModal').classList.remove('hidden');
}

// 根據分隔符渲染貼上預覽
function renderPastePreview(separator) {
    if (!pendingPasteData) return;

    const { startDateIndex, startServiceIndex, rawData } = pendingPasteData;

    let rows = rawData.split('\n');
    if (rows.length > 0 && rows[rows.length - 1] === '') {
        rows.pop();
    }

    const parsedRows = rows.map(row => row.split('\t'));
    const colCount = Math.max(...parsedRows.map(r => r.length));

    // 建立表頭（使用實際的服事項目名稱）
    let html = '<table class="paste-preview-table"><thead><tr><th>日期</th>';
    for (let j = 0; j < colCount && (startServiceIndex + j) < serviceItems.length; j++) {
        html += `<th>${serviceItems[startServiceIndex + j]}</th>`;
    }
    html += '</tr></thead><tbody>';

    // 建立每一列
    for (let i = 0; i < parsedRows.length && (startDateIndex + i) < scheduleData.length; i++) {
        const cells = parsedRows[i];
        const dateStr = scheduleData[startDateIndex + i].date;

        html += `<tr><td style="white-space: nowrap; font-weight: 600;">${dateStr}</td>`;

        for (let j = 0; j < colCount && (startServiceIndex + j) < serviceItems.length; j++) {
            const cellValue = (cells[j] || '').trim();
            html += '<td>';

            if (cellValue === '') {
                html += '<span style="color: var(--text-light); font-style: italic;">（空）</span>';
            } else {
                // 根據分隔符解析人名
                let names;
                if (separator === '') {
                    names = [cellValue];
                } else {
                    names = cellValue.split(separator).map(n => n.trim()).filter(n => n !== '');
                }
                names.forEach(name => {
                    html += `<span class="preview-chip">${name}</span>`;
                });
            }

            html += '</td>';
        }

        html += '</tr>';
    }

    html += '</tbody></table>';

    // 超出範圍提示
    const overflowRows = parsedRows.length - (scheduleData.length - startDateIndex);
    const overflowCols = colCount - (serviceItems.length - startServiceIndex);
    if (overflowRows > 0 || overflowCols > 0) {
        html += '<div style="margin-top: 8px; font-size: 12px; color: #f97316;">⚠️ ';
        if (overflowRows > 0) html += `有 ${overflowRows} 列超出表格範圍。`;
        if (overflowCols > 0) html += `有 ${overflowCols} 欄超出表格範圍。`;
        html += '超出部分將被忽略。</div>';
    }

    document.getElementById('pastePreviewContent').innerHTML = html;
}

// 設定貼上預覽 Modal 事件
function setupPastePreviewModal() {
    // 分隔符切換
    document.querySelectorAll('input[name="pasteSeparator"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            renderPastePreview(e.target.value);
        });
    });

    // 確認匯入按鈕
    document.getElementById('confirmPasteBtn').addEventListener('click', async () => {
        if (!pendingPasteData) return;

        const separator = document.querySelector('input[name="pasteSeparator"]:checked').value;
        const { startDateIndex, startServiceIndex, rawData } = pendingPasteData;

        closeModal('pastePreviewModal');
        pendingPasteData = null;

        await executePaste(startDateIndex, startServiceIndex, rawData, separator);
    });
}

// 執行實際的貼上操作
async function executePaste(startDateIndex, startServiceIndex, pastedData, separator) {
    let rows = pastedData.split('\n');
    if (rows.length > 0 && rows[rows.length - 1] === '') {
        rows.pop();
    }

    if (rows.length === 0) return;

    updateStatus('匯入資料中...');

    const parsedRows = rows.map(row => row.split('\t'));

    // 先在 row 副本上算出新內容（不動 in-memory），驗證通過再寫入
    const rowUpdates = [];
    const rowOverwrites = [];  // {rowIndex, serviceName, names}，寫入成功後 commit 到 in-memory
    const newPersons = new Set();

    for (let i = 0; i < parsedRows.length && (startDateIndex + i) < scheduleData.length; i++) {
        const cells = parsedRows[i];
        const sourceRow = scheduleData[startDateIndex + i];
        const rowCopy = { ...sourceRow };

        for (let j = 0; j < cells.length && (startServiceIndex + j) < serviceItems.length; j++) {
            const serviceName = serviceItems[startServiceIndex + j];
            const cellValue = cells[j].trim();

            let names;
            if (cellValue === '') {
                names = [];
            } else if (separator === '') {
                names = [cellValue];
            } else {
                names = cellValue.split(separator).map(n => n.trim()).filter(n => n !== '');
            }

            if (names.some(n => n.includes('|'))) {
                alert('匯入失敗：人員名稱不能包含 "|" 符號');
                updateStatus('就緒');
                return;
            }

            rowCopy[serviceName] = names;
            names.forEach(n => newPersons.add(n));
            rowOverwrites.push({ rowIndex: startDateIndex + i, serviceName, names });
        }

        rowUpdates.push({ date: sourceRow.date, data: rowCopy });
    }

    try {
        await _bulkWrite({ rowUpdates });

        // 寫入成功才 commit 到 in-memory
        rowOverwrites.forEach(({ rowIndex, serviceName, names }) => {
            const r = scheduleData[rowIndex];
            if (r) r[serviceName] = names;
        });
        newPersons.forEach(n => allPersonNames.add(n));

        rebuildPersonColorMap();
        pushHistory();
        updateEditDifference();
        renderTable();
        updateStatus('資料匯入完成');

    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        console.error('匯入資料失敗:', error);
        alert('匯入資料失敗');
        updateStatus('就緒');
    }
}

// ===========================
// 工具函數
// ===========================
function parseDateString(dateStr) {
    // 格式：yyyy.mm.dd
    const parts = dateStr.split('.');
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1; // 月份從 0 開始
    const day = parseInt(parts[2]);
    return new Date(year, month, day);
}

function formatDateString(date) {
    // 格式：yyyy.mm.dd（補零）
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}.${month}.${day}`;
}

// 根據人名取得對應顏色
export function getPersonColor(personName) {
    // 如果已經有快取的顏色，直接回傳
    if (personColorMap.has(personName)) {
        return personColorMap.get(personName);
    }

    // 依照目前已分配的數量來分配新顏色
    const colorIndex = personColorMap.size % PERSON_CHIP_COLORS.length;
    const color = PERSON_CHIP_COLORS[colorIndex];
    personColorMap.set(personName, color);

    return color;
}

// 重新建立顏色映射（在載入資料時呼叫）
function rebuildPersonColorMap() {
    personColorMap.clear();
    const sortedNames = Array.from(allPersonNames).sort();
    sortedNames.forEach((name, index) => {
        const colorIndex = index % PERSON_CHIP_COLORS.length;
        personColorMap.set(name, PERSON_CHIP_COLORS[colorIndex]);
    });
}

export function updateStatus(text) {
    document.getElementById('statusText').textContent = text;
}

export function getHistoryViewContext() {
    return {
        showingPast,
        pastData: pastData.map(row => ({ ...row }))
    };
}

// ===========================
// syncUIContext：每次可變狀態改變時，同步給 ui.js 的 setUIContext
// ===========================
function syncUIContext() {
    setUIContext({
        showingPast,
        pastData,
        currentEditingCell,
        allPersonNames,
        multiSelectStarted,
        multiSelectedCells,
        tempDisplayConfig
    });
}

// 將需要被外部 debug 模組或 ui.js 存取的函式掛到全域 window
window.togglePastData = togglePastData;

// ui.js 呼叫的資料操作橋接

// ui.js 的 openEditPersonModal 需要同步 currentEditingCell 到 app.js
export function setCurrentEditingCell(cell) {
    currentEditingCell = cell;
}

// 設定服事標題拖拉排序橋接（供 ui.js renderTableBody 呼叫）

function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('hidden');
}

// ===========================
// 匯出 Excel
// ===========================
function exportToExcel() {
    updateStatus('匯出 Excel 中...');
    try {
        const rows = [];
        // 表頭
        const header = ['日期', ...serviceItems];
        rows.push(header);

        // 資料 (根據是否顯示歷史資料來決定匯出範圍)
        let dataToExport = scheduleData;
        if (showingPast && pastData.length > 0) {
            dataToExport = [...pastData, ...scheduleData];
        }

        dataToExport.forEach(row => {
            const rowData = [row.date.replace(/\./g, '/')];
            serviceItems.forEach(service => {
                const val = row[service];
                if (Array.isArray(val)) {
                    rowData.push(val.join('/') || '');
                } else {
                    rowData.push(val || '');
                }
            });
            rows.push(rowData);
        });

        // 建立 worksheet
        const ws = window.XLSX.utils.aoa_to_sheet(rows);

        // 建立 workbook 
        const wb = window.XLSX.utils.book_new();
        window.XLSX.utils.book_append_sheet(wb, ws, "班表");

        // 匯出檔案
        const titleEl = document.getElementById('collectionTitle');
        const collectionName = titleEl ? titleEl.textContent.trim() : (window.COLLECTION_NAME || '教會服事班表');
        const dateStr = new Date().toISOString().split('T')[0];
        window.XLSX.writeFile(wb, `${collectionName}_${dateStr}.xlsx`);

        updateStatus('匯出完成');
        setTimeout(() => updateStatus('就緒'), 2000);
    } catch (error) {
        console.error('匯出 Excel 失敗:', error);
        alert('匯出 Excel 失敗');
        updateStatus('就緒');
    }
}

// ===========================
// 事件監聯器設定
// ===========================
function setupEventListeners() {
    // addRowBtn 和 deleteLastRowBtn 現在在 renderTableBody 中動態綁定

    const exportExcelBtn = document.getElementById('exportExcelBtn');
    if (exportExcelBtn) {
        exportExcelBtn.addEventListener('click', exportToExcel);
    }

    // data-close-modal 委派：處理所有帶 data-close-modal 屬性的按鈕
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-close-modal]');
        if (btn) closeModal(btn.dataset.closeModal);
    });

    // 按 ESC 關閉模態框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal('editDateModal');
            closeModal('editServiceModal');
            closeModal('editPersonModal');
            closeModal('pastePreviewModal');
        }
    });

    // 點擊模態框外部關閉
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                overlay.classList.add('hidden');
            }
        });
    });

    // --- 編輯服事項目 Modal 事件 ---
    const saveServiceBtn = document.getElementById('saveServiceBtn');
    if (saveServiceBtn) {
        saveServiceBtn.addEventListener('click', async () => {
            const newName = document.getElementById('serviceNameInput').value.trim();
            const isInfoColumn = document.getElementById('isInfoColumnCheckbox').checked;

            if (!newName) {
                alert('請輸入服事項目名稱');
                return;
            }

            if (newName.includes('|')) {
                alert('名稱不能包含 "|" 符號');
                return;
            }

            const nameChanged = newName !== window._currentEditingServiceName;

            if (nameChanged && serviceItems.includes(newName)) {
                alert('此服事項目名稱已存在');
                return;
            }

            updateStatus('更新服事項目中...');

            try {
                const oldName = window._currentEditingServiceName;

                // 更新 nonUserColumns
                const wasInfoColumn = nonUserColumns.includes(oldName);
                if (isInfoColumn && !wasInfoColumn) {
                    // 新增到 nonUserColumns
                    nonUserColumns.push(nameChanged ? newName : oldName);
                } else if (!isInfoColumn && wasInfoColumn) {
                    // 從 nonUserColumns 移除
                    const idx = nonUserColumns.indexOf(oldName);
                    if (idx > -1) nonUserColumns.splice(idx, 1);
                } else if (nameChanged && wasInfoColumn) {
                    // 名稱改變，更新 nonUserColumns 中的名稱
                    const idx = nonUserColumns.indexOf(oldName);
                    if (idx > -1) nonUserColumns[idx] = newName;
                }

                if (nameChanged) {
                    // 更新服事項目列表
                    const index = serviceItems.indexOf(oldName);
                    serviceItems[index] = newName;

                    // 同步更新 displayConfig 中的項目名稱
                    if (displayConfig && displayConfig.groups) {
                        // 更新所有群組中的項目
                        displayConfig.groups.forEach(group => {
                            if (group.items && Array.isArray(group.items)) {
                                const itemIndex = group.items.indexOf(oldName);
                                if (itemIndex > -1) {
                                    group.items[itemIndex] = newName;
                                }
                            }
                        });

                        // 更新隱藏列表中的項目
                        if (displayConfig.hidden && Array.isArray(displayConfig.hidden)) {
                            const hiddenIndex = displayConfig.hidden.indexOf(oldName);
                            if (hiddenIndex > -1) {
                                displayConfig.hidden[hiddenIndex] = newName;
                            }
                        }
                    }

                    // 更新所有資料
                    const updates = [];
                    scheduleData.forEach(row => {
                        row[newName] = row[oldName] || [];
                        delete row[oldName];

                        const data = { ...row };
                        delete data.date;
                        updates.push(saveSchedule(row.date, data));
                    });

                    // 儲存 metadata
                    updates.push(saveMetadata());

                    // 同步更新 users collection 的 serve_types
                    try {
                        const { collection, getDocs, query, where, doc, setDoc } = window.firestore;
                        const db = window.db;
                        const COLLECTION_NAME = window.COLLECTION_NAME;

                        // 只撈出有該崇拜 serve_types 的 users
                        const usersQuery = query(
                            collection(db, 'users'),
                            where(`serve_types.${COLLECTION_NAME}`, '!=', null)
                        );
                        const usersSnapshot = await getDocs(usersQuery);
                        usersSnapshot.forEach(docRef => {
                            const userData = docRef.data();
                            const serveTypes = userData.serve_types;
                            const arr = serveTypes[COLLECTION_NAME];
                            if (!Array.isArray(arr) || !arr.includes(oldName)) return;

                            // 有此服事名稱，替換為新名稱
                            updates.push(setDoc(doc(db, 'users', docRef.id), {
                                ...userData,
                                serve_types: {
                                    ...serveTypes,
                                    [COLLECTION_NAME]: arr.map(s => s === oldName ? newName : s)
                                }
                            }));
                        });
                    } catch (err) {
                        console.warn('更新 users serve_types 失敗:', err);
                    }

                    await Promise.all(updates);
                } else {
                    // 只有 checkbox 變更，只需儲存 metadata
                    await saveMetadata();

                    // 刷新管理使用者按鈕警示
                    checkMissingUsers();
                }

                renderTable();
                closeModal('editServiceModal');
                updateStatus('服事項目已更新');

            } catch (error) {
                console.error('更新服事項目失敗:', error);
                alert('更新服事項目失敗');
                updateStatus('就緒');
            }
        });
    }

    const deleteServiceBtn = document.getElementById('deleteServiceBtn');
    if (deleteServiceBtn) {
        deleteServiceBtn.addEventListener('click', () => {
            if (window._currentEditingServiceName) {
                deleteServiceItem(window._currentEditingServiceName);
            }
        });
    }

    // --- 編輯人員 Modal 事件 ---
    const addPersonChipBtn = document.getElementById('addPersonChipBtn');
    if (addPersonChipBtn) {
        addPersonChipBtn.addEventListener('click', () => {
            const name = document.getElementById('newPersonInput').value.trim();
            if (!name) {
                alert('請輸入姓名');
                return;
            }

            if (name.includes('|')) {
                alert('姓名不能包含 "|" 符號');
                return;
            }

            const cell = currentEditingCell;
            if (cell) addPersonToCell(cell.date, cell.service, name);

            document.getElementById('newPersonInput').value = '';
        });
    }

    const editPersonDoneBtn = document.getElementById('editPersonDoneBtn');
    if (editPersonDoneBtn) {
        editPersonDoneBtn.addEventListener('click', async () => {
            const cell = currentEditingCell;
            const isInfoColumn = cell ? nonUserColumns.includes(cell.service) : false;

            if (cell && isInfoColumn) {
                const newInfoInput = document.getElementById('newInfoInput');
                const pendingValue = newInfoInput ? newInfoInput.value.trim() : '';
                if (pendingValue) {
                    try {
                        await addInfoItem(cell.date, cell.service, pendingValue);
                    } catch (error) {
                        console.error('儲存資訊內容失敗:', error);
                        alert('儲存資訊內容失敗');
                        return;
                    }
                }
            }

            closeModal('editPersonModal');
        });
    }
}

// ===========================
// 編輯記錄功能
// ===========================
export function saveOriginalChartSnapshot() {
    // 合併式快照：只補充 originalChart 中尚未記錄的日期/服事
    // 這樣從 difference.html 回來後，不會覆蓋之前的基準值
    if (!originalChart || Object.keys(originalChart).length === 0) {
        originalChart = {};
    }

    scheduleData.forEach(row => {
        if (!originalChart[row.date]) {
            originalChart[row.date] = {};
        }
        serviceItems.forEach(service => {
            // 只在該格子尚未記錄時才保存基準值
            if (!(service in originalChart[row.date])) {
                originalChart[row.date][service] = row[service] ? [...row[service]] : [];
            }
        });
    });

    console.log('已保存原始班表快照');
}

// 計算並更新編輯差異（比對原始值和當前值，累積式更新）
// source 傳 null 表示不記錄來源（用於 undo/redo）
export function updateEditDifference(source = 'admin') {
    if (source !== null) currentSessionSources.add(source);

    const currentDates = new Set(scheduleData.map(r => r.date));

    scheduleData.forEach(row => {
        const date = row.date;
        const originalRow = originalChart[date];
        if (!originalRow) return;

        // 如果此日期先前被標記為刪除，現在已恢復，清除刪除標記
        if (editDifference[date]?._deleted) {
            delete editDifference[date]._deleted;
        }

        serviceItems.forEach(service => {
            const originalValue = originalRow[service] || [];
            const currentValue = row[service] || [];

            // 比對陣列是否不同
            const isDifferent = JSON.stringify(originalValue) !== JSON.stringify(currentValue);

            if (isDifferent) {
                if (!editDifference[date]) {
                    editDifference[date] = {};
                }
                editDifference[date][service] = {
                    old: [...originalValue],
                    new: [...currentValue]
                };
            } else {
                // 如果恢復到原始值，移除該差異條目
                if (editDifference[date] && editDifference[date][service]) {
                    delete editDifference[date][service];
                    // 如果該日期已無差異，移除整個日期
                    if (Object.keys(editDifference[date]).length === 0) {
                        delete editDifference[date];
                    }
                }
            }
        });
    });

    // 偵測被刪除的週：存在於 originalChart 但不在目前 scheduleData 中
    if (originalChart) {
        Object.keys(originalChart).forEach(date => {
            if (currentDates.has(date)) return; // 仍存在，跳過

            const originalRow = originalChart[date];
            // 檢查該週是否有任何非空白服事資料
            const rowHasData = serviceItems.some(s => {
                const val = originalRow[s];
                return Array.isArray(val) ? val.length > 0 : !!val;
            });

            if (rowHasData) {
                // 記錄為刪除差異：所有有值的服事欄位標記 new 為 []
                if (!editDifference[date]) editDifference[date] = {};
                serviceItems.forEach(service => {
                    const originalValue = originalRow[service] || [];
                    if (Array.isArray(originalValue) ? originalValue.length > 0 : !!originalValue) {
                        editDifference[date][service] = {
                            old: Array.isArray(originalValue) ? [...originalValue] : [originalValue],
                            new: []
                        };
                    }
                });
                editDifference[date]._deleted = true;
            } else {
                // 空白週被刪除，移除差異（如果先前有記錄的話）
                if (editDifference[date]) {
                    delete editDifference[date];
                }
            }
        });
    }

    // 檢查是否還有任何差異
    hasEdited = Object.keys(editDifference).length > 0;

    if (hasEdited) {
        // debounce 自動存檔，避免快速連續編輯產生競態
        if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
        _saveDebounceTimer = setTimeout(() => {
            _saveDebounceTimer = null;
            saveEditLog();
        }, 1500);
    } else {
        // 所有變更已撤銷回原始狀態：清除來源記錄，並刪除 Firestore 上已存的 log
        if (_saveDebounceTimer) { clearTimeout(_saveDebounceTimer); _saveDebounceTimer = null; }
        currentSessionSources.clear();
        deleteEditLog();
    }
}

// 儲存編輯記錄到 Firestore
export async function saveEditLog() {
    if (!hasEdited) return;

    const sessionTime = window.SESSION_START_TIME || formatCurrentTime();
    const lastEditedTime = formatCurrentTime();

    let finalSource = 'admin';
    if (currentSessionSources.has('admin') && (currentSessionSources.has('ai') || currentSessionSources.has('ai-assistant'))) {
        finalSource = 'admin+ai';
    } else if (currentSessionSources.has('ai') || currentSessionSources.has('ai-assistant')) {
        finalSource = 'ai';
    } else if (currentSessionSources.has('linebot')) {
        finalSource = 'linebot';
    }

    try {
        const { doc, setDoc } = window.firestore;
        const logRef = doc(window.db, '_edit_chart_log', sessionTime);

        await setDoc(logRef, {
            'serve-id': window.COLLECTION_NAME,
            'source': finalSource,
            'difference': editDifference,
            'last-edited-time': lastEditedTime
        });

        logWasWritten = true;
        console.log('編輯記錄已儲存');
    } catch (error) {
        console.error('儲存編輯記錄失敗:', error);
    }
}

// 刪除 Firestore 上的編輯記錄（用於撤銷回原始狀態時）
async function deleteEditLog() {
    if (!logWasWritten) return; // 本 session 從未寫入過，無需刪除
    logWasWritten = false;
    try {
        const { doc, deleteDoc } = window.firestore;
        await deleteDoc(doc(window.db, '_edit_chart_log', window.SESSION_START_TIME));
        console.log('編輯記錄已刪除（已撤銷至原始狀態）');
    } catch (error) {
        console.error('刪除編輯記錄失敗:', error);
    }
}

function formatCurrentTime() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const sec = String(now.getSeconds()).padStart(2, '0');
    return `${y}.${m}.${d}.${h}.${min}.${sec}`;
}

// 頁面離開前儲存；同時支援 pagehide（bfcache 場景 beforeunload 可能不觸發）
function setupBeforeUnloadHandler() {
    const cleanup = () => {
        if (hasEdited) {
            saveEditLog(); // 離開頁面前存檔
        }
        cancelUsersListener();
    };
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);
}

// ===========================
// 撤銷/重做功能
// ===========================
function initHistory() {
    // 保存初始狀態（包含完整快照）
    const initialState = JSON.stringify({
        scheduleData: scheduleData.map(row => ({ ...row })),
        serviceItems: [...serviceItems],
        nonUserColumns: [...nonUserColumns],
        displayConfig: displayConfig ? JSON.parse(JSON.stringify(displayConfig)) : null
    });
    historyStack = [initialState];
    historyIndex = 0;
    updateUndoRedoButtons();
}

// 推入新的歷史記錄
export function pushHistory() {
    // 移除當前位置之後的所有記錄
    historyStack = historyStack.slice(0, historyIndex + 1);

    // 推入新狀態（包含完整快照）
    const newState = JSON.stringify({
        scheduleData: scheduleData.map(row => {
            const rowCopy = { ...row };
            serviceItems.forEach(s => {
                if (Array.isArray(rowCopy[s])) {
                    rowCopy[s] = [...rowCopy[s]];
                }
            });
            return rowCopy;
        }),
        serviceItems: [...serviceItems],
        nonUserColumns: [...nonUserColumns],
        displayConfig: displayConfig ? JSON.parse(JSON.stringify(displayConfig)) : null
    });
    historyStack.push(newState);

    // 限制最大歷史記錄數
    if (historyStack.length > MAX_HISTORY_SIZE) {
        historyStack.shift();
    } else {
        historyIndex++;
    }

    updateUndoRedoButtons();
}

// 撤銷
async function undo() {
    if (isRestoring || historyIndex <= 0) return;

    historyIndex--;
    await restoreFromHistory();
    updateStatus('已撤銷');
}

// 重做
async function redo() {
    if (isRestoring || historyIndex >= historyStack.length - 1) return;

    historyIndex++;
    await restoreFromHistory();
    updateStatus('已重做');
}

// 從歷史記錄恢復
async function restoreFromHistory() {
    isRestoring = true;
    const state = JSON.parse(historyStack[historyIndex]);

    // diff：比對舊狀態，只寫入有差異的列
    const oldRowMap = new Map(scheduleData.map(r => [r.date, JSON.stringify(r)]));
    const oldMetadata = JSON.stringify({ serviceItems, nonUserColumns, displayConfig });

    const oldDates = new Set(scheduleData.map(r => r.date));
    const newDates = new Set(state.scheduleData.map(r => r.date));

    // 恢復資料
    scheduleData = state.scheduleData;
    serviceItems = state.serviceItems;
    nonUserColumns = state.nonUserColumns || [];
    displayConfig = state.displayConfig || null;

    // 同步到 Firestore（僅寫入有差異的部分）
    try {
        const rowDeletes = [];
        for (const date of oldDates) {
            if (!newDates.has(date)) rowDeletes.push(date);
        }

        const rowUpdates = scheduleData
            .filter(row => JSON.stringify(row) !== oldRowMap.get(row.date))
            .map(row => ({ date: row.date, data: { ...row } }));

        const newMetadata = JSON.stringify({ serviceItems, nonUserColumns, displayConfig });
        let metadata = null;
        if (newMetadata !== oldMetadata) {
            metadata = { serviceItems, nonUserColumns };
            if (displayConfig) metadata.displayConfig = displayConfig;
        }

        if (rowUpdates.length > 0 || rowDeletes.length > 0 || metadata) {
            await _bulkWrite({ rowUpdates, rowDeletes, metadata });
        }
    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') {
            isRestoring = false;
            return;
        }
        console.error('同步到 Firestore 失敗:', error);
    }

    isRestoring = false;

    // 更新差異記錄（undo/redo 不記錄來源）
    updateEditDifference(null);
    renderTable();
    updateUndoRedoButtons();

    // 刷新管理使用者按鈕警示
    checkMissingUsers();
}

// 更新撤銷/重做按鈕狀態
export function updateUndoRedoButtons() {
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');

    if (undoBtn) {
        undoBtn.disabled = historyIndex <= 0;
    }
    if (redoBtn) {
        redoBtn.disabled = historyIndex >= historyStack.length - 1;
    }
}

// 設定撤銷/重做事件
function setupUndoRedoHandler() {
    // 鍵盤事件
    document.addEventListener('keydown', (e) => {
        // 如果焦點在輸入框上，不處理
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        if (e.ctrlKey && e.key === 'z') {
            e.preventDefault();
            undo();
        } else if (e.ctrlKey && e.key === 'y') {
            e.preventDefault();
            redo();
        }
    });

    // 按鈕事件
    const undoBtn = document.getElementById('undoBtn');
    const redoBtn = document.getElementById('redoBtn');

    if (undoBtn) {
        undoBtn.addEventListener('click', undo);
    }
    if (redoBtn) {
        redoBtn.addEventListener('click', redo);
    }
}

// ===========================
// 分組顯示編輯功能
// ===========================

// 臨時編輯中的分組設定
let tempDisplayConfig = null;

// 初始化分組編輯功能
export function prepareDisplayConfigEditorState() {
    if (displayConfig) {
        tempDisplayConfig = JSON.parse(JSON.stringify(displayConfig));
    } else {
        tempDisplayConfig = {
            groups: [{
                id: 'ungrouped',
                name: '未分組',
                items: [...serviceItems],
                defaultVisible: true
            }],
            hidden: []
        };
    }
    syncUIContext();
}

// 儲存分組設定
export async function saveDisplayConfig() {
    try {
        updateStatus('儲存分組設定中...');

        // 移除空群組（保留 ungrouped）
        tempDisplayConfig.groups = tempDisplayConfig.groups.filter(g =>
            g.id === 'ungrouped' || g.items.length > 0
        );

        // 儲存到全域變數
        displayConfig = JSON.parse(JSON.stringify(tempDisplayConfig));

        // saveMetadata() 內部已經把 serviceItems / nonUserColumns / displayConfig 一起寫進
        // _metadata doc，受分頁鎖保護；不需要額外 setDoc。
        await saveMetadata();

        closeModal('displayConfigModal');
        updateStatus('分組設定已儲存');
    } catch (error) {
        console.error('儲存分組設定失敗:', error);
        alert('儲存失敗：' + error.message);
        updateStatus('就緒');
    }
}

// 載入分組設定
async function loadDisplayConfig() {
    try {
        const { doc, getDoc } = window.firestore;
        const metadataRef = doc(window.db, window.COLLECTION_NAME, '_metadata');
        const metadataDoc = await getDoc(metadataRef);

        if (metadataDoc.exists() && metadataDoc.data().displayConfig) {
            displayConfig = metadataDoc.data().displayConfig;
        } else {
            // 預設設定：所有項目放入 ungrouped
            displayConfig = {
                groups: [{
                    id: 'ungrouped',
                    name: '未分組',
                    items: [...serviceItems],
                    defaultVisible: true
                }],
                hidden: []
            };
        }
    } catch (error) {
        console.error('載入分組設定失敗:', error);
    }
}

// ===========================
// 使用者管理 - 檢查未註冊使用者或服事項目不完整
// ===========================
function evaluateMissingUsers(registeredUsers) {
    const COLLECTION_NAME = window.COLLECTION_NAME;
    const userServiceItems = serviceItems.filter(item => !nonUserColumns.includes(item));

    const personServeItems = {};
    scheduleData.forEach(row => {
        userServiceItems.forEach(item => {
            if (row[item] && Array.isArray(row[item])) {
                row[item].forEach(name => {
                    if (!personServeItems[name]) {
                        personServeItems[name] = new Set();
                    }
                    personServeItems[name].add(item);
                });
            }
        });
    });

    for (const name of Object.keys(personServeItems)) {
        const userData = registeredUsers[name];
        if (!userData) return true;

        const registeredServes = userData.serve_types?.[COLLECTION_NAME] || [];
        const scheduleServes = personServeItems[name];
        for (const serve of scheduleServes) {
            if (!registeredServes.includes(serve)) return true;
        }
    }
    return false;
}

async function ensureUsersCache() {
    if (usersCacheReady) return;
    if (usersCacheInitPromise) return usersCacheInitPromise;

    usersCacheInitPromise = new Promise(async (resolve, reject) => {
        try {
            const { collection, getDocs, onSnapshot } = window.firestore;
            const db = window.db;

            if (typeof onSnapshot === 'function') {
                let firstResolved = false;
                usersUnsubscribe = onSnapshot(
                    collection(db, 'users'),
                    (snapshot) => {
                        const nextCache = {};
                        snapshot.forEach(docRef => {
                            nextCache[docRef.id] = docRef.data();
                        });
                        registeredUsersCache = nextCache;
                        usersCacheReady = true;
                        updateUserAlertBadge(evaluateMissingUsers(registeredUsersCache));

                        if (!firstResolved) {
                            firstResolved = true;
                            resolve();
                        }
                    },
                    (error) => {
                        console.error('監聽 users 失敗:', error);
                        if (!firstResolved) {
                            firstResolved = true;
                            reject(error);
                        }
                    }
                );
            } else {
                const usersSnapshot = await getDocs(collection(db, 'users'));
                const nextCache = {};
                usersSnapshot.forEach(docRef => {
                    nextCache[docRef.id] = docRef.data();
                });
                registeredUsersCache = nextCache;
                usersCacheReady = true;
                resolve();
            }
        } catch (error) {
            reject(error);
        }
    });

    return usersCacheInitPromise;
}

export async function checkMissingUsers() {
    try {
        await ensureUsersCache();
        updateUserAlertBadge(evaluateMissingUsers(registeredUsersCache));
    } catch (error) {
        console.error('檢查未註冊使用者失敗:', error);
    }
}

export async function movePersonBetweenCells(fromDate, fromService, toDate, toService, person) {
    const fromRow = scheduleData.find(r => r.date === fromDate);
    const toRow = scheduleData.find(r => r.date === toDate);
    if (!fromRow || !toRow) return;

    if (!Array.isArray(fromRow[fromService]) || !Array.isArray(toRow[toService])) return;
    if (fromDate === toDate && fromService === toService) return;

    const fromIndex = fromRow[fromService].indexOf(person);
    if (fromIndex === -1) return;
    if (toRow[toService].includes(person)) {
        alert('目標格已經有這位同工');
        return;
    }

    // 不在 await 前 mutate 記憶體；先在副本上算好，等 _bulkWrite 成功才 commit
    const newFromArr = fromRow[fromService].slice(0, fromIndex).concat(fromRow[fromService].slice(fromIndex + 1));
    const sameRow = fromRow.date === toRow.date;
    let newToArr;
    if (sameRow) {
        // 同一列：先從同一個 newFromArr 衍生（移除 person 後再 push）
        newToArr = [...newFromArr, person];
    } else {
        newToArr = [...toRow[toService], person];
    }

    const rowUpdates = [];
    if (sameRow) {
        // 同列只寫一次，包含兩個欄位的變更
        const merged = { ...fromRow, [fromService]: newFromArr, [toService]: newToArr };
        rowUpdates.push({ date: fromRow.date, data: merged });
    } else {
        rowUpdates.push({ date: fromRow.date, data: { ...fromRow, [fromService]: newFromArr } });
        rowUpdates.push({ date: toRow.date, data: { ...toRow, [toService]: newToArr } });
    }

    try {
        await _bulkWrite({ rowUpdates });
    } catch (error) {
        if (error && error.message === 'TAB_LOCKED') return;
        console.error('移動人員失敗:', error);
        alert('儲存失敗：' + (error && error.message ? error.message : error));
        return;
    }

    // 寫入成功才 commit 到記憶體
    fromRow[fromService] = newFromArr;
    toRow[toService] = newToArr;

    pushHistory();
    updateEditDifference();
    renderSingleCell(fromDate, fromService);
    renderSingleCell(toDate, toService);
    checkMissingUsers();
}

// 更新使用者警示符號
function updateUserAlertBadge(show) {
    const badge = document.getElementById('userAlertBadge');
    if (badge) {
        if (show) {
            badge.classList.remove('hidden');
        } else {
            badge.classList.add('hidden');
        }
    }
}

// 初始化 Agent
initAgentFeature();

export { showModalAlert };

