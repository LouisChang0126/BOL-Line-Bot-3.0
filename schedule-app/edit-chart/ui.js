// ===========================
// ui.js — 純 UI 渲染與彈窗邏輯
// ===========================
// 此模組負責：
//   1. 表格的生成（renderTable, renderTableHead, renderTableBody）
//   2. Modal 彈出視窗邏輯（新增欄位、編輯服事項目、編輯人員）
//   3. 群組顯示設定的渲染（renderDisplayConfigModal）

import {
    scheduleData, serviceItems, nonUserColumns,
    getPersonColor,
    addPersonToCell, removePerson,
    addNewRow, deleteLastRow,
    doAddServiceItem, doAddInfoColumn,
    addInfoItem, updateInfoItem, removeInfoItem,
    setCurrentEditingCell,
    saveMetadata,
    setupDragAndDrop, setupContextMenu, setupMultiCellSelection,
    prepareDisplayConfigEditorState, saveDisplayConfig, checkMissingUsers,
    updateStatus,
    pushHistory, updateEditDifference
} from './app.js';

import { pendingAgentChanges, showModalAlert } from './agent.js';

// ===========================
// 外部注入 — 由 app.js 呼叫 setUIContext() 傳入無法直接 import 的可變狀態
// ===========================
let _ctx = {
    showingPast: false,
    pastData: [],
    currentEditingCell: null,
    allPersonNames: new Set(),
    multiSelectStarted: false,
    multiSelectedCells: [],
    tempDisplayConfig: null
};

/** app.js 每次狀態改變後呼叫此函式同步最新的可變參考 */
export function setUIContext(ctx) {
    Object.assign(_ctx, ctx);
}

// ===========================
// 表格渲染
// ===========================
export function renderTable() {
    renderTableHead();
    renderTableBody();

    injectPendingHighlights();
}

// 注入差異高亮
function injectPendingHighlights() {
    if (!pendingAgentChanges || Object.keys(pendingAgentChanges).length === 0) return;

    Object.entries(pendingAgentChanges).forEach(([date, services]) => {
        Object.entries(services).forEach(([service, change]) => {
            const cell = document.querySelector(
                `.service-cell[data-date="${date}"][data-service="${service}"]`
            );
            if (!cell) return;

            const allPersons = Array.from(new Set([...(change.old || []), ...(change.new || [])]));

            cell.innerHTML = '';
            cell.classList.remove('empty');
            cell.classList.add('pending-modify');

            const chipsContainer = document.createElement('div');
            chipsContainer.className = 'person-chips';

            allPersons.forEach(person => {
                const isOld = change.old.includes(person);
                const isNew = change.new.includes(person);

                const chip = document.createElement('div');
                chip.className = 'person-chip';
                chip.textContent = person;

                if (isOld && !isNew) {
                    chip.style.backgroundColor = '#ef4444';
                    chip.style.textDecoration = 'line-through';
                    chip.style.textDecorationThickness = '5px';
                    chip.style.opacity = '0.9';
                } else if (!isOld && isNew) {
                    chip.style.backgroundColor = '#22c55e';
                } else {
                    chip.style.backgroundColor = getPersonColor(person);
                }

                chip.addEventListener('click', (e) => e.stopPropagation());
                chipsContainer.appendChild(chip);
            });

            cell.appendChild(chipsContainer);

            const btnsDiv = document.createElement('div');
            btnsDiv.className = 'cell-review-btns';

            const acceptBtn = document.createElement('button');
            acceptBtn.className = 'cell-review-btn accept';
            acceptBtn.type = 'button';
            acceptBtn.textContent = '✅';
            acceptBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.acceptCellChange(date, service);
            });

            const rejectBtn = document.createElement('button');
            rejectBtn.className = 'cell-review-btn reject';
            rejectBtn.type = 'button';
            rejectBtn.textContent = '❌';
            rejectBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                window.rejectCellChange(date, service);
            });

            btnsDiv.appendChild(acceptBtn);
            btnsDiv.appendChild(rejectBtn);
            cell.appendChild(btnsDiv);
        });
    });
}

export function renderTableHead() {
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

    // 服事項目名稱點擊 → 開啟編輯 Modal
    document.querySelectorAll('.service-header-editable').forEach(span => {
        span.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditServiceModal(e.target.dataset.service);
        });
    });

    // 服事標題拖拉排序
    setupServiceHeaderDragAndDrop();
}

// 服事標題拖拉排序
function setupServiceHeaderDragAndDrop() {
    const headers = document.querySelectorAll('.service-header[draggable="true"]');

    let draggedHeader = null;
    let draggedIndex = null;

    headers.forEach(header => {
        header.addEventListener('dragstart', (e) => {
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

        header.addEventListener('dragend', () => {
            header.classList.remove('dragging');
            headers.forEach(h => h.classList.remove('drag-over'));
        });

        header.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            if (header !== draggedHeader) header.classList.add('drag-over');
        });

        header.addEventListener('dragleave', () => {
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
                const draggedService = serviceItems[draggedIndex];
                serviceItems.splice(draggedIndex, 1);
                serviceItems.splice(targetIndex, 0, draggedService);

                await saveMetadata();

                pushHistory();
                updateEditDifference();
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

export function renderTableBody() {
    const tbody = document.getElementById('tableBody');
    const { showingPast, pastData, multiSelectStarted, multiSelectedCells } = _ctx;

    let dataToRender = (showingPast && pastData.length > 0)
        ? [...pastData, ...scheduleData]
        : scheduleData;

    let html = '';
    dataToRender.forEach((row, rowIndex) => {
        const isPast = showingPast && rowIndex < pastData.length;
        const rowClass = isPast ? 'style="opacity: 0.6; background: #f8fafc;"' : '';

        html += `<tr ${rowClass}>`;

        // 日期欄位
        if (isPast) {
            html += `<td><div class="date-cell" style="cursor: default;">${row.date}</div></td>`;
        } else {
            html += `<td><div class="date-cell" style="cursor: default;">${row.date}</div></td>`;
        }

        // 服事項目欄位
        serviceItems.forEach(item => {
            const persons = row[item] || [];
            const isEmpty = persons.length === 0;

            if (isPast) {
                html += `<td class="service-cell ${isEmpty ? 'empty' : ''}" style="cursor: default;">`;
                if (!isEmpty) {
                    html += '<div class="person-chips">';
                    persons.forEach(person => {
                        const chipColor = getPersonColor(person);
                        html += `<div class="person-chip" style="background: ${chipColor}; cursor: default;">${person}</div>`;
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

    // 表格操作按鈕列
    const colSpan = serviceItems.length + 1;
    html += `<tr class="table-action-row">
        <td colspan="${colSpan}">
            <div class="table-action-buttons">
                <button class="btn btn-primary" id="addRowBtn">➕ 新增一週</button>
                <button class="btn btn-danger" id="deleteLastRowBtn">➖ 刪除最後一週</button>
            </div>
        </td>
    </tr>`;

    tbody.innerHTML = html;

    // 綁定新增/刪除按鈕
    const addRowBtn = document.getElementById('addRowBtn');
    const deleteLastRowBtn = document.getElementById('deleteLastRowBtn');
    if (addRowBtn) addRowBtn.addEventListener('click', addNewRow);
    if (deleteLastRowBtn) deleteLastRowBtn.addEventListener('click', deleteLastRow);

    // 服事欄位點擊事件（未來資料）
    document.querySelectorAll('.service-cell[data-date]').forEach(cell => {
        cell.addEventListener('click', (e) => {
            if (_ctx.multiSelectStarted || _ctx.multiSelectedCells.length > 0) {
                _ctx.multiSelectStarted = false;
                return;
            }
            if (!e.target.closest('.person-chip')) {
                openEditPersonModal(cell.dataset.date, cell.dataset.service);
            }
        });
    });

    // 拖拉、右鍵選單、多格選取事件由 app.js 負責設定
    setupDragAndDrop();
    setupContextMenu();
    setupMultiCellSelection();
}

// 顏色工具與其他 Modal 邏輯
// ===========================

// ===========================
// Modal：新增欄位（服事項目 / 資訊欄位）
// ===========================
export function showAddColumnModal() {
    const modal = document.getElementById('addColumnModal');
    const input = document.getElementById('addColumnInput');
    const confirmBtn = document.getElementById('addColumnConfirmBtn');

    document.getElementById('addColTypeService').checked = true;
    updateAddColTypeUI();

    input.value = '';
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 50);

    const onEnter = (e) => { if (e.key === 'Enter') confirmBtn.click(); };
    input.addEventListener('keydown', onEnter);

    const onConfirm = () => {
        const mode = document.querySelector('input[name="addColType"]:checked')?.value || 'service';
        const name = input.value.trim();
        input.removeEventListener('keydown', onEnter);
        confirmBtn.removeEventListener('click', onConfirm);
        modal.classList.add('hidden');

        if (!name) return;

        if (name.includes('|')) {
            showModalAlert('名稱不能包含 "|" 符號');
            return;
        }

        if (serviceItems.includes(name)) {
            showModalAlert(mode === 'service' ? '此服事項目已存在' : '此欄位名稱已存在');
            return;
        }

        if (mode === 'service') {
            doAddServiceItem(name);
        } else {
            doAddInfoColumn(name);
        }
    };
    confirmBtn.addEventListener('click', onConfirm);
}

export function updateAddColTypeUI() {
    const serviceLabel = document.getElementById('addColTypeServiceBtn');
    const infoLabel = document.getElementById('addColTypeInfoBtn');
    if (!serviceLabel || !infoLabel) return;
    const isService = document.getElementById('addColTypeService').checked;
    serviceLabel.classList.toggle('btn-primary', isService);
    serviceLabel.classList.toggle('btn-secondary', !isService);
    infoLabel.classList.toggle('btn-primary', !isService);
    infoLabel.classList.toggle('btn-secondary', isService);
}

// ===========================
// Modal：編輯服事項目
// ===========================
export function openEditServiceModal(serviceName) {
    // 將目前編輯的服事名稱暫存到 window，供 app.js 的儲存/刪除按鈕事件使用
    window._currentEditingServiceName = serviceName;

    document.getElementById('serviceNameInput').value = serviceName;
    const isInfoColumn = nonUserColumns.includes(serviceName);
    document.getElementById('isInfoColumnCheckbox').checked = isInfoColumn;
    document.getElementById('editServiceModal').classList.remove('hidden');
}

// ===========================
// Modal：編輯人員（openEditPersonModal + 子渲染函式）
// ===========================
export function openEditPersonModal(date, service) {
    _ctx.currentEditingCell = { date, service };
    setCurrentEditingCell({ date, service });

    const isInfoColumn = nonUserColumns.includes(service);

    document.getElementById('editPersonModalSubtitle').textContent = `${date} - ${service}`;

    const formGroups = document.getElementById('editPersonModal').querySelectorAll('.form-group');
    const firstLabel = formGroups[0]?.querySelector('label');
    const secondLabel = formGroups[1]?.querySelector('label');

    if (isInfoColumn) {
        document.getElementById('personSelectContainer').style.display = 'none';
        if (firstLabel) firstLabel.textContent = '資訊內容';
        if (secondLabel) secondLabel.style.display = 'none';
        renderInfoInputs(date, service);
    } else {
        document.getElementById('personSelectContainer').style.display = 'block';
        if (firstLabel) firstLabel.textContent = '選擇現有人員或輸入新人員';
        if (secondLabel) {
            secondLabel.style.display = 'block';
            secondLabel.textContent = '目前服事人員';
        }
        renderPersonDropdown(date, service);
        renderCurrentPersonChips(date, service);
        document.getElementById('newPersonInput').value = '';
    }

    document.getElementById('editPersonModal').classList.remove('hidden');
}

export function renderPersonDropdown(date, service) {
    const dropdown = document.getElementById('personDropdown');

    const row = scheduleData.find(r => r.date === date);
    const currentPersons = row ? (row[service] || []) : [];

    const serviceVeterans = new Set();
    scheduleData.forEach(r => {
        if (r.date !== date && r[service]) {
            r[service].forEach(name => serviceVeterans.add(name));
        }
    });

    const allPersonNames = _ctx.allPersonNames;
    const availableNames = Array.from(allPersonNames)
        .filter(name => !currentPersons.includes(name));

    availableNames.sort((a, b) => {
        const aV = serviceVeterans.has(a);
        const bV = serviceVeterans.has(b);
        if (aV && !bV) return -1;
        if (!aV && bV) return 1;
        return a.localeCompare(b, 'zh-TW');
    });

    if (availableNames.length === 0) {
        dropdown.innerHTML = allPersonNames.size === 0
            ? '<div class="text-muted text-center" style="padding: 8px;">尚無人員記錄，請輸入新人員</div>'
            : '<div class="text-muted text-center" style="padding: 8px;">無可用人員，請輸入新人員</div>';
        return;
    }

    let html = '';
    availableNames.forEach(name => {
        const chipColor = getPersonColor(name);
        const isVeteran = serviceVeterans.has(name);
        html += `<div class="person-chip-selectable${isVeteran ? ' veteran' : ''}" data-person="${name}" style="background: ${chipColor};">${name}</div>`;
    });
    dropdown.innerHTML = html;

    dropdown.querySelectorAll('.person-chip-selectable').forEach(item => {
        item.addEventListener('click', (e) => {
            const person = e.target.dataset.person;
            if (person && _ctx.currentEditingCell) {
                addPersonToCell(_ctx.currentEditingCell.date, _ctx.currentEditingCell.service, person);
            }
        });
    });
}

export function renderCurrentPersonChips(date, service) {
    const row = scheduleData.find(r => r.date === date);
    const persons = row ? (row[service] || []) : [];
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

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const person = e.target.dataset.person;
            removePerson(date, service, person);
            renderCurrentPersonChips(date, service);
        });
    });
}

export function renderInfoInputs(date, service) {
    const row = scheduleData.find(r => r.date === date);
    const items = row ? (row[service] || []) : [];
    const container = document.getElementById('currentPersonChips');

    let html = '';
    items.forEach((item, index) => {
        html += `
            <div class="info-input-row">
                <input type="text" class="info-text-input" data-index="${index}" value="${item}" placeholder="輸入資訊...">
                <button class="remove-info-btn" data-index="${index}">×</button>
            </div>
        `;
    });
    html += `
        <div class="info-input-row">
            <input type="text" class="info-text-input" id="newInfoInput" placeholder="輸入新資訊...">
            <button class="add-info-btn" id="addInfoBtn">+</button>
        </div>
    `;
    container.innerHTML = html;

    container.querySelectorAll('.info-text-input:not(#newInfoInput)').forEach(input => {
        input.addEventListener('change', (e) => {
            const index = parseInt(e.target.dataset.index);
            const newValue = e.target.value.trim();
            if (newValue === '') {
                removeInfoItem(date, service, index);
                renderInfoInputs(date, service);
            } else {
                updateInfoItem(date, service, index, newValue);
            }
        });
    });

    container.querySelectorAll('.remove-info-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            removeInfoItem(date, service, index);
            renderInfoInputs(date, service);
        });
    });

    const addBtn = document.getElementById('addInfoBtn');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            const newInput = document.getElementById('newInfoInput');
            const value = newInput.value.trim();
            if (!value) { alert('請輸入資訊'); return; }
            addInfoItem(date, service, value);
            renderInfoInputs(date, service);
        });
    }

    const newInput = document.getElementById('newInfoInput');
    if (newInput) {
        newInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') document.getElementById('addInfoBtn').click();
        });
    }
}

// ===========================
// Modal：群組顯示設定（renderDisplayConfigModal）
// ===========================
export function initDisplayConfigEditor() {
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

    const addColumnBtn = document.getElementById('addColumnBtn');
    if (addColumnBtn) {
        addColumnBtn.addEventListener('click', () => showAddColumnModal());
        document.querySelectorAll('input[name="addColType"]').forEach(r => {
            r.addEventListener('change', updateAddColTypeUI);
        });
    }

    const viewLogsBtn = document.getElementById('viewLogsBtn');
    if (viewLogsBtn) {
        viewLogsBtn.addEventListener('click', () => {
            const collectionName = window.COLLECTION_NAME;
            window.location.href = `./difference.html?collection=${collectionName}`;
        });
    }

    const manageUsersBtn = document.getElementById('manageUsersBtn');
    if (manageUsersBtn) {
        manageUsersBtn.addEventListener('click', () => {
            const collectionName = window.COLLECTION_NAME;
            window.location.href = `edit-user.html?collection=${collectionName}`;
        });
    }

    checkMissingUsers();
}

function openDisplayConfigModal() {
    prepareDisplayConfigEditorState();
    renderDisplayConfigModal();
    document.getElementById('displayConfigModal').classList.remove('hidden');
}

function addNewGroup() {
    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;

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

export function renderDisplayConfigModal() {
    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;

    const groupsContainer = document.getElementById('displayConfigGroups');
    const hiddenZoneItems = document.getElementById('hiddenZoneItems');

    // 渲染群組
    let groupsHtml = '';
    tempDisplayConfig.groups.forEach((group) => {
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

    hiddenZoneItems.ondragover = window.handleDragOver;
    hiddenZoneItems.ondragleave = window.handleDragLeave;
    hiddenZoneItems.ondrop = (e) => window.handleDrop(e, 'hidden');
}

// ===========================
// 群組拖拉（window 掛載，供 renderDisplayConfigModal 的 inline handler 呼叫）
// ===========================
window.handleDragStart = function (event) {
    event.target.classList.add('dragging');
    event.dataTransfer.setData('text/plain', event.target.dataset.service);
    event.dataTransfer.effectAllowed = 'move';
    window.draggingElement = event.target;
};

window.handleDragEnd = function (event) {
    event.target.classList.remove('dragging');
    window.draggingElement = null;
    document.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());
};

window.handleDragOver = function (event) {
    event.preventDefault();
    const container = event.currentTarget;
    container.classList.add('drag-over');

    container.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());

    const draggables = Array.from(container.querySelectorAll('.draggable-service:not(.dragging)'));
    const dropX = event.clientX;
    const dropY = event.clientY;

    let insertBefore = null;
    let minDistance = Infinity;

    for (const draggable of draggables) {
        const rect = draggable.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distance = Math.abs(dropX - centerX) + Math.abs(dropY - centerY) * 0.5;

        if (dropX < centerX && distance < minDistance) {
            minDistance = distance;
            insertBefore = draggable;
        }
    }

    const indicator = document.createElement('div');
    indicator.className = 'drag-insert-indicator';
    if (insertBefore) {
        container.insertBefore(indicator, insertBefore);
    } else {
        container.appendChild(indicator);
    }
    container.insertBeforeElement = insertBefore;
};

window.handleDragLeave = function (event) {
    event.currentTarget.classList.remove('drag-over');
    event.currentTarget.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());
};

window.handleDrop = function (event, targetGroupId) {
    event.preventDefault();
    const container = event.currentTarget;
    container.classList.remove('drag-over');
    container.querySelectorAll('.drag-insert-indicator').forEach(el => el.remove());

    const serviceName = event.dataTransfer.getData('text/plain');
    if (!serviceName) return;

    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;

    const insertBeforeElement = container.insertBeforeElement;
    const insertBeforeService = insertBeforeElement ? insertBeforeElement.dataset.service : null;

    // 從所有群組和隱藏區域移除
    tempDisplayConfig.groups.forEach(group => {
        const index = group.items.indexOf(serviceName);
        if (index > -1) group.items.splice(index, 1);
    });
    const hiddenIndex = tempDisplayConfig.hidden.indexOf(serviceName);
    if (hiddenIndex > -1) tempDisplayConfig.hidden.splice(hiddenIndex, 1);

    // 新增到目標位置
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

    container.insertBeforeElement = null;
    renderDisplayConfigModal();
};

window.updateGroupName = function (groupId, newName) {
    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (group) group.name = newName;
};

window.toggleGroupVisibility = function (groupId, visible) {
    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (group) group.defaultVisible = visible;
};

window.deleteGroup = function (groupId) {
    const tempDisplayConfig = _ctx.tempDisplayConfig;
    if (!tempDisplayConfig) return;
    const group = tempDisplayConfig.groups.find(g => g.id === groupId);
    if (!group || group.id === 'ungrouped') return;

    const ungrouped = tempDisplayConfig.groups.find(g => g.id === 'ungrouped');
    if (ungrouped) ungrouped.items.push(...group.items);

    const index = tempDisplayConfig.groups.findIndex(g => g.id === groupId);
    if (index > -1) tempDisplayConfig.groups.splice(index, 1);

    renderDisplayConfigModal();
};

/**
 * 通用確認對話框
 * @param {string} message 提示訊息
 * @param {string} title 標題
 * @returns {Promise<boolean>} 使用者點擊確認回傳 true, 取消回傳 false
 */
export function showConfirm(message, title = '確認操作') {
    return new Promise((resolve) => {
        const modal = document.getElementById('confirmModal');
        if (!modal) {
            console.error('Confirm modal not found');
            resolve(window.confirm(message));
            return;
        }

        const titleEl = document.getElementById('confirmModalTitle');
        const messageEl = document.getElementById('confirmModalMessage');
        const confirmBtn = document.getElementById('confirmModalBtn');
        const cancelBtn = modal.querySelector('.btn-secondary');
        const closeBtn = modal.querySelector('.modal-close');

        if (!confirmBtn || !cancelBtn || !closeBtn || !titleEl || !messageEl) {
            console.error('Confirm modal elements not found');
            resolve(window.confirm(message));
            return;
        }

        titleEl.textContent = title;
        messageEl.textContent = message;
        modal.classList.remove('hidden');

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        const cleanup = () => {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            closeBtn.removeEventListener('click', onCancel);
            modal.classList.add('hidden');
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        closeBtn.addEventListener('click', onCancel);
    });
}
