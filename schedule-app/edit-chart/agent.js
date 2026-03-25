import {
    scheduleData, serviceItems, nonUserColumns,
    saveSchedule, applyAgentStructuralChanges,
    pushHistory, updateEditDifference, updateStatus
} from './app.js';

import { renderTable } from './ui.js';

// ===========================
// Agent 排班副駕功能
// ===========================

// --- Agent 狀態 ---
export let pendingAgentChanges = null;
let attachedCsvText = null;
let attachedCsvFileName = '';
let agentIsLoading = false;

// Cloud Function URL（從 firebase-config.js 載入）
const AGENT_API_URL = window.AGENT_API_URL || '';

const MODE_EDIT_QA = 'edit_qa';
const MODE_SCHEDULING = 'scheduling';

const modeChatHistory = {
    [MODE_EDIT_QA]: [],
    [MODE_SCHEDULING]: []
};

function getSelectedMode() {
    return document.getElementById('modeSelect')?.value || MODE_EDIT_QA;
}

function getModeHistory(mode = getSelectedMode()) {
    if (!modeChatHistory[mode]) {
        modeChatHistory[mode] = [];
    }
    return modeChatHistory[mode];
}

function isSchedulingMode() {
    return getSelectedMode() === MODE_SCHEDULING;
}

function syncAgentModeUI() {
    const scheduling = isSchedulingMode();
    const rulesSection = document.getElementById('agentRulesSection');
    const rulesContent = document.getElementById('agentRulesContent');
    const csvAttachBtn = document.getElementById('csvAttachBtn');
    const attachmentPreview = document.getElementById('attachmentPreview');
    const csvInput = document.getElementById('csvFileInput');
    const chatHint = document.getElementById('agentChatHint');

    if (rulesSection) {
        rulesSection.style.display = scheduling ? '' : 'none';
    }

    if (!scheduling) {
        if (rulesContent) rulesContent.style.display = 'none';
    } else {
        if (rulesContent) rulesContent.style.display = 'block';
    }

    if (csvAttachBtn) {
        csvAttachBtn.style.display = scheduling ? 'none' : '';
    }

    if (chatHint) {
        chatHint.textContent = scheduling
            ? '💡 請描述你的排班需求，規則只會在排班模式套用。'
            : '💡 你可以上傳 CSV 檔案作為排班參考資料。';
    }

    if (scheduling) {
        attachedCsvText = null;
        attachedCsvFileName = '';
        if (attachmentPreview) attachmentPreview.classList.add('hidden');
        if (csvInput) csvInput.value = '';
    }

    if (chatHint) {
        chatHint.textContent = scheduling
            ? '💡 請描述你的排班需求，規則只會在排班模式套用。'
            : '💡 你可以上傳 CSV 檔案作為參考資料。';
    }
}

function createWelcomeNode(mode = getSelectedMode()) {
    const wrapper = document.createElement('div');
    wrapper.className = 'agent-chat-welcome';
    wrapper.innerHTML = `
        <div class="agent-chat-welcome-icon">🤖</div>
        <p>歡迎使用 AI 助手。</p>
        <p>你可以直接輸入需求，系統會協助你調整排班。</p>
        <p class="agent-chat-hint" id="agentChatHint">${mode === MODE_SCHEDULING
            ? '💡 請描述你的排班需求，規則只會在排班模式套用。'
            : '💡 你可以上傳 CSV 檔案作為參考資料。'
        }</p>
    `;
    return wrapper;
}

function renderChatHistory(mode = getSelectedMode()) {
    const chatArea = document.getElementById('agentChatArea');
    if (!chatArea) return;

    chatArea.innerHTML = '';
    const history = getModeHistory(mode);
    if (!history.length) {
        chatArea.appendChild(createWelcomeNode(mode));
        return;
    }

    history.forEach(({ content, role }) => appendChatMessageNode(content, role));
}

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
    const modeSelect = document.getElementById('modeSelect');

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

    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            renderChatHistory(getSelectedMode());
            syncAgentModeUI();
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
                attachedCsvFileName = file.name;
                attachmentName.textContent = `📄 ${file.name}`;
                attachmentPreview.classList.remove('hidden');
            };
            reader.readAsText(file);
        });
    }

    if (removeAttachmentBtn) {
        removeAttachmentBtn.addEventListener('click', () => {
            attachedCsvText = null;
            attachedCsvFileName = '';
            attachmentPreview.classList.add('hidden');
            csvInput.value = '';
        });
    }

    renderChatHistory(getSelectedMode());
    syncAgentModeUI();

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
function escapeHtml(text = '') {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatInlineMarkdown(text = '') {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

function parseTableRow(line = '') {
    let row = line.trim();
    if (row.startsWith('|')) row = row.slice(1);
    if (row.endsWith('|')) row = row.slice(0, -1);
    return row.split('|').map(cell => cell.trim());
}

function isMarkdownTableSeparator(line = '') {
    const t = line.trim();
    return /^[:\-|\s]+$/.test(t) && t.includes('-');
}

function markdownToHtml(text = '') {
    const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const html = [];

    for (let i = 0; i < lines.length; i++) {
        const current = lines[i];
        const next = i + 1 < lines.length ? lines[i + 1] : '';

        if (current.includes('|') && isMarkdownTableSeparator(next)) {
            const headers = parseTableRow(current);
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(parseTableRow(lines[i]));
                i++;
            }
            i--;

            const thead = `<thead><tr>${headers.map(h => `<th>${formatInlineMarkdown(h)}</th>`).join('')}</tr></thead>`;
            const tbody = `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${formatInlineMarkdown(c)}</td>`).join('')}</tr>`).join('')}</tbody>`;
            html.push(`<table class="agent-msg-table">${thead}${tbody}</table>`);
            continue;
        }

        if (current.trim() === '') {
            html.push('<div class="agent-msg-break"></div>');
            continue;
        }

        html.push(`<div>${formatInlineMarkdown(current)}</div>`);
    }

    return html.join('');
}

function appendChatMessageNode(text, role) {
    const chatArea = document.getElementById('agentChatArea');
    if (!chatArea) return;
    const welcome = chatArea.querySelector('.agent-chat-welcome');
    if (welcome) welcome.remove();

    const msg = document.createElement('div');
    msg.className = `agent-msg ${role}`;
    if (role === 'assistant') {
        msg.innerHTML = markdownToHtml(text);
    } else {
        msg.textContent = text;
    }
    chatArea.appendChild(msg);
    chatArea.scrollTop = chatArea.scrollHeight;
}

export function addChatMessage(text, role = 'user', options = {}) {
    const mode = options.mode || getSelectedMode();
    if (options.persist !== false) {
        getModeHistory(mode).push({ role, content: text });
    }
    if (mode === getSelectedMode()) {
        appendChatMessageNode(text, role);
    }
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
                warnings.push(...rule.checkFn(scheduleData, userServiceItems, activeRules));
            }
        }
        return { valid: warnings.length === 0, warnings };
    }
}

const scheduleValidator = new ScheduleValidator();

// 規則1: 連續兩週相同服事
scheduleValidator.addRule('consecutive', (scheduleData, userServiceItems, activeRules) => {
    const warnings = [];
    const consecutiveWeeks = Math.max(2, parseInt(activeRules?.consecutiveWeeks, 10) || 2);
    if (scheduleData.length < consecutiveWeeks) return warnings;

    for (let i = consecutiveWeeks - 1; i < scheduleData.length; i++) {
        const windowRows = scheduleData.slice(i - consecutiveWeeks + 1, i + 1);
        const startDate = windowRows[0].date;
        const endDate = windowRows[windowRows.length - 1].date;

        userServiceItems.forEach(service => {
            let common = new Set(windowRows[0][service] || []);
            for (let w = 1; w < windowRows.length; w++) {
                const currentSet = new Set(windowRows[w][service] || []);
                common = new Set([...common].filter(name => currentSet.has(name)));
                if (common.size === 0) break;
            }

            common.forEach(name => {
                warnings.push({
                    type: 'consecutive',
                    message: `⚠️ ${name} 連續${consecutiveWeeks}週擔任「${service}」（${startDate} → ${endDate}）`,
                    date: endDate,
                    service,
                    person: name
                });
            });
        });
    }

    return warnings;
});

// 規則2: 單週最多 N 項服事
scheduleValidator.addRule('maxRoles', (scheduleData, userServiceItems, activeRules) => {
    const MAX_ROLES = Math.max(1, parseInt(activeRules?.maxRolesLimit, 10) || 3);
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

// 規則3: 僅使用該服事歷史人員
scheduleValidator.addRule('serviceKnownPeople', (nextScheduleData, userServiceItems) => {
    const warnings = [];
    const allowedByService = {};
    userServiceItems.forEach(service => {
        allowedByService[service] = new Set();
    });

    scheduleData.forEach(row => {
        userServiceItems.forEach(service => {
            (row[service] || []).forEach(name => allowedByService[service].add(name));
        });
    });

    nextScheduleData.forEach(row => {
        userServiceItems.forEach(service => {
            (row[service] || []).forEach(name => {
                if (!allowedByService[service].has(name)) {
                    warnings.push({
                        type: 'serviceKnownPeople',
                        message: `⚠️ ${name} 不在 ${service} 的歷史名單`,
                        date: row.date,
                        service,
                        person: name
                    });
                }
            });
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

    const selectedMode = getSelectedMode();
    const scheduling = selectedMode === MODE_SCHEDULING;
    const csvTextToSend = (!scheduling && attachedCsvText) ? attachedCsvText : '';
    const csvFileNameToSend = attachedCsvFileName || 'uploaded.csv';
    if (csvTextToSend) {
        addChatMessage(`[CSV] ${csvFileNameToSend}`, 'user', { mode: selectedMode });
        attachedCsvText = null;
        attachedCsvFileName = '';
        const attachmentPreview = document.getElementById('attachmentPreview');
        const csvInput = document.getElementById('csvFileInput');
        if (attachmentPreview) attachmentPreview.classList.add('hidden');
        if (csvInput) csvInput.value = '';
    }

    addChatMessage(prompt, 'user', { mode: selectedMode });
    promptInput.value = '';
    promptInput.style.height = 'auto';

    const activeRules = scheduling
        ? {
            consecutive: document.getElementById('ruleConsecutive')?.checked ?? false,
            consecutiveWeeks: Math.max(2, parseInt(document.getElementById('ruleConsecutiveWeeks')?.value, 10) || 2),
            maxRoles: document.getElementById('ruleMaxRoles')?.checked ?? false,
            maxRolesLimit: Math.max(1, parseInt(document.getElementById('ruleMaxRolesLimit')?.value, 10) || 2),
            serviceKnownPeople: document.getElementById('ruleServiceKnownPeople')?.checked ?? true
        }
        : {};

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
        selectedMode,
        activeRules,
        chatHistory
    };

    if (csvTextToSend) payload.attachedCsvText = csvTextToSend;

    agentIsLoading = true;
    document.getElementById('agentSendBtn').disabled = true;
    showAgentLoading();

    let retryCount = 0;
    const MAX_RETRIES = 2;
    let apiErrorRetryCount = 0;
    const MAX_API_ERROR_RETRIES = 1;
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
                const apiError = new Error(`API 錯誤 (${response.status}): ${errorText}`);
                apiError.status = response.status;
                throw apiError;
            }

            const result = await response.json();

            // 問答型回覆（不含排班變更）直接顯示，不進入驗證/套用流程
            if (result.answerOnly || result.mode === 'answer_only' || !Array.isArray(result.scheduleData)) {
                hideAgentLoading();
                addChatMessage(result.answer || result.explanation || '已收到回覆。', 'assistant', { mode: selectedMode });
                break;
            }

            const validation = scheduleValidator.validate(result.scheduleData, serviceItems, nonUserColumns, activeRules);

            if (!validation.valid && retryCount < MAX_RETRIES) {
                lastResult = validation;
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }

            hideAgentLoading();

            if (!validation.valid) {
                // 如果有警告，優先顯示警告資訊
                addChatMessage((result.explanation || '已產生排班建議') + `（但有 ${validation.warnings.length} 項規則警告）`, 'assistant', { mode: selectedMode });
                validation.warnings.forEach(w => addChatMessage(w.message, 'error', { mode: selectedMode }));
            } else {
                // 有 explanation 就顯示 explanation，否則顯示預設字眼
                addChatMessage(result.explanation || '已產生排班建議，請檢視表格中的變更。', 'assistant', { mode: selectedMode });
            }

            // --- 處理結構變更 (Structural Changes) ---
            // 必須先處理結構變更，表格中有了對應的日期列/服事欄後，setPendingChanges 才能正確比對出差異

            await applyAgentStructuralChanges({
                addWeeks: result.addWeeks || 0,
                removeWeeks: result.removeWeeks || 0,
                addServiceColumns: result.addServiceColumns || [],
                removeServiceColumns: result.removeServiceColumns || []
            });

            // 最後才計算內容差異，此時 scheduleData 已經是擴充後的狀態
            setPendingChanges(result.scheduleData);

            break;

        } catch (error) {
            const status = Number(error?.status || 0);
            const message = String(error?.message || '');
            const isRetryableApiError = [502, 503, 504].includes(status) ||
                /Claude API error: Error code: 500|Internal server error/i.test(message);

            if (isRetryableApiError && apiErrorRetryCount < MAX_API_ERROR_RETRIES) {
                apiErrorRetryCount++;
                addChatMessage('伺服器暫時忙碌，正在自動重試一次...', 'assistant', {
                    mode: selectedMode,
                    persist: false
                });
                await new Promise(resolve => setTimeout(resolve, 1200 * apiErrorRetryCount));
                continue;
            }

            hideAgentLoading();
            console.error('Agent API 呼叫失敗:', error);
            addChatMessage(`❌ 發生錯誤：${error.message}`, 'error', { mode: selectedMode });
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
export async function acceptCellChange(date, service) {
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
}

// Reject 單格
export function rejectCellChange(date, service) {
    if (!pendingAgentChanges || !pendingAgentChanges[date] || !pendingAgentChanges[date][service]) return;

    delete pendingAgentChanges[date][service];
    if (Object.keys(pendingAgentChanges[date]).length === 0) delete pendingAgentChanges[date];

    checkPendingComplete();
    renderTable();
}

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
