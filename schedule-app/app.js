// ===========================
// 全域變數
// ===========================
let scheduleData = []; // 所有班表資料
let serviceItems = []; // 服事項目列表
let allPersonNames = new Set(); // 所有出現過的人名
let currentEditingCell = null; // 目前編輯的儲存格
let currentEditingDateIndex = null; // 目前編輯的日期索引
let currentEditingServiceName = null; // 目前編輯的服事項目名稱

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

    // 設定事件監聽器
    setupEventListeners();

    // 設定貼上事件
    setupPasteHandler();

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
        const { collection, getDocs, query, orderBy, doc, getDoc } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;

        // 載入服事項目
        const metadataDoc = await getDoc(doc(db, COLLECTION_NAME, '_metadata'));
        if (metadataDoc.exists()) {
            serviceItems = metadataDoc.data().serviceItems || [];
        } else {
            // 如果沒有 metadata，使用預設值
            serviceItems = ['主領', '音控', '字幕', '招待'];
            await saveMetadata();
        }

        // 載入所有班表資料
        const q = query(collection(db, COLLECTION_NAME));
        const querySnapshot = await getDocs(q);

        scheduleData = [];
        querySnapshot.forEach((doc) => {
            if (doc.id !== '_metadata') {
                const data = doc.data();
                scheduleData.push({
                    date: doc.id,
                    ...data
                });

                // 收集所有人名
                serviceItems.forEach(item => {
                    if (data[item] && Array.isArray(data[item])) {
                        data[item].forEach(name => allPersonNames.add(name));
                    }
                });
            }
        });

        // 按日期排序
        scheduleData.sort((a, b) => {
            const dateA = parseDateString(a.date);
            const dateB = parseDateString(b.date);
            return dateA - dateB;
        });

        // 如果沒有資料，建立初始資料
        if (scheduleData.length === 0) {
            await createInitialData();
            console.log('已建立初始資料');
        }
        else {
            console.log('已載入班表資料');
        }

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

// 建立初始資料（從2026.1.4開始的4週）
async function createInitialData() {
    const startDate = new Date(2026, 0, 4); // 2026年1月4日（週六）

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

    await setDoc(doc(db, COLLECTION_NAME, '_metadata'), {
        serviceItems: serviceItems
    });
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
        html += `<th class="service-header">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <span class="service-header-text" data-service="${item}">${item}</span>
        <div class="header-actions">
          <button class="header-btn edit-service-btn" data-service="${item}" title="編輯">✏️</button>
          <button class="header-btn delete delete-service-btn" data-service="${item}" title="刪除">🗑️</button>
        </div>
      </div>
    </th>`;
    });

    html += '</tr>';
    thead.innerHTML = html;

    // 設定服事項目編輯按鈕事件
    document.querySelectorAll('.edit-service-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const serviceName = e.target.dataset.service;
            openEditServiceModal(serviceName);
        });
    });

    // 設定服事項目刪除按鈕事件
    document.querySelectorAll('.delete-service-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const serviceName = e.target.dataset.service;
            deleteServiceItem(serviceName);
        });
    });
}

function renderTableBody() {
    const tbody = document.getElementById('tableBody');

    let html = '';
    scheduleData.forEach((row, rowIndex) => {
        html += '<tr>';

        // 日期欄位
        html += `<td>
      <div class="date-cell date-cell-editable" data-index="${rowIndex}">
        ${row.date}
      </div>
    </td>`;

        // 服事項目欄位
        serviceItems.forEach(item => {
            const persons = row[item] || [];
            const isEmpty = persons.length === 0;

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
                     <button class="remove-btn" data-date="${row.date}" data-service="${item}" data-person="${person}">×</button>
                   </div>`;
                });
                html += '</div>';
            }

            html += '</td>';
        });

        html += '</tr>';
    });

    tbody.innerHTML = html;

    // 設定日期編輯事件
    document.querySelectorAll('.date-cell').forEach(cell => {
        cell.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            openEditDateModal(index);
        });
    });

    // 設定服事欄位點擊事件
    document.querySelectorAll('.service-cell').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (!e.target.closest('.person-chip') && !e.target.closest('.remove-btn')) {
                const date = cell.dataset.date;
                const service = cell.dataset.service;
                openEditPersonModal(date, service);
            }
        });
    });

    // 設定人員刪除按鈕事件
    document.querySelectorAll('.person-chip .remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const date = btn.dataset.date;
            const service = btn.dataset.service;
            const person = btn.dataset.person;
            removePerson(date, service, person);
        });
    });

    // 設定拖拉事件
    setupDragAndDrop();
}

// ===========================
// 日期管理
// ===========================
function openEditDateModal(index) {
    currentEditingDateIndex = index;
    const currentDate = scheduleData[index].date;

    document.getElementById('dateInput').value = currentDate;
    document.getElementById('editDateModal').classList.remove('hidden');
}

document.getElementById('saveDateBtn').addEventListener('click', async () => {
    const newDateStr = document.getElementById('dateInput').value.trim();

    // 驗證日期格式
    if (!newDateStr.match(/^\d{4}\.\d{1,2}\.\d{1,2}$/)) {
        alert('日期格式錯誤，請使用 yyyy.mm.dd 格式（例如：2026.01.04）');
        return;
    }

    const newDate = parseDateString(newDateStr);
    const dayOfWeek = newDate.getDay();

    if (dayOfWeek !== 0) {
        const confirm = window.confirm('此日期不是星期日，確定要使用嗎？');
        if (!confirm) return;
    }

    updateStatus('更新日期中...');

    try {
        const index = currentEditingDateIndex;
        const oldDateStr = scheduleData[index].date;

        // 計算日期差異
        const oldDate = parseDateString(oldDateStr);
        const dayDiff = Math.round((newDate - oldDate) / (1000 * 60 * 60 * 24));

        // 更新所有日期
        const updates = [];
        for (let i = 0; i < scheduleData.length; i++) {
            const oldDate = parseDateString(scheduleData[i].date);
            const newDate = new Date(oldDate);
            newDate.setDate(newDate.getDate() + dayDiff);
            const newDateStr = formatDateString(newDate);

            // 取得資料
            const data = { ...scheduleData[i] };
            delete data.date;

            // 刪除舊資料
            updates.push(deleteSchedule(scheduleData[i].date));

            // 更新本地資料
            scheduleData[i].date = newDateStr;

            // 儲存新資料
            updates.push(saveSchedule(newDateStr, data));
        }

        await Promise.all(updates);

        // 重新排序
        scheduleData.sort((a, b) => {
            const dateA = parseDateString(a.date);
            const dateB = parseDateString(b.date);
            return dateA - dateB;
        });

        renderTable();
        closeModal('editDateModal');
        updateStatus('日期已更新');

    } catch (error) {
        console.error('更新日期失敗:', error);
        alert('更新日期失敗');
        updateStatus('就緒');
    }
});

async function addNewRow() {
    if (scheduleData.length === 0) {
        alert('請先建立初始資料');
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
        updateStatus('服事項目已新增');

    } catch (error) {
        console.error('新增服事項目失敗:', error);
        alert('新增服事項目失敗');
        serviceItems.pop(); // 還原
        updateStatus('就緒');
    }
}

function openEditServiceModal(serviceName) {
    currentEditingServiceName = serviceName;
    document.getElementById('serviceNameInput').value = serviceName;
    document.getElementById('editServiceModal').classList.remove('hidden');
}

document.getElementById('saveServiceBtn').addEventListener('click', async () => {
    const newName = document.getElementById('serviceNameInput').value.trim();

    if (!newName) {
        alert('請輸入服事項目名稱');
        return;
    }

    if (newName === currentEditingServiceName) {
        closeModal('editServiceModal');
        return;
    }

    if (serviceItems.includes(newName)) {
        alert('此服事項目名稱已存在');
        return;
    }

    updateStatus('更新服事項目中...');

    try {
        const oldName = currentEditingServiceName;

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

        renderTable();
        closeModal('editServiceModal');
        updateStatus('服事項目已更新');

    } catch (error) {
        console.error('更新服事項目失敗:', error);
        alert('更新服事項目失敗');
        updateStatus('就緒');
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

        // 更新所有資料
        const updates = [];
        scheduleData.forEach(row => {
            delete row[serviceName];

            const data = { ...row };
            delete data.date;
            updates.push(saveSchedule(row.date, data));
        });

        // 儲存 metadata
        updates.push(saveMetadata());

        await Promise.all(updates);

        renderTable();
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

    // 顯示所有人名下拉選單
    renderPersonDropdown();

    // 顯示目前人員
    renderCurrentPersonChips();

    document.getElementById('editPersonModal').classList.remove('hidden');
    document.getElementById('newPersonInput').value = '';
}

function renderPersonDropdown() {
    const dropdown = document.getElementById('personDropdown');

    if (allPersonNames.size === 0) {
        dropdown.innerHTML = '<div class="text-muted text-center" style="padding: 8px;">尚無人員記錄，請在下方輸入新人員</div>';
        return;
    }

    const sortedNames = Array.from(allPersonNames).sort();

    let html = '';
    sortedNames.forEach(name => {
        const chipColor = getPersonColor(name);
        html += `<div class="person-chip-selectable" data-person="${name}" style="background: ${chipColor};">${name}</div>`;
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

    // 更新顯示
    renderCurrentPersonChips();
    renderPersonDropdown();
    renderTable();
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

        // 更新顯示
        renderTable();
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
// Excel 複製貼上功能
// ===========================
function setupPasteHandler() {
    document.addEventListener('paste', async (e) => {
        // 如果焦點在輸入框上，不處理
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
            return;
        }

        e.preventDefault();

        const clipboardData = e.clipboardData || window.clipboardData;
        const pastedData = clipboardData.getData('Text');

        if (!pastedData) return;

        // 解析貼上的資料
        const rows = pastedData.split('\n').filter(row => row.trim() !== '');
        if (rows.length === 0) return;

        const confirm = window.confirm(`偵測到貼上 ${rows.length} 列資料，是否要匯入到班表中？`);
        if (!confirm) return;

        updateStatus('匯入資料中...');

        try {
            // 解析每一列
            const parsedRows = rows.map(row => {
                const cells = row.split('\t');
                return cells;
            });

            // 從第一列資料開始處理
            for (let i = 0; i < parsedRows.length && i < scheduleData.length; i++) {
                const cells = parsedRows[i];
                const rowData = scheduleData[i];

                // cells[0] 是日期，從 cells[1] 開始是服事項目
                for (let j = 1; j < cells.length && j - 1 < serviceItems.length; j++) {
                    const serviceName = serviceItems[j - 1];
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

            renderTable();
            updateStatus('資料匯入完成');
            alert('資料匯入成功！');

        } catch (error) {
            console.error('匯入資料失敗:', error);
            alert('匯入資料失敗');
            updateStatus('就緒');
        }
    });
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

window.closeModal = function (modalId) {
    document.getElementById(modalId).classList.add('hidden');
};

// ===========================
// 事件監聽器設定
// ===========================
function setupEventListeners() {
    document.getElementById('addRowBtn').addEventListener('click', addNewRow);
    document.getElementById('deleteLastRowBtn').addEventListener('click', deleteLastRow);
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
