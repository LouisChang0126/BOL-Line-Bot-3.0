import {
    scheduleData, serviceItems, nonUserColumns, personColorMap,
    saveSchedule, addNewRow, deleteLastRow, doAddServiceItem, deleteServiceItem,
    pushHistory, updateEditDifference, updateStatus
} from './app.js';

import { renderTable } from './ui.js';

// ===========================
// Agent 排班副駕功能
// ===========================

// --- Agent 狀態 ---
export let pendingAgentChanges = null;
let attachedCsvText = null;
let agentIsLoading = false;

// Cloud Function URL（從 firebase-config.js 載入）
const AGENT_API_URL = window.AGENT_API_URL || '';

// --- 側邊欄控制 ---
export function setupAgentSidebar() {
    const sidebar = document.getElementById('agentSidebar');
    const toggleBtn = document.getElementById('toggleSidebarBtn');
    const closeBtn = document.getElementById('closeSidebarBtn');

    if (toggleBtn) {
        toggleBtn.addEventListener('click', () => {
            sidebar.classList.toggle('collapsed');
        });
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            sidebar.classList.add('collapsed');
        });
    }

    // 送出按鈕
    const sendBtn = document.getElementById('agentSendBtn');
    const promptInput = document.getElementById('agentPromptInput');

    if (sendBtn) {
        sendBtn.addEventListener('click', () => sendAgentRequest());
    }

    if (promptInput) {
        promptInput.addEventListener('input', () => {
            promptInput.style.height = 'auto';
            promptInput.style.height = Math.min(promptInput.scrollHeight, 100) + 'px';
        });

        promptInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendAgentRequest();
            }
        });
    }

    // 排班規則收合/展開
    const rulesToggle = document.getElementById('agentRulesToggle');
    const rulesContent = document.getElementById('agentRulesContent');
    const rulesIcon = document.getElementById('agentRulesIcon');

    if (rulesToggle && rulesContent && rulesIcon) {
        rulesToggle.addEventListener('click', () => {
            if (rulesContent.style.display === 'none') {
                rulesContent.style.display = 'block';
                rulesIcon.textContent = '▼';
            } else {
                rulesContent.style.display = 'none';
                rulesIcon.textContent = '▶';
            }
        });
    }

    // CSV 上傳
    const csvInput = document.getElementById('csvFileInput');
    const attachmentPreview = document.getElementById('attachmentPreview');
    const attachmentName = document.getElementById('attachmentName');
    const removeAttachmentBtn = document.getElementById('removeAttachmentBtn');

    if (csvInput) {
        csvInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                attachedCsvText = event.target.result;
                attachmentName.textContent = `📄 ${file.name}`;
                attachmentPreview.classList.remove('hidden');
            };
            reader.readAsText(file);
        });
    }

    if (removeAttachmentBtn) {
        removeAttachmentBtn.addEventListener('click', () => {
            attachedCsvText = null;
            attachmentPreview.classList.add('hidden');
            csvInput.value = '';
        });
    }

    // Accept/Reject 全部
    const acceptAllBtn = document.getElementById('acceptAllBtn');
    const rejectAllBtn = document.getElementById('rejectAllBtn');

    if (acceptAllBtn) {
        acceptAllBtn.addEventListener('click', () => acceptAllChanges());
    }
    if (rejectAllBtn) {
        rejectAllBtn.addEventListener('click', () => rejectAllChanges());
    }
}

// --- 聊天 UI ---
export function addChatMessage(text, role = 'user') {
    const chatArea = document.getElementById('agentChatArea');
    const welcome = chatArea.querySelector('.agent-chat-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `agent-msg ${role}`;
    msg.textContent = text;
    chatArea.appendChild(msg);
    chatArea.scrollTop = chatArea.scrollHeight;
}

export function showAgentLoading() {
    const chatArea = document.getElementById('agentChatArea');
    const loading = document.createElement('div');
    loading.className = 'agent-loading';
    loading.id = 'agentLoadingIndicator';
    loading.innerHTML = `
        <div class="agent-loading-dot"></div>
        <div class="agent-loading-dot"></div>
        <div class="agent-loading-dot"></div>
    `;
    chatArea.appendChild(loading);
    chatArea.scrollTop = chatArea.scrollHeight;
}

export function hideAgentLoading() {
    const loading = document.getElementById('agentLoadingIndicator');
    if (loading) loading.remove();
}

// --- ScheduleValidator ---
class ScheduleValidator {
    constructor() { this.rules = []; }
    addRule(name, checkFn) { this.rules.push({ name, checkFn }); }
    validate(scheduleData, serviceItems, nonUserColumns, activeRules) {
        const warnings = [];
        const userServiceItems = serviceItems.filter(s => !nonUserColumns.includes(s));
        for (const rule of this.rules) {
            if (activeRules[rule.name]) {
                warnings.push(...rule.checkFn(scheduleData, userServiceItems));
            }
        }
        return { valid: warnings.length === 0, warnings };
    }
}

const scheduleValidator = new ScheduleValidator();

// 規則1: 連續兩週相同服事
scheduleValidator.addRule('consecutive', (scheduleData, userServiceItems) => {
    const warnings = [];
    for (let i = 1; i < scheduleData.length; i++) {
        const prevRow = scheduleData[i - 1];
        const currRow = scheduleData[i];
        userServiceItems.forEach(service => {
            const duplicates = (prevRow[service] || []).filter(n => (currRow[service] || []).includes(n));
            duplicates.forEach(name => {
                warnings.push({
                    type: 'consecutive',
                    message: `⚠️ ${name} 連續兩週擔任「${service}」（${prevRow.date} → ${currRow.date}）`,
                    date: currRow.date, service, person: name
                });
            });
        });
    }
    return warnings;
});

// 規則2: 單週最多 N 項服事
scheduleValidator.addRule('maxRoles', (scheduleData, userServiceItems) => {
    const MAX_ROLES = 3;
    const warnings = [];
    scheduleData.forEach(row => {
        const counts = {};
        userServiceItems.forEach(service => {
            (row[service] || []).forEach(name => { counts[name] = (counts[name] || 0) + 1; });
        });
        Object.entries(counts).forEach(([name, count]) => {
            if (count > MAX_ROLES) {
                warnings.push({
                    type: 'maxRoles',
                    message: `⚠️ ${name} 在 ${row.date} 擔任了 ${count} 項服事（上限 ${MAX_ROLES}）`,
                    date: row.date, person: name, count
                });
            }
        });
    });
    return warnings;
});

// --- API 呼叫 ---
export async function sendAgentRequest() {
    const promptInput = document.getElementById('agentPromptInput');
    const prompt = promptInput.value.trim();
    if (!prompt || agentIsLoading) return;

    if (!AGENT_API_URL) {
        addChatMessage('未設定 Agent API URL，請先檢查 firebase-config.js。', 'error');
        return;
    }

    addChatMessage(prompt, 'user');
    promptInput.value = '';
    promptInput.style.height = 'auto';

    const selectedModel = document.getElementById('modelSelect').value;
    const activeRules = {
        consecutive: document.getElementById('ruleConsecutive').checked,
        maxRoles: document.getElementById('ruleMaxRoles').checked
    };

    // 取得歷史訊息對話紀錄
    const chatHistory = [];
    document.querySelectorAll('#agentChatArea .agent-msg').forEach(msg => {
        // 排除剛才由這次 input 觸發的 UI message，因為 prompt 已經傳了
        if (msg.textContent !== prompt) {
            chatHistory.push({
                role: msg.classList.contains('user') ? 'user' : 'assistant',
                content: msg.textContent
            });
        }
    });

    // 複製目前的 scheduleData，若有 pendingChanges 則先行合併，讓 LLM 基於最新的「草稿」繼續修改
    let effectiveScheduleData = JSON.parse(JSON.stringify(scheduleData));
    if (pendingAgentChanges) {
        Object.entries(pendingAgentChanges).forEach(([date, services]) => {
            const row = effectiveScheduleData.find(r => r.date === date);
            if (row) {
                Object.entries(services).forEach(([service, change]) => {
                    row[service] = [...change.new];
                });
            }
        });
    }

    const payload = {
        prompt,
        currentSchedule: JSON.stringify({ scheduleData: effectiveScheduleData, serviceItems, nonUserColumns }),
        selectedModel,
        activeRules,
        chatHistory
    };

    if (attachedCsvText) payload.attachedCsvText = attachedCsvText;

    agentIsLoading = true;
    document.getElementById('agentSendBtn').disabled = true;
    showAgentLoading();

    let retryCount = 0;
    const MAX_RETRIES = 2;
    let lastResult = null;

    while (retryCount <= MAX_RETRIES) {
        try {
            const response = await fetch(AGENT_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(retryCount > 0 ? {
                    ...payload,
                    prompt: `${prompt}\n\n[系統提示] 上次產生的班表違反規則，請修正：\n${lastResult.warnings.map(w => w.message).join('\n')}`
                } : payload)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API 錯誤 (${response.status}): ${errorText}`);
            }

            const result = await response.json();
            const validation = scheduleValidator.validate(result.scheduleData, serviceItems, nonUserColumns, activeRules);

            if (!validation.valid && retryCount < MAX_RETRIES) {
                lastResult = validation;
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            hideAgentLoading();

            if (!validation.valid) {
                // 如果有警告，優先顯示警告資訊
                addChatMessage((result.explanation || '已產生排班建議') + `（但有 ${validation.warnings.length} 項規則警告）`, 'assistant');
                validation.warnings.forEach(w => addChatMessage(w.message, 'error'));
            } else {
                // 有 explanation 就顯示 explanation，否則顯示預設字眼
                addChatMessage(result.explanation || '已產生排班建議，請檢視表格中的變更。', 'assistant');
            }

            // --- 處理結構變更 (Structural Changes) ---
            // 必須先處理結構變更，表格中有了對應的日期列/服事欄後，setPendingChanges 才能正確比對出差異

            // 1. 處理新增週數
            if (result.addWeeks > 0) {
                for (let i = 0; i < result.addWeeks; i++) {
                    await addNewRow(true); // skipConfirm
                }
            }
            // 2. 處理刪除週數
            if (result.removeWeeks > 0) {
                for (let i = 0; i < result.removeWeeks; i++) {
                    await deleteLastRow(true); // skipConfirm
                }
            }
            // 3. 處理新增服事/資訊欄位
            if (result.addServiceColumns && result.addServiceColumns.length > 0) {
                for (const colName of result.addServiceColumns) {
                    if (!serviceItems.includes(colName)) {
                        await doAddServiceItem(colName);
                    }
                }
            }
            // 4. 處理刪除服事/資訊欄位
            if (result.removeServiceColumns && result.removeServiceColumns.length > 0) {
                for (const colName of result.removeServiceColumns) {
                    if (serviceItems.includes(colName)) {
                        await deleteServiceItem(colName, true); // skipConfirm
                    }
                }
            }

            // 最後才計算內容差異，此時 scheduleData 已經是擴充後的狀態
            setPendingChanges(result.scheduleData);

            break;

        } catch (error) {
            hideAgentLoading();
            console.error('Agent API 呼叫失敗:', error);
            addChatMessage(`❌ 發生錯誤：${error.message}`, 'error');
            break;
        }
    }

    agentIsLoading = false;
    document.getElementById('agentSendBtn').disabled = false;
}

// --- Pending Changes 管理 ---
export function setPendingChanges(newScheduleData) {
    pendingAgentChanges = {};

    scheduleData.forEach((row) => {
        const date = row.date;
        const newRow = newScheduleData.find(r => r.date === date);
        if (!newRow) return;

        serviceItems.forEach(service => {
            if (nonUserColumns.includes(service)) return;

            const oldValue = JSON.stringify(row[service] || []);
            const newValue = JSON.stringify(newRow[service] || []);

            if (oldValue !== newValue) {
                if (!pendingAgentChanges[date]) pendingAgentChanges[date] = {};
                pendingAgentChanges[date][service] = {
                    old: row[service] || [],
                    new: newRow[service] || []
                };
            }
        });
    });

    const reviewBar = document.getElementById('agentReviewBar');
    if (Object.keys(pendingAgentChanges).length > 0) {
        reviewBar.classList.remove('hidden');
        renderTable();
    } else {
        addChatMessage('沒有需要變更的內容。', 'assistant');
    }
}

// Accept 單格
window.acceptCellChange = async function (date, service) {
    if (!pendingAgentChanges || !pendingAgentChanges[date] || !pendingAgentChanges[date][service]) return;

    const change = pendingAgentChanges[date][service];
    const row = scheduleData.find(r => r.date === date);
    if (!row) return;

    const oldValue = Array.isArray(row[service]) ? [...row[service]] : [];
    row[service] = [...change.new];

    try {
        const data = { ...row };
        delete data.date;
        await saveSchedule(row.date, data);
        pushHistory();
        updateEditDifference();

        delete pendingAgentChanges[date][service];
        if (Object.keys(pendingAgentChanges[date]).length === 0) delete pendingAgentChanges[date];

        checkPendingComplete();
        renderTable();
    } catch (error) {
        row[service] = oldValue;
        console.error('acceptCellChange failed:', error);
        addChatMessage(`單格儲存失敗：${error.message}`, 'error');
        renderTable();
    }
};

// Reject 單格
window.rejectCellChange = function (date, service) {
    if (!pendingAgentChanges || !pendingAgentChanges[date] || !pendingAgentChanges[date][service]) return;

    delete pendingAgentChanges[date][service];
    if (Object.keys(pendingAgentChanges[date]).length === 0) delete pendingAgentChanges[date];

    checkPendingComplete();
    renderTable();
};

// Accept 全部
export async function acceptAllChanges() {
    if (!pendingAgentChanges) return;

    try {
        const { writeBatch, doc } = window.firestore;
        const db = window.db;
        const COLLECTION_NAME = window.COLLECTION_NAME;
        const batch = writeBatch(db);

        Object.entries(pendingAgentChanges).forEach(([date, services]) => {
            const row = scheduleData.find(r => r.date === date);
            if (!row) return;
            Object.entries(services).forEach(([service, change]) => { row[service] = [...change.new]; });
            const data = { ...row };
            delete data.date;
            batch.set(doc(db, COLLECTION_NAME, row.date), data);
        });

        await batch.commit();
        pushHistory();
        updateEditDifference();

        pendingAgentChanges = null;
        document.getElementById('agentReviewBar').classList.add('hidden');
        renderTable();
        addChatMessage('✅ 已接受所有變更', 'assistant');
        updateStatus('Agent 變更已套用');
    } catch (error) {
        console.error('接受變更失敗:', error);
        addChatMessage('❌ 寫入資料庫失敗', 'error');
    }
}

// Reject 全部
export function rejectAllChanges() {
    pendingAgentChanges = null;
    document.getElementById('agentReviewBar').classList.add('hidden');
    renderTable();
    addChatMessage('❌ 已拒絕所有變更', 'assistant');
    updateStatus('Agent 變更已取消');
}

export function checkPendingComplete() {
    if (!pendingAgentChanges || Object.keys(pendingAgentChanges).length === 0) {
        pendingAgentChanges = null;
        document.getElementById('agentReviewBar').classList.add('hidden');
        addChatMessage('審核完成。', 'assistant');
    }
}

// 注入差異高亮
export function injectPendingHighlights() {
    if (!pendingAgentChanges || Object.keys(pendingAgentChanges).length === 0) return;

    Object.entries(pendingAgentChanges).forEach(([date, services]) => {
        Object.entries(services).forEach(([service, change]) => {
            const cell = document.querySelector(
                `.service-cell[data-date="${date}"][data-service="${service}"]`
            );
            if (!cell) return;

            // 取得所有涉入的服事人員 (舊的 + 新的) 並去除重複
            const allPersons = Array.from(new Set([...change.old, ...change.new]));

            // 清空儲存格內容 (刪除原本的 chips 或 placeholder)
            cell.innerHTML = '';
            cell.classList.remove('empty');
            // 加入 pending 統一的外框樣式（黃色底）
            cell.classList.add('pending-modify');

            // 重建 person-chips 容器
            const chipsContainer = document.createElement('div');
            chipsContainer.className = 'person-chips';

            allPersons.forEach(person => {
                const isOld = change.old.includes(person);
                const isNew = change.new.includes(person);

                const chip = document.createElement('div');
                chip.className = 'person-chip';
                chip.textContent = person;

                if (isOld && !isNew) {
                    // 原本有但現在被刪除 -> 紅色背景
                    chip.style.backgroundColor = '#ef4444';
                    chip.style.textDecoration = 'line-through';
                    chip.style.opacity = '0.9';
                } else if (!isOld && isNew) {
                    // 原本沒有但新增的 -> 綠色背景
                    chip.style.backgroundColor = '#22c55e';
                } else {
                    // 沒變動的 -> 保持原本顏色
                    chip.style.backgroundColor = personColorMap.get(person) || '#ccc';
                }

                // 為了避免點擊 chip 還是會觸發 cell click，阻止冒泡
                chip.addEventListener('click', (e) => e.stopPropagation());

                chipsContainer.appendChild(chip);
            });

            cell.appendChild(chipsContainer);

            // 加入 Accept / Reject 按鈕，並加上 event.stopPropagation()
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

// --- 可拖曳分隔線 ---
export function setupResizer() {
    const resizer = document.getElementById('agentResizer');
    const sidebar = document.getElementById('agentSidebar');
    const layout = document.querySelector('.agent-layout');
    if (!resizer || !sidebar || !layout) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    resizer.addEventListener('mousedown', (e) => {
        if (sidebar.classList.contains('collapsed')) return;
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const delta = startX - e.clientX;
        const rawWidth = startWidth + delta;

        if (rawWidth < 200) {
            isResizing = false;
            resizer.classList.remove('dragging');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            sidebar.classList.add('collapsed');
            resizer.classList.add('collapsed');
            return;
        }

        const newWidth = Math.min(rawWidth, layout.getBoundingClientRect().width * 0.4);
        sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });

    const toggleBtn = document.getElementById('toggleSidebarBtn');
    const closeBtn = document.getElementById('closeSidebarBtn');

    function syncResizerVisibility() {
        if (sidebar.classList.contains('collapsed')) {
            resizer.classList.add('collapsed');
        } else {
            resizer.classList.remove('collapsed');
        }
    }

    if (toggleBtn) toggleBtn.addEventListener('click', () => setTimeout(syncResizerVisibility, 350));
    if (closeBtn) closeBtn.addEventListener('click', () => setTimeout(syncResizerVisibility, 350));
}

// 自訂 Alert Modal (用於 Agent 功能中的錯誤提示)
export function showModalAlert(message) {
    const existing = document.getElementById('_agentAlertModal');
    if (existing) existing.remove();

    const el = document.createElement('div');
    el.id = '_agentAlertModal';
    el.className = 'modal-overlay';
    el.innerHTML = `
        <div class="modal" style="max-width: 340px;">
            <div class="modal-body" style="padding: 24px; text-align: center; font-size: 14px;">
                ⚠️ ${message}
            </div>
            <div class="modal-footer" style="justify-content: center;">
                <button class="btn btn-primary" id="_agentAlertOkBtn">確定</button>
            </div>
        </div>`;
    document.body.appendChild(el);
    document.getElementById('_agentAlertOkBtn').addEventListener('click', () => el.remove());
}

// --- 初始化 Agent 功能 ---
export function initAgentFeature() {
    setupAgentSidebar();
    setupResizer();
    console.log('✅ Agent 排班副駕已初始化');
}
