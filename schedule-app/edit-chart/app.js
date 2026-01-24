// ===========================
// 全域變數
// ===========================
let scheduleData = []; // 所有班表資料（今天以後）
let pastData = []; // 過去的資料（今天之前，最多26筆）
let pastDataLoaded = false; // 歷史資料是否已載入
let showingPast = false; // 是否顯示過去資料
let serviceItems = []; // 服事項目列表
let nonUserColumns = []; // 資訊欄位列表（不包含人名的欄位）
let allPersonNames = new Set(); // 所有出現過的人名
let currentEditingCell = null; // 目前編輯的儲存格
let currentEditingServiceName = null; // 目前編輯的服事項目名稱
let displayConfig = null; // 服事項目分組顯示設定

// 最大顯示/新增限制
const MAX_FUTURE_ROWS = 52; // 未來資料最多52筆
const MAX_PAST_ROWS = 26; // 歷史資料最多26筆

// ===========================
// 編輯記錄系統
// ===========================
let originalChart = null; // 進入頁面時的班表快照
let hasEdited = false; // 是否有編輯過
let editDifference = {}; // 記錄編輯差異

// ===========================
// 撤銷/重做系統 (最多 20 步)
// ===========================
const MAX_HISTORY_SIZE = 20;
let historyStack = []; // 歷史記錄堆疊
let historyIndex = -1; // 目前在歷史中的位置

// ===========================
// 日期工具函數
// ===========================
// 取得當前週日日期（UTC+8 時區，週日為基準）
function getCurrentSunday() {
    const now = new Date();
    const utc8Offset = 8 * 60 * 60 * 1000;
    const utc8Now = new Date(now.getTime() + utc8Offset + now.getTimezoneOffset() * 60000);

    const dayOfWeek = utc8Now.getDay();
    const sunday = new Date(utc8Now);
    sunday.setDate(utc8Now.getDate() - dayOfWeek + 7);
    sunday.setHours(0, 0, 0, 0);
    return sunday;
}

// ===========================
// 30 種固定顏色供人名積木使用
// ===========================
const PERSON_CHIP_COLORS = [
    '#E74C3C', // 紅色
    '#3498DB', // 藍色
    '#2ECC71', // 綠色
    '#9B59B6', // 紫色
    '#F39C12', // 橙色
    '#1ABC9C', // 青色
    '#E91E63', // 粉紅色
    '#00BCD4', // 青藍色
    '#8BC34A', // 淺綠色
    '#FF5722', // 深橙色
    '#673AB7', // 深紫色
    '#009688', // 藍綠色
    '#CDDC39', // 黃綠色
    '#795548', // 棕色
    '#607D8B', // 藍灰色
    '#FF9800', // 橘色
    '#4CAF50', // 正綠色
    '#2196F3', // 正藍色
    '#F44336', // 亮紅色
    '#9C27B0', // 亮紫色
    '#00ACC1', // 深青色
    '#7CB342', // 草綠色
    '#C0392B', // 磚紅色
    '#D35400', // 南瓜色
    '#16A085', // 深青綠色
    '#8E44AD', // 紫羅蘭色
    '#27AE60', // 翡翠綠
    '#2980B9', // 海藍色
    '#F1C40F', // 金黃色
    '#34495E'  // 深灰藍色
];

// 人名到顏色的映射快取
let personColorMap = new Map();

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

    // 設定撤銷/重做事件
    setupUndoRedoHandler();

    // 設定頁面離開前儲存編輯記錄
    setupBeforeUnloadHandler();

    // 初始化分組編輯功能
    initDisplayConfigEditor();
    await loadDisplayConfig();

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

    try {
        const { collection, getDocs, query, orderBy, doc, getDoc, where, limit } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;

        // 載入服事項目
        const metadataDoc = await getDoc(doc(db, COLLECTION_NAME, '_metadata'));
        if (metadataDoc.exists()) {
            serviceItems = metadataDoc.data().serviceItems || [];
            nonUserColumns = metadataDoc.data().nonUserColumns || [];
        } else {
            // 如果沒有 metadata，使用預設值
            serviceItems = ['主領', '副主領', '助唱', '司琴', '鼓手', '貝斯', '吉他', '彩排', '提醒人', '音控', '字幕', '司會', '奉獻', '招待', '先知性'];
            nonUserColumns = [];
            await saveMetadata();
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
                scheduleData.push({ date: docRef.id, ...data });

                // 收集所有人名
                serviceItems.forEach(item => {
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
        } else {
            console.log('已載入班表資料');
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
        const q = query(
            collection(db, COLLECTION_NAME),
            where('__name__', '<', currentSundayStr),
            orderBy('__name__')
        );
        const snapshot = await getDocs(q);

        let allPastData = [];
        snapshot.forEach((docRef) => {
            if (docRef.id !== '_metadata') {
                const data = docRef.data();
                allPastData.push({ date: docRef.id, ...data });
            }
        });

        // 在客戶端排序（新到舊）並取最後 N 筆
        allPastData.sort((a, b) => b.date.localeCompare(a.date));
        pastData = allPastData.slice(0, MAX_PAST_ROWS);
        // 反轉回舊到新的順序
        pastData.reverse();

        updateStatus('就緒');
    } catch (error) {
        console.error('載入歷史資料失敗:', error);
        pastData = [];
        updateStatus('就緒');
    }
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

// 儲存 metadata
async function saveMetadata() {
    const { doc, setDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    const metadata = {
        serviceItems: serviceItems,
        nonUserColumns: nonUserColumns
    };

    // 如果有 displayConfig，也儲存
    if (displayConfig) {
        metadata.displayConfig = displayConfig;
    }

    await setDoc(doc(db, COLLECTION_NAME, '_metadata'), metadata);
}

// 儲存班表資料
async function saveSchedule(dateStr, data) {
    const { doc, setDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    // 移除 date 欄位（因為已經是 document ID）
    const saveData = { ...data };
    delete saveData.date;

    await setDoc(doc(db, COLLECTION_NAME, dateStr), saveData);
}

// 刪除班表資料
async function deleteSchedule(dateStr) {
    const { doc, deleteDoc } = window.firestore;
    const db = window.db;
    const COLLECTION_NAME = window.COLLECTION_NAME;

    await deleteDoc(doc(db, COLLECTION_NAME, dateStr));
}

// ===========================
// 表格渲染
// ===========================
function renderTable() {
    renderTableHead();
    renderTableBody();
}

function renderTableHead() {
    const thead = document.getElementById('tableHead');

    let html = '<tr>';
    html += '<th class="date-header">日期</th>';

    serviceItems.forEach((item, index) => {
        html += `<th class="service-header" 
                    draggable="true" 
                    data-service="${item}" 
                    data-index="${index}">
      <span class="service-header-text service-header-editable" data-service="${item}">${item}</span>
    </th>`;
    });

    html += '</tr>';
    thead.innerHTML = html;

    // 設定服事項目名稱點擊編輯事件（類似日期）
    document.querySelectorAll('.service-header-editable').forEach(span => {
        span.addEventListener('click', (e) => {
            e.stopPropagation();
            const serviceName = e.target.dataset.service;
            openEditServiceModal(serviceName);
        });
    });

    // 設定服事標題拖拉排序事件
    setupServiceHeaderDragAndDrop();
}

// 服事標題拖拉排序
function setupServiceHeaderDragAndDrop() {
    const headers = document.querySelectorAll('.service-header[draggable="true"]');

    let draggedHeader = null;
    let draggedIndex = null;

    headers.forEach(header => {
        header.addEventListener('dragstart', (e) => {
            // 如果是從編輯文字或刪除按鈕開始拖拉，不處理
            if (e.target.closest('.service-header-editable') || e.target.closest('.delete-service-btn')) {
                e.preventDefault();
                return;
            }
            draggedHeader = header;
            draggedIndex = parseInt(header.dataset.index);
            header.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', header.dataset.service);
        });

        header.addEventListener('dragend', (e) => {
            header.classList.remove('dragging');
            headers.forEach(h => h.classList.remove('drag-over'));
        });

        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (header !== draggedHeader) {
                header.classList.add('drag-over');
            }
        });

        header.addEventListener('dragleave', (e) => {
            header.classList.remove('drag-over');
        });

        header.addEventListener('drop', async (e) => {
            e.preventDefault();
            header.classList.remove('drag-over');

            if (!draggedHeader || draggedHeader === header) return;

            const targetIndex = parseInt(header.dataset.index);

            if (draggedIndex === targetIndex) return;

            updateStatus('移動服事項目中...');

            try {
                // 重新排序 serviceItems
                const draggedService = serviceItems[draggedIndex];
                serviceItems.splice(draggedIndex, 1);
                serviceItems.splice(targetIndex, 0, draggedService);

                // 儲存新順序到 metadata
                await saveMetadata();

                // 重新渲染表格
                renderTable();
                updateStatus('服事項目順序已更新');

            } catch (error) {
                console.error('移動服事項目失敗:', error);
                alert('移動服事項目失敗');
                updateStatus('就緒');
            }

            draggedHeader = null;
            draggedIndex = null;
        });
    });
}

function renderTableBody() {
    const tbody = document.getElementById('tableBody');

    // 決定要顯示的資料
    let dataToRender = [];
    if (showingPast && pastData.length > 0) {
        dataToRender = [...pastData, ...scheduleData];
    } else {
        dataToRender = scheduleData;
    }

    let html = '';
    dataToRender.forEach((row, rowIndex) => {
        // 過去資料添加淡化樣式
        const isPast = showingPast && rowIndex < pastData.length;
        const rowClass = isPast ? 'style="opacity: 0.6; background: #f8fafc;"' : '';

        html += `<tr ${rowClass}>`;

        // 日期欄位（過去資料不可編輯）
        if (isPast) {
            html += `<td>
              <div class="date-cell" style="cursor: default;">
                ${row.date}
              </div>
            </td>`;
        } else {
            // 未來資料也暫時禁用編輯日期功能
            html += `<td>
              <div class="date-cell" style="cursor: default;">
                ${row.date}
              </div>
            </td>`;
            /* TODO: 編輯日期功能暫時註解
            html += `<td>
              <div class="date-cell date-cell-editable" data-index="${rowIndex}">
                ${row.date}
              </div>
            </td>`;
            */
        }

        // 服事項目欄位
        serviceItems.forEach(item => {
            const persons = row[item] || [];
            const isEmpty = persons.length === 0;

            // 過去資料不可編輯
            if (isPast) {
                html += `<td class="service-cell ${isEmpty ? 'empty' : ''}" style="cursor: default;">`;
                if (!isEmpty) {
                    html += '<div class="person-chips">';
                    persons.forEach((person, personIndex) => {
                        const chipColor = getPersonColor(person);
                        html += `<div class="person-chip" style="background: ${chipColor}; cursor: default;">
                             ${person}
                           </div>`;
                    });
                    html += '</div>';
                }
                html += '</td>';
            } else {
                html += `<td class="service-cell ${isEmpty ? 'empty' : ''}" 
                       data-date="${row.date}" 
                       data-service="${item}"
                       data-droppable="true">`;

                if (isEmpty) {
                    html += '<div class="add-person-placeholder">＋</div>';
                } else {
                    html += '<div class="person-chips">';
                    persons.forEach((person, personIndex) => {
                        const chipColor = getPersonColor(person);
                        html += `<div class="person-chip" 
                            draggable="true"
                            data-date="${row.date}"
                            data-service="${item}"
                            data-person="${person}"
                            data-index="${personIndex}"
                            style="background: ${chipColor};">
                         ${person}
                       </div>`;
                    });
                    html += '</div>';
                }

                html += '</td>';
            }
        });

        html += '</tr>';
    });

    // 在表格最後添加操作按鈕行
    const colSpan = serviceItems.length + 1; // 日期欄 + 服事項目欄
    html += `<tr class="table-action-row">
        <td colspan="${colSpan}">
            <div class="table-action-buttons">
                <button class="btn btn-primary" id="addRowBtn">
                    ➕ 新增一週
                </button>
                <button class="btn btn-danger" id="deleteLastRowBtn">
                    ➖ 刪除最後一週
                </button>
            </div>
        </td>
    </tr>`;

    tbody.innerHTML = html;

    // 設定表格內操作按鈕事件
    const addRowBtn = document.getElementById('addRowBtn');
    const deleteLastRowBtn = document.getElementById('deleteLastRowBtn');
    if (addRowBtn) {
        addRowBtn.addEventListener('click', addNewRow);
    }
    if (deleteLastRowBtn) {
        deleteLastRowBtn.addEventListener('click', deleteLastRow);
    }

    // 設定服事欄位點擊事件（只對未來資料）
    document.querySelectorAll('.service-cell[data-date]').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (!e.target.closest('.person-chip')) {
                const date = cell.dataset.date;
                const service = cell.dataset.service;
                openEditPersonModal(date, service);
            }
        });
    });

    // 設定拖拉事件
    setupDragAndDrop();

    // 設定右鍵選單事件
    setupContextMenu();
}

// ===========================
// 日期管理
// ===========================
async function addNewRow() {
    if (scheduleData.length === 0) {
        alert('請先建立初始資料');
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

        renderTable();
        updateStatus('已新增一週');

    } catch (error) {
        console.error('新增一週失敗:', error);
        alert('新增一週失敗');
        updateStatus('就緒');
    }
}

async function deleteLastRow() {
    if (scheduleData.length === 0) {
        alert('沒有資料可刪除');
        return;
    }

    const confirm = window.confirm('確定要刪除最後一週的資料嗎？');
    if (!confirm) return;

    updateStatus('刪除中...');

    try {
        const lastRow = scheduleData.pop();
        await deleteSchedule(lastRow.date);

        renderTable();
        updateStatus('已刪除最後一週');

    } catch (error) {
        console.error('刪除失敗:', error);
        alert('刪除失敗');
        scheduleData.push(lastRow); // 還原
        updateStatus('就緒');
    }
}

// ===========================
// 服事項目管理
// ===========================
async function addServiceItem() {
    const name = prompt('請輸入新的服事項目名稱：');
    if (!name || name.trim() === '') return;

    const trimmedName = name.trim();

    if (serviceItems.includes(trimmedName)) {
        alert('此服事項目已存在');
        return;
    }

    updateStatus('新增服事項目中...');

    try {
        serviceItems.push(trimmedName);

        // 將新服事項目加入 displayConfig 的「未分組」群組
        if (displayConfig && displayConfig.groups) {
            const ungrouped = displayConfig.groups.find(g => g.id === 'ungrouped');
            if (ungrouped) {
                ungrouped.items.push(trimmedName);
            }
        }

        // 為所有現有資料新增此欄位
        const updates = [];
        scheduleData.forEach(row => {
            row[trimmedName] = [];
            const data = { ...row };
            delete data.date;
            updates.push(saveSchedule(row.date, data));
        });

        // 儲存 metadata（包含 displayConfig）
        updates.push(saveMetadata());

        await Promise.all(updates);

        renderTable();
        updateStatus('服事項目已新增');

    } catch (error) {
        console.error('新增服事項目失敗:', error);
        alert('新增服事項目失敗');
        serviceItems.pop(); // 還原
        updateStatus('就緒');
    }
}

// 新增資訊欄位（預設為 nonUserColumn）
async function addInfoColumn() {
    const name = prompt('請輸入新的資訊欄位名稱：');
    if (!name || name.trim() === '') return;

    const trimmedName = name.trim();

    if (serviceItems.includes(trimmedName)) {
        alert('此欄位名稱已存在');
        return;
    }

    updateStatus('新增資訊欄位中...');

    try {
        serviceItems.push(trimmedName);
        nonUserColumns.push(trimmedName); // 預設加入 nonUserColumns

        // 將新欄位加入 displayConfig 的「未分組」群組
        if (displayConfig && displayConfig.groups) {
            const ungrouped = displayConfig.groups.find(g => g.id === 'ungrouped');
            if (ungrouped) {
                ungrouped.items.push(trimmedName);
            }
        }

        // 為所有現有資料新增此欄位
        const updates = [];
        scheduleData.forEach(row => {
            row[trimmedName] = [];
            const data = { ...row };
            delete data.date;
            updates.push(saveSchedule(row.date, data));
        });

        // 儲存 metadata
        updates.push(saveMetadata());

        await Promise.all(updates);

        renderTable();
        updateStatus('資訊欄位已新增');

    } catch (error) {
        console.error('新增資訊欄位失敗:', error);
        alert('新增資訊欄位失敗');
        serviceItems.pop();
        nonUserColumns.pop();
        updateStatus('就緒');
    }
}

function openEditServiceModal(serviceName) {
    currentEditingServiceName = serviceName;
    document.getElementById('serviceNameInput').value = serviceName;
    // 設定 checkbox 狀態
    const isInfoColumn = nonUserColumns.includes(serviceName);
    document.getElementById('isInfoColumnCheckbox').checked = isInfoColumn;
    document.getElementById('editServiceModal').classList.remove('hidden');
}

document.getElementById('saveServiceBtn').addEventListener('click', async () => {
    const newName = document.getElementById('serviceNameInput').value.trim();
    const isInfoColumn = document.getElementById('isInfoColumnCheckbox').checked;

    if (!newName) {
        alert('請輸入服事項目名稱');
        return;
    }

    const nameChanged = newName !== currentEditingServiceName;

    if (nameChanged && serviceItems.includes(newName)) {
        alert('此服事項目名稱已存在');
        return;
    }

    updateStatus('更新服事項目中...');

    try {
        const oldName = currentEditingServiceName;

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

// 刪除服事項目按鈕事件
document.getElementById('deleteServiceBtn').addEventListener('click', () => {
    if (currentEditingServiceName) {
        deleteServiceItem(currentEditingServiceName);
    }
});

async function deleteServiceItem(serviceName) {
    const confirm = window.confirm(`確定要刪除服事項目「${serviceName}」嗎？這將刪除所有相關資料。`);
    if (!confirm) return;

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
                    if (itemIndex > -1) {
                        group.items.splice(itemIndex, 1);
                    }
                });
            }
            // 從隱藏列表中移除
            if (displayConfig.hidden) {
                const hiddenIndex = displayConfig.hidden.indexOf(serviceName);
                if (hiddenIndex > -1) {
                    displayConfig.hidden.splice(hiddenIndex, 1);
                }
            }
        }

        // 更新所有資料
        const updates = [];
        scheduleData.forEach(row => {
            delete row[serviceName];

            const data = { ...row };
            delete data.date;
            updates.push(saveSchedule(row.date, data));
        });

        // 儲存 metadata（包含 displayConfig）
        updates.push(saveMetadata());

        await Promise.all(updates);

        renderTable();
        closeModal('editServiceModal');
        updateStatus('服事項目已刪除');

    } catch (error) {
        console.error('刪除服事項目失敗:', error);
        alert('刪除服事項目失敗');
        updateStatus('就緒');
    }
}

// ===========================
// 人員管理
// ===========================
function openEditPersonModal(date, service) {
    currentEditingCell = { date, service };

    // 顯示目前編輯的日期與服事項目
    document.getElementById('editPersonModalSubtitle').textContent = `${date} - ${service}`;

    // 顯示所有人名下拉選單
    renderPersonDropdown();

    // 顯示目前人員
    renderCurrentPersonChips();

    document.getElementById('editPersonModal').classList.remove('hidden');
    document.getElementById('newPersonInput').value = '';
}

function renderPersonDropdown() {
    const dropdown = document.getElementById('personDropdown');

    // 取得目前服事的人員列表
    const { date, service } = currentEditingCell;
    const row = scheduleData.find(r => r.date === date);
    const currentPersons = row[service] || [];

    // 收集在其他週有出現在該服事項目過的人
    const serviceVeterans = new Set();
    scheduleData.forEach(r => {
        if (r.date !== date && r[service]) {
            r[service].forEach(name => serviceVeterans.add(name));
        }
    });

    // 過濾條件：
    // 1. 不在目前服事的人
    const availableNames = Array.from(allPersonNames)
        .filter(name => !currentPersons.includes(name));

    // 排序：在該服事項目出現過的人排前面，其餘按字母排序
    availableNames.sort((a, b) => {
        const aIsVeteran = serviceVeterans.has(a);
        const bIsVeteran = serviceVeterans.has(b);

        if (aIsVeteran && !bIsVeteran) return -1;
        if (!aIsVeteran && bIsVeteran) return 1;
        return a.localeCompare(b, 'zh-TW');
    });

    if (availableNames.length === 0) {
        if (allPersonNames.size === 0) {
            dropdown.innerHTML = '<div class="text-muted text-center" style="padding: 8px;">尚無人員記錄，請輸入新人員</div>';
        } else {
            dropdown.innerHTML = '<div class="text-muted text-center" style="padding: 8px;">無可用人員，請輸入新人員</div>';
        }
        return;
    }

    let html = '';
    availableNames.forEach(name => {
        const chipColor = getPersonColor(name);
        const isVeteran = serviceVeterans.has(name);
        html += `<div class="person-chip-selectable${isVeteran ? ' veteran' : ''}" data-person="${name}" style="background: ${chipColor};">${name}</div>`;
    });

    dropdown.innerHTML = html;

    // 設定點擊事件
    dropdown.querySelectorAll('.person-chip-selectable').forEach(item => {
        item.addEventListener('click', (e) => {
            const person = e.target.dataset.person;
            if (person) {
                addPersonToCell(currentEditingCell.date, currentEditingCell.service, person);
            }
        });
    });
}

function renderCurrentPersonChips() {
    const { date, service } = currentEditingCell;
    const row = scheduleData.find(r => r.date === date);
    const persons = row[service] || [];

    const container = document.getElementById('currentPersonChips');

    if (persons.length === 0) {
        container.innerHTML = '<div class="text-muted">尚未指派人員</div>';
        return;
    }

    let html = '';
    persons.forEach(person => {
        const chipColor = getPersonColor(person);
        html += `<div class="person-chip" style="background: ${chipColor};">
               ${person}
               <button class="remove-btn" data-person="${person}">×</button>
             </div>`;
    });

    container.innerHTML = html;

    // 設定刪除事件
    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const person = e.target.dataset.person;
            removePerson(date, service, person);
            renderCurrentPersonChips();
        });
    });
}

document.getElementById('addPersonChipBtn').addEventListener('click', () => {
    const name = document.getElementById('newPersonInput').value.trim();
    if (!name) {
        alert('請輸入姓名');
        return;
    }

    const { date, service } = currentEditingCell;
    addPersonToCell(date, service, name);

    document.getElementById('newPersonInput').value = '';
});

async function addPersonToCell(date, service, person) {
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    if (!row[service]) {
        row[service] = [];
    }

    // 檢查是否已存在
    if (row[service].includes(person)) {
        alert('此人員已在此服事項目中');
        return;
    }

    // 新增人員
    row[service].push(person);
    allPersonNames.add(person);

    // 儲存
    const data = { ...row };
    delete data.date;
    await saveSchedule(date, data);

    // 記錄歷史和差異
    pushHistory();
    updateEditDifference();

    // 更新顯示（只在編輯模態框開啟時才更新）
    if (currentEditingCell) {
        renderCurrentPersonChips();
        renderPersonDropdown();
    }
    renderTable();

    // 刷新管理使用者按鈕警示
    checkMissingUsers();
}

async function removePerson(date, service, person) {
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    const index = row[service].indexOf(person);
    if (index > -1) {
        row[service].splice(index, 1);

        // 儲存
        const data = { ...row };
        delete data.date;
        await saveSchedule(date, data);

        // 記錄歷史和差異
        pushHistory();
        updateEditDifference();

        // 更新顯示
        renderTable();

        // 刷新管理使用者按鈕警示
        checkMissingUsers();
    }
}

// ===========================
// 拖拉功能
// ===========================
function setupDragAndDrop() {
    const chips = document.querySelectorAll('.person-chip[draggable="true"]');
    const cells = document.querySelectorAll('.service-cell[data-droppable="true"]');

    let draggedChip = null;
    let draggedData = null;

    // 設定拖拉開始
    chips.forEach(chip => {
        chip.addEventListener('dragstart', (e) => {
            draggedChip = chip;
            draggedData = {
                date: chip.dataset.date,
                service: chip.dataset.service,
                person: chip.dataset.person
            };
            chip.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        chip.addEventListener('dragend', (e) => {
            chip.classList.remove('dragging');

            // 移除所有 drag-over 樣式
            cells.forEach(cell => cell.classList.remove('drag-over'));
        });
    });

    // 設定放置目標
    cells.forEach(cell => {
        cell.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            cell.classList.add('drag-over');
        });

        cell.addEventListener('dragleave', (e) => {
            cell.classList.remove('drag-over');
        });

        cell.addEventListener('drop', async (e) => {
            e.preventDefault();
            cell.classList.remove('drag-over');

            if (!draggedData) return;

            const targetDate = cell.dataset.date;
            const targetService = cell.dataset.service;

            // 如果是同一個格子，不做任何事
            if (draggedData.date === targetDate && draggedData.service === targetService) {
                return;
            }

            updateStatus('移動人員中...');

            try {
                // 從來源移除
                await removePerson(draggedData.date, draggedData.service, draggedData.person);

                // 新增到目標
                await addPersonToCell(targetDate, targetService, draggedData.person);

                updateStatus('人員已移動');

            } catch (error) {
                console.error('移動人員失敗:', error);
                alert('移動人員失敗');
                updateStatus('就緒');
            }

            draggedChip = null;
            draggedData = null;
        });
    });
}

// ===========================
// 右鍵選單貼上功能
// ===========================
let pasteTargetCell = null; // 記錄右鍵點擊的格子位置

function setupPasteHandler() {
    const contextMenu = document.getElementById('contextMenu');
    const contextMenuPaste = document.getElementById('contextMenuPaste');

    // 點擊其他地方時關閉右鍵選單
    document.addEventListener('click', (e) => {
        if (!contextMenu.contains(e.target)) {
            contextMenu.classList.add('hidden');
        }
    });

    // 按 ESC 關閉右鍵選單
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            contextMenu.classList.add('hidden');
        }
    });

    // 右鍵選單的貼上按鈕
    contextMenuPaste.addEventListener('click', async () => {
        contextMenu.classList.add('hidden');

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
function setupContextMenu() {
    const contextMenu = document.getElementById('contextMenu');

    document.querySelectorAll('.service-cell').forEach(cell => {
        cell.addEventListener('contextmenu', (e) => {
            e.preventDefault();

            const date = cell.dataset.date;
            const service = cell.dataset.service;

            // 找到日期和服事項目的索引
            const dateIndex = scheduleData.findIndex(r => r.date === date);
            const serviceIndex = serviceItems.indexOf(service);

            if (dateIndex === -1 || serviceIndex === -1) return;

            pasteTargetCell = { dateIndex, serviceIndex, date, service };

            // 顯示右鍵選單
            contextMenu.style.left = `${e.clientX}px`;
            contextMenu.style.top = `${e.clientY}px`;
            contextMenu.classList.remove('hidden');
        });
    });
}

// 從指定格子開始貼上資料
async function pasteDataFromCell(startDateIndex, startServiceIndex, pastedData) {
    // 分割成列，保留中間的空白行，只移除最後的空行
    let rows = pastedData.split('\n');

    // 移除結尾的空行
    while (rows.length > 0 && rows[rows.length - 1].trim() === '') {
        rows.pop();
    }

    if (rows.length === 0) return;

    const confirm = window.confirm(`偵測到貼上 ${rows.length} 列資料，是否要從此格開始匯入？`);
    if (!confirm) return;

    updateStatus('匯入資料中...');

    try {
        // 解析每一列（保留空白行）
        const parsedRows = rows.map(row => {
            const cells = row.split('\t');
            return cells;
        });

        // 從指定位置開始處理
        for (let i = 0; i < parsedRows.length && (startDateIndex + i) < scheduleData.length; i++) {
            const cells = parsedRows[i];
            const rowData = scheduleData[startDateIndex + i];

            // 從指定的服事項目欄位開始
            for (let j = 0; j < cells.length && (startServiceIndex + j) < serviceItems.length; j++) {
                const serviceName = serviceItems[startServiceIndex + j];
                const cellValue = cells[j].trim();

                if (cellValue === '') {
                    rowData[serviceName] = [];
                } else {
                    // 解析人名：支援 "/" 分隔
                    const names = cellValue.split('/').map(n => n.trim()).filter(n => n !== '');
                    rowData[serviceName] = names;

                    // 加入到所有人名集合
                    names.forEach(name => allPersonNames.add(name));
                }
            }

            // 儲存
            const data = { ...rowData };
            delete data.date;
            await saveSchedule(rowData.date, data);
        }

        // 重建顏色映射
        rebuildPersonColorMap();

        // 記錄歷史和差異
        pushHistory();
        updateEditDifference();

        renderTable();
        updateStatus('資料匯入完成');

    } catch (error) {
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
function getPersonColor(personName) {
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

function updateStatus(text) {
    document.getElementById('statusText').textContent = text;
}

// 將需要被外部 debug 模組存取的函式掛到全域 window
window.updateStatus = updateStatus;
window.setupEventListeners = typeof setupEventListeners !== 'undefined' ? setupEventListeners : undefined;
window.setupPasteHandler = typeof setupPasteHandler !== 'undefined' ? setupPasteHandler : undefined;
window.saveMetadata = typeof saveMetadata !== 'undefined' ? saveMetadata : undefined;
window.createInitialData = typeof createInitialData !== 'undefined' ? createInitialData : undefined;
window.parseDateString = typeof parseDateString !== 'undefined' ? parseDateString : undefined;
window.renderTable = typeof renderTable !== 'undefined' ? renderTable : undefined;
window.togglePastData = togglePastData;

window.closeModal = function (modalId) {
    document.getElementById(modalId).classList.add('hidden');
};

// ===========================
// 事件監聯器設定
// ===========================
function setupEventListeners() {
    // addRowBtn 和 deleteLastRowBtn 現在在 renderTableBody 中動態綁定
    document.getElementById('addServiceBtn').addEventListener('click', addServiceItem);

    // 按 ESC 關閉模態框
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeModal('editDateModal');
            closeModal('editServiceModal');
            closeModal('editPersonModal');
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
}

// ===========================
// 編輯記錄功能
// ===========================
function saveOriginalChartSnapshot() {
    // 深拷貝當前班表資料
    originalChart = {
        _metadata: { serviceItems: [...serviceItems] }
    };

    scheduleData.forEach(row => {
        const rowData = {};
        serviceItems.forEach(service => {
            rowData[service] = row[service] ? [...row[service]] : [];
        });
        originalChart[row.date] = rowData;
    });

    console.log('已保存原始班表快照');
}

// 計算並更新編輯差異（比對原始值和當前值）
function updateEditDifference() {
    editDifference = {};
    let hasDiff = false;

    scheduleData.forEach(row => {
        const date = row.date;
        const originalRow = originalChart[date];
        if (!originalRow) return;

        serviceItems.forEach(service => {
            const originalValue = originalRow[service] || [];
            const currentValue = row[service] || [];

            // 比對陣列是否不同
            const isDifferent = JSON.stringify(originalValue) !== JSON.stringify(currentValue);

            if (isDifferent) {
                if (!editDifference[date]) {
                    editDifference[date] = {};
                }
                editDifference[date][service] = [...currentValue];
                hasDiff = true;
            }
        });
    });

    hasEdited = hasDiff;

    // 儲存編輯記錄
    if (hasEdited) {
        saveEditLog();
    }
}

// 儲存編輯記錄到 Firestore
async function saveEditLog() {
    if (!hasEdited || Object.keys(editDifference).length === 0) {
        return;
    }

    const sessionTime = window.SESSION_START_TIME || formatCurrentTime();
    const lastEditedTime = formatCurrentTime();

    try {
        const { doc, setDoc } = window.firestore;
        const logRef = doc(window.db, '_edit_chart_log', sessionTime);

        await setDoc(logRef, {
            'serve-id': window.COLLECTION_NAME,
            'origin-chart': originalChart,
            'difference': editDifference,
            'last-edited-time': lastEditedTime
        });

        console.log('編輯記錄已儲存');
    } catch (error) {
        console.error('儲存編輯記錄失敗:', error);
    }
}

function formatCurrentTime() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    const h = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    return `${y}.${m}.${d}.${h}.${min}`;
}

// 頁面離開前儲存
function setupBeforeUnloadHandler() {
    window.addEventListener('beforeunload', () => {
        if (hasEdited) {
            saveEditLog();
        }
    });
}

// ===========================
// 撤銷/重做功能
// ===========================
function initHistory() {
    // 保存初始狀態
    const initialState = JSON.stringify({
        scheduleData: scheduleData.map(row => ({ ...row })),
        serviceItems: [...serviceItems]
    });
    historyStack = [initialState];
    historyIndex = 0;
    updateUndoRedoButtons();
}

// 推入新的歷史記錄
function pushHistory() {
    // 移除當前位置之後的所有記錄
    historyStack = historyStack.slice(0, historyIndex + 1);

    // 推入新狀態
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
        serviceItems: [...serviceItems]
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
function undo() {
    if (historyIndex <= 0) return;

    historyIndex--;
    restoreFromHistory();
    updateStatus('已撤銷');
}

// 重做
function redo() {
    if (historyIndex >= historyStack.length - 1) return;

    historyIndex++;
    restoreFromHistory();
    updateStatus('已重做');
}

// 從歷史記錄恢復
async function restoreFromHistory() {
    const state = JSON.parse(historyStack[historyIndex]);

    // 恢復資料
    scheduleData = state.scheduleData;
    serviceItems = state.serviceItems;

    // 同步到 Firestore
    try {
        const updates = [];
        scheduleData.forEach(row => {
            const data = { ...row };
            delete data.date;
            updates.push(saveSchedule(row.date, data));
        });
        updates.push(saveMetadata());
        await Promise.all(updates);
    } catch (error) {
        console.error('同步到 Firestore 失敗:', error);
    }

    // 更新差異記錄
    updateEditDifference();

    // 重新渲染
    renderTable();
    updateUndoRedoButtons();

    // 刷新管理使用者按鈕警示
    checkMissingUsers();
}

// 更新撤銷/重做按鈕狀態
function updateUndoRedoButtons() {
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
function initDisplayConfigEditor() {
    const editBtn = document.getElementById('editDisplayConfigBtn');
    if (editBtn) {
        editBtn.addEventListener('click', openDisplayConfigModal);
    }

    const addGroupBtn = document.getElementById('addGroupBtn');
    if (addGroupBtn) {
        addGroupBtn.addEventListener('click', addNewGroup);
    }

    const saveBtn = document.getElementById('saveDisplayConfigBtn');
    if (saveBtn) {
        saveBtn.addEventListener('click', saveDisplayConfig);
    }

    // 新增服事按鈕
    const addServiceBtn = document.getElementById('addServiceBtn');
    if (addServiceBtn) {
        addServiceBtn.addEventListener('click', addServiceItem);
    }

    // 新增資訊欄位按鈕
    const addInfoColumnBtn = document.getElementById('addInfoColumnBtn');
    if (addInfoColumnBtn) {
        addInfoColumnBtn.addEventListener('click', addInfoColumn);
    }

    // 編輯記錄按鈕
    const viewLogsBtn = document.getElementById('viewLogsBtn');
    if (viewLogsBtn) {
        viewLogsBtn.addEventListener('click', () => {
            const collectionName = window.COLLECTION_NAME;
            window.location.href = `../chart-difference/difference.html?collection=${collectionName}`;
        });
    }

    // 管理使用者按鈕
    const manageUsersBtn = document.getElementById('manageUsersBtn');
    if (manageUsersBtn) {
        manageUsersBtn.addEventListener('click', () => {
            const collectionName = window.COLLECTION_NAME;
            window.location.href = `edit-user.html?collection=${collectionName}`;
        });
    }

    // 檢查是否有未註冊的使用者
    checkMissingUsers();
}

// 開啟編輯顯示欄位 Modal
function openDisplayConfigModal() {
    // 複製現有設定或建立預設設定
    if (displayConfig) {
        tempDisplayConfig = JSON.parse(JSON.stringify(displayConfig));
    } else {
        // 預設：所有項目放入 ungrouped 組別
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

    renderDisplayConfigModal();
    document.getElementById('displayConfigModal').classList.remove('hidden');
}

// 渲染分組編輯 Modal 內容
function renderDisplayConfigModal() {
    const groupsContainer = document.getElementById('displayConfigGroups');
    const hiddenZoneItems = document.getElementById('hiddenZoneItems');

    // 渲染群組
    let groupsHtml = '';
    tempDisplayConfig.groups.forEach((group, index) => {
        const isUngrouped = group.id === 'ungrouped';
        groupsHtml += `
            <div class="group-container" data-group-id="${group.id}">
                <div class="group-header">
                    <input type="text" class="group-name-input" value="${group.name}" 
                           onchange="updateGroupName('${group.id}', this.value)"
                           ${isUngrouped ? 'disabled readonly style="background: #e5e7eb; cursor: not-allowed;"' : ''}>
                    <label class="group-visibility-toggle" ${isUngrouped ? 'style="opacity: 0.5; pointer-events: none;"' : ''}>
                        <input type="checkbox" ${group.defaultVisible ? 'checked' : ''} 
                               onchange="toggleGroupVisibility('${group.id}', this.checked)"
                               ${isUngrouped ? 'disabled' : ''}>
                        預設顯示
                    </label>
                    ${!isUngrouped ? `<button class="group-delete-btn" onclick="deleteGroup('${group.id}')">🗑️</button>` : ''}
                </div>
                <div class="group-items" data-group-id="${group.id}"
                     ondragover="handleDragOver(event)" 
                     ondragleave="handleDragLeave(event)"
                     ondrop="handleDrop(event, '${group.id}')">
                    ${group.items.map(item => `
                        <div class="draggable-service" draggable="true" 
                             data-service="${item}"
                             ondragstart="handleDragStart(event)"
                             ondragend="handleDragEnd(event)">
                            ${item}
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    });
    groupsContainer.innerHTML = groupsHtml;

    // 渲染隱藏區域
    let hiddenHtml = '';
    tempDisplayConfig.hidden.forEach(item => {
        hiddenHtml += `
            <div class="draggable-service" draggable="true" 
                 data-service="${item}"
                 ondragstart="handleDragStart(event)"
                 ondragend="handleDragEnd(event)">
                ${item}
            </div>
        `;
    });
    hiddenZoneItems.innerHTML = hiddenHtml || '<div style="color: #94a3b8; font-size: 13px;">拖入不想顯示的服事項目</div>';

    // 設定隱藏區域的拖放事件
    hiddenZoneItems.ondragover = window.handleDragOver;
    hiddenZoneItems.ondragleave = window.handleDragLeave;
    hiddenZoneItems.ondrop = (e) => window.handleDrop(e, 'hidden');
}

// 拖拉開始
window.handleDragStart = function (event) {
    event.target.classList.add('dragging');
    event.dataTransfer.setData('text/plain', event.target.dataset.service);
    event.dataTransfer.effectAllowed = 'move';
    // 記錄拖拉中的元素
    window.draggingElement = event.target;
}

// 拖拉結束
window.handleDragEnd = function (event) {
    event.target.classList.remove('dragging');
    window.draggingElement = null;
    // 移除所有插入指示器
    document.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());
}

// 拖拉經過容器
window.handleDragOver = function (event) {
    event.preventDefault();
    const container = event.currentTarget;
    container.classList.add('drag-over');

    // 移除此容器中的舊指示器
    container.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());

    // 計算插入位置並顯示指示器
    const draggables = Array.from(container.querySelectorAll('.draggable-service:not(.dragging)'));
    const dropY = event.clientY;
    const dropX = event.clientX;

    let insertBefore = null;
    let minDistance = Infinity;

    for (const draggable of draggables) {
        const rect = draggable.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.abs(dropX - centerX) + Math.abs(dropY - centerY) * 0.5;

        // 找到最近且在滑鼠右側的元素
        if (dropX < centerX && distance < minDistance) {
            minDistance = distance;
            insertBefore = draggable;
        }
    }

    // 創建插入指示器
    const indicator = document.createElement('div');
    indicator.className = 'drag-insert-indicator';

    if (insertBefore) {
        container.insertBefore(indicator, insertBefore);
    } else {
        container.appendChild(indicator);
    }

    // 記錄插入位置
    container.insertBeforeElement = insertBefore;
}

// 拖拉離開
window.handleDragLeave = function (event) {
    event.currentTarget.classList.remove('drag-over');
    event.currentTarget.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());
}

// 放下處理
window.handleDrop = function (event, targetGroupId) {
    event.preventDefault();
    const container = event.currentTarget;
    container.classList.remove('drag-over');

    // 移除指示器
    container.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());

    const serviceName = event.dataTransfer.getData('text/plain');
    if (!serviceName) return;

    // 取得插入位置
    const insertBeforeElement = container.insertBeforeElement;
    const insertBeforeService = insertBeforeElement ? insertBeforeElement.dataset.service : null;

    // 從所有群組和隱藏區域移除此項目
    tempDisplayConfig.groups.forEach(group => {
        const index = group.items.indexOf(serviceName);
        if (index > -1) {
            group.items.splice(index, 1);
        }
    });
    const hiddenIndex = tempDisplayConfig.hidden.indexOf(serviceName);
    if (hiddenIndex > -1) {
        tempDisplayConfig.hidden.splice(hiddenIndex, 1);
    }

    // 新增到目標群組的指定位置
    if (targetGroupId === 'hidden') {
        if (insertBeforeService) {
            const idx = tempDisplayConfig.hidden.indexOf(insertBeforeService);
            if (idx > -1) {
                tempDisplayConfig.hidden.splice(idx, 0, serviceName);
            } else {
                tempDisplayConfig.hidden.push(serviceName);
            }
        } else {
            tempDisplayConfig.hidden.push(serviceName);
        }
    } else {
        const targetGroup = tempDisplayConfig.groups.find(g => g.id === targetGroupId);
        if (targetGroup) {
            if (insertBeforeService) {
                const idx = targetGroup.items.indexOf(insertBeforeService);
                if (idx > -1) {
                    targetGroup.items.splice(idx, 0, serviceName);
                } else {
                    targetGroup.items.push(serviceName);
                }
            } else {
                targetGroup.items.push(serviceName);
            }
        }
    }

    // 清除記錄
    container.insertBeforeElement = null;

    // 重新渲染
    renderDisplayConfigModal();
}

// 新增群組
function addNewGroup() {
    const newGroupId = 'group-' + Date.now();
    const groupCount = tempDisplayConfig.groups.filter(g => g.id !== 'ungrouped').length + 1;

    tempDisplayConfig.groups.push({
        id: newGroupId,
        name: `群組 ${groupCount}`,
        items: [],
        defaultVisible: true
    });

    renderDisplayConfigModal();
}

// 更新群組名稱
window.updateGroupName = function (groupId, newName) {
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (group) {
        group.name = newName;
    }
}

// 切換群組預設顯示
window.toggleGroupVisibility = function (groupId, visible) {
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (group) {
        group.defaultVisible = visible;
    }
}

// 刪除群組
window.deleteGroup = function (groupId) {
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (!group || group.id === 'ungrouped') return;

    // 將此群組的項目移回 ungrouped
    const ungrouped = tempDisplayConfig.groups.find(g => g.id === 'ungrouped');
    if (ungrouped) {
        ungrouped.items.push(...group.items);
    }

    // 移除群組
    const index = tempDisplayConfig.groups.findIndex(g => g.id === groupId);
    if (index > -1) {
        tempDisplayConfig.groups.splice(index, 1);
    }

    renderDisplayConfigModal();
}

// 儲存分組設定
async function saveDisplayConfig() {
    try {
        updateStatus('儲存分組設定中...');

        // 移除空群組（保留 ungrouped）
        tempDisplayConfig.groups = tempDisplayConfig.groups.filter(g =>
            g.id === 'ungrouped' || g.items.length > 0
        );

        // 儲存到全域變數
        displayConfig = JSON.parse(JSON.stringify(tempDisplayConfig));

        // 儲存到 Firestore
        const metadata = {
            serviceItems: serviceItems,
            displayConfig: displayConfig
        };
        await saveMetadata();

        // 另外更新 displayConfig
        const { doc, setDoc, getDoc } = window.firestore;
        const metadataRef = doc(window.db, window.COLLECTION_NAME, '_metadata');
        const metadataDoc = await getDoc(metadataRef);

        if (metadataDoc.exists()) {
            const existingData = metadataDoc.data();
            await setDoc(metadataRef, {
                ...existingData,
                displayConfig: displayConfig
            });
        }

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
async function checkMissingUsers() {
    try {
        const { collection, getDocs, doc, getDoc } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;

        // 取得所有 users collection 中的使用者資料
        const usersSnapshot = await getDocs(collection(db, 'users'));
        const registeredUsers = {};
        usersSnapshot.forEach(docRef => {
            registeredUsers[docRef.id] = docRef.data();
        });

        // 取得非資訊欄位的服事項目（排除 nonUserColumns）
        const userServiceItems = serviceItems.filter(item => !nonUserColumns.includes(item));

        // 收集班表中每個人的服事項目（只統計非資訊欄位）
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

        // 檢查是否有問題
        let hasIssues = false;
        for (const name of Object.keys(personServeItems)) {
            const userData = registeredUsers[name];

            // 1. 使用者未註冊
            if (!userData) {
                hasIssues = true;
                break;
            }

            // 2. 使用者已註冊但服事項目不完整
            const registeredServes = userData.serve_types?.[COLLECTION_NAME] || [];
            const scheduleServes = personServeItems[name];
            for (const serve of scheduleServes) {
                if (!registeredServes.includes(serve)) {
                    hasIssues = true;
                    break;
                }
            }
            if (hasIssues) break;
        }

        // 更新警示符號
        updateUserAlertBadge(hasIssues);

    } catch (error) {
        console.error('檢查未註冊使用者失敗:', error);
    }
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
