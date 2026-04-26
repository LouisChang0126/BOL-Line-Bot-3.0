import {
    scheduleData, serviceItems, nonUserColumns,
    saveSchedule, applyAgentStructuralChanges,
    pushHistory, updateEditDifference, updateStatus,
    getHistoryViewContext
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

    const referenceRangeSection = document.getElementById('agentReferenceRangeSection');
    const referenceRangeContent = document.getElementById('agentReferenceRangeContent');
    if (referenceRangeSection) {
        referenceRangeSection.style.display = scheduling ? '' : 'none';
    }
    if (referenceRangeContent) {
        referenceRangeContent.style.display = scheduling ? 'flex' : 'none';
    }
    if (scheduling) {
        // 進排班模式時，依當下 scheduleData 重新填下拉選項
        populateReferenceRangeDropdowns();
    }

    if (!scheduling) {
        if (rulesContent) rulesContent.style.display = 'none';
    } else {
        if (rulesContent) rulesContent.style.display = 'block';
    }

    if (csvAttachBtn) {
        csvAttachBtn.style.display = scheduling ? 'none' : '';
    }

    if (scheduling) {
        attachedCsvText = null;
        attachedCsvFileName = '';
        if (attachmentPreview) attachmentPreview.classList.add('hidden');
        if (csvInput) csvInput.value = '';
    }

    if (chatHint) {
        chatHint.textContent = scheduling
            ? '💡 有額外排班要求可填寫下方指令，沒有可直接送出。'
            : '💡 可以上傳 Excel 或 CSV 檔案作為參考資料。';
    }
}

function createWelcomeNode(mode = getSelectedMode()) {
    const wrapper = document.createElement('div');
    wrapper.className = 'agent-chat-welcome';
    wrapper.innerHTML = `
        <div class="agent-chat-welcome-icon">🤖</div>
        <p>歡迎使用 AI 助手。</p>
        <p>${mode === MODE_SCHEDULING
            ? '請填入你的排班需求，規則只會在排班模式套用。'
            : '你可以直接輸入需求，系統會協助你調整班表。'
        }</p>
        <p class="agent-chat-hint" id="agentChatHint">${mode === MODE_SCHEDULING
            ? '💡 有額外排班要求可填寫下方指令，沒有可直接送出。'
            : '💡 可以上傳 Excel 或 CSV 檔案作為參考資料。'
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

// --- 參考範圍 / 生成範圍下拉選單 ---
// 由 setupAgentSidebar 與 syncAgentModeUI 觸發 populate；listeners 只裝一次。

const REFERENCE_RANGE_IDS = ['agentReferenceStart', 'agentReferenceEnd'];
const GENERATE_RANGE_IDS = ['agentGenerateStart', 'agentGenerateEnd'];
const FUTURE_SUNDAY_COUNT = 26;  // 生成週次下拉裡多附 N 個未來週日候選，方便建立新週

// 「頻率與參考班表一致」規則的相對誤差容忍度。
// 0.50 = ±50%：例如某人在參考週次中應該排約 4 次，生成範圍內 [2.0, 6.0] 之間都算合格。
// 工程師調整這個常數即可改寬/緊。
const FREQUENCY_PARITY_TOLERANCE = 0.50;

function getFutureSundayCandidates(latestExistingDate, count = FUTURE_SUNDAY_COUNT) {
    if (!latestExistingDate || !/^\d{4}\.\d{2}\.\d{2}$/.test(latestExistingDate)) return [];
    const [y, m, d] = latestExistingDate.split('.').map(Number);
    const base = new Date(y, m - 1, d);
    const out = [];
    for (let i = 1; i <= count; i++) {
        const next = new Date(base);
        next.setDate(base.getDate() + 7 * i);
        const yy = next.getFullYear();
        const mm = String(next.getMonth() + 1).padStart(2, '0');
        const dd = String(next.getDate()).padStart(2, '0');
        out.push(`${yy}.${mm}.${dd}`);
    }
    return out;
}

function _setSelectOptions(selectId, dateValues, placeholder) {
    const el = document.getElementById(selectId);
    if (!el) return;
    const prev = el.value;
    const opts = [`<option value="">${placeholder}</option>`]
        .concat(dateValues.map(v => `<option value="${v}">${v}</option>`));
    el.innerHTML = opts.join('');
    if (prev && [...el.options].some(o => o.value === prev)) {
        el.value = prev;
    } else {
        el.value = '';
    }
}

function _isWeekNonEmpty(row) {
    return Object.entries(row).some(([k, v]) => {
        if (k === 'date' || k === '_version') return false;
        if (Array.isArray(v)) return v.length > 0;
        if (typeof v === 'string') return v.trim().length > 0;
        return false;
    });
}

function _findLastNonEmptyDate(rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
        if (_isWeekNonEmpty(rows[i])) return rows[i].date;
    }
    return null;
}

function populateReferenceRangeDropdowns() {
    const existing = [...new Set(scheduleData.map(r => r.date))].sort();
    const latest = existing[existing.length - 1] || null;
    const future = latest ? getFutureSundayCandidates(latest) : [];
    const refDates = existing;
    const genDates = [...existing, ...future];  // 生成下拉多附未來候選

    _setSelectOptions('agentReferenceStart', refDates, '起始週次');
    _setSelectOptions('agentReferenceEnd', refDates, '結束週次');
    _setSelectOptions('agentGenerateStart', genDates, '起始週次');
    _setSelectOptions('agentGenerateEnd', genDates, '結束週次');

    // 參考週次預填：第一週 → 最後一個非空白週（只在使用者尚未選擇時填）
    const refStartEl = document.getElementById('agentReferenceStart');
    const refEndEl = document.getElementById('agentReferenceEnd');
    const firstWeek = existing[0] || '';
    const lastNonEmpty = _findLastNonEmptyDate(scheduleData) || existing[existing.length - 1] || '';
    if (refStartEl && !refStartEl.value && firstWeek) refStartEl.value = firstWeek;
    if (refEndEl && !refEndEl.value && lastNonEmpty) refEndEl.value = lastNonEmpty;

    _applyRangeConstraints(...REFERENCE_RANGE_IDS);
    _applyRangeConstraints(...GENERATE_RANGE_IDS);
}

function _applyRangeConstraints(startId, endId) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    const startVal = startEl.value;
    const endVal = endEl.value;
    // 用 hidden 而非 disabled，讓不能選的日期不顯示而非灰色保留
    [...endEl.options].forEach(o => {
        o.hidden = !!(startVal && o.value && o.value < startVal);
    });
    [...startEl.options].forEach(o => {
        o.hidden = !!(endVal && o.value && o.value > endVal);
    });
}

function _wireRangePair(startId, endId) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    startEl.addEventListener('change', () => {
        // 若 start 改到比 end 還晚 → 清掉 end 避免送出無效範圍
        if (startEl.value && endEl.value && startEl.value > endEl.value) {
            endEl.value = '';
        }
        _applyRangeConstraints(startId, endId);
    });
    endEl.addEventListener('change', () => {
        if (startEl.value && endEl.value && startEl.value > endEl.value) {
            startEl.value = '';
        }
        _applyRangeConstraints(startId, endId);
    });
}

function setupReferenceRangeListeners() {
    _wireRangePair(...REFERENCE_RANGE_IDS);
    _wireRangePair(...GENERATE_RANGE_IDS);
}

// 把 [startDate ... endDate] 範圍展開成完整日期陣列（皆需在 candidates 裡）
function expandDateRange(startDate, endDate, candidates) {
    if (!startDate || !endDate) return [];
    const sorted = [...new Set(candidates)].sort();
    const s = sorted.indexOf(startDate);
    const e = sorted.indexOf(endDate);
    if (s < 0 || e < 0 || s > e) return [];
    return sorted.slice(s, e + 1);
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

    // 參考範圍收合/展開
    const refRangeToggle = document.getElementById('agentReferenceRangeToggle');
    const refRangeContent = document.getElementById('agentReferenceRangeContent');
    const refRangeIcon = document.getElementById('agentReferenceRangeIcon');
    if (refRangeToggle && refRangeContent && refRangeIcon) {
        refRangeToggle.addEventListener('click', () => {
            if (refRangeContent.style.display === 'none') {
                refRangeContent.style.display = 'flex';
                refRangeIcon.textContent = '▼';
            } else {
                refRangeContent.style.display = 'none';
                refRangeIcon.textContent = '▶';
            }
        });
    }

    // 參考範圍下拉：裝 listener（一次），populate 等資料載入後在 syncAgentModeUI 呼叫
    setupReferenceRangeListeners();

    // CSV 上傳
    const csvInput = document.getElementById('csvFileInput');
    const attachmentPreview = document.getElementById('attachmentPreview');
    const attachmentName = document.getElementById('attachmentName');
    const removeAttachmentBtn = document.getElementById('removeAttachmentBtn');

    if (csvInput) {
        csvInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const fileExt = file.name.split('.').pop().toLowerCase();

            if (fileExt === 'csv') {
                const reader = new FileReader();
                reader.onload = (event) => {
                    attachedCsvText = event.target.result;
                    attachedCsvFileName = file.name;
                    attachmentName.textContent = `📄 ${file.name}`;
                    attachmentPreview.classList.remove('hidden');
                };
                reader.readAsText(file);
            } else if (fileExt === 'xlsx' || fileExt === 'xls') {
                const reader = new FileReader();
                reader.onload = (event) => {
                    try {
                        const data = new Uint8Array(event.target.result);
                        const workbook = window.XLSX.read(data, { type: 'array' });
                        const firstSheetName = workbook.SheetNames[0];
                        const worksheet = workbook.Sheets[firstSheetName];
                        const csvText = window.XLSX.utils.sheet_to_csv(worksheet);
                        attachedCsvText = csvText;
                        attachedCsvFileName = file.name;
                        attachmentName.textContent = `📄 ${file.name}`;
                        attachmentPreview.classList.remove('hidden');
                    } catch (err) {
                        console.error("Excel 解析錯誤:", err);
                        alert("解析 Excel 檔案失敗，請檢查檔案格式是否正確。");
                    }
                };
                reader.readAsArrayBuffer(file);
            } else {
                alert("不支援的檔案格式，請上傳 Excel 或 CSV 檔案。");
            }
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

// --- 非線性進度條 ---
// 分段定義：每段 { end: 秒數, startPct, endPct }
// 預設 3 分鐘：0-60s → 0%-50%, 60-120s → 50%-80%, 120-180s → 80%-100%
const BASE_SEGMENTS = [
    { end: 60, startPct: 0, endPct: 50 },
    { end: 120, startPct: 50, endPct: 80 },
    { end: 180, startPct: 80, endPct: 100 },
];

let _progressTimer = null;
let _progressStartTime = 0;
let _progressTotalDuration = 180; // 秒
let _progressSegments = [...BASE_SEGMENTS];

function calcProgressPercent(elapsedSec) {
    const segments = _progressSegments;
    if (elapsedSec <= 0) return 0;
    if (elapsedSec >= segments[segments.length - 1].end) return 99.5; // 永遠不到 100%
    for (const seg of segments) {
        const segStart = seg === segments[0] ? 0 : segments[segments.indexOf(seg) - 1].end;
        if (elapsedSec <= seg.end) {
            const segDuration = seg.end - segStart;
            const segElapsed = elapsedSec - segStart;
            const ratio = segElapsed / segDuration;
            return seg.startPct + ratio * (seg.endPct - seg.startPct);
        }
    }
    return 99.5;
}

/** 重試時呼叫：延長總時長（從目前已過時間再加 extraSec 秒） */
export function extendProgressDuration(extraSec) {
    if (!_progressTimer) return;
    const elapsed = (Date.now() - _progressStartTime) / 1000;
    const currentPct = calcProgressPercent(elapsed);
    // 新的總時長 = 已過時間 + extraSec
    _progressTotalDuration = elapsed + extraSec;
    // 從目前百分比到 100% 重建剩餘段落
    const remaining = _progressTotalDuration - elapsed;
    const t1 = elapsed + remaining / 3;
    const t2 = elapsed + (remaining * 2) / 3;
    _progressSegments = [
        // 保留已完成的部分作為第零段（瞬間跳過）
        { end: elapsed, startPct: 0, endPct: currentPct },
        { end: t1, startPct: currentPct, endPct: currentPct + (100 - currentPct) * 0.5 },
        { end: t2, startPct: currentPct + (100 - currentPct) * 0.5, endPct: currentPct + (100 - currentPct) * 0.85 },
        { end: _progressTotalDuration, startPct: currentPct + (100 - currentPct) * 0.85, endPct: 100 },
    ];
}

function formatElapsed(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m > 0 ? `${m}分${String(s).padStart(2, '0')}秒` : `${s}秒`;
}

export function showAgentLoading(mode) {
    const chatArea = document.getElementById('agentChatArea');
    const loading = document.createElement('div');
    loading.id = 'agentLoadingIndicator';

    if (mode === MODE_SCHEDULING) {
        // 排班模式：非線性進度條
        loading.className = 'agent-loading-progress';
        loading.innerHTML = `
            <div class="agent-progress-label">🤖 AI 排班中，請稍候...</div>
            <div class="agent-progress-track">
                <div class="agent-progress-fill" id="agentProgressFill"></div>
            </div>
            <div class="agent-progress-info">
                <span class="agent-progress-pct" id="agentProgressPct">0%</span>
                <span class="agent-progress-time" id="agentProgressTime">0秒</span>
            </div>
        `;
        chatArea.appendChild(loading);
        chatArea.scrollTop = chatArea.scrollHeight;

        // 初始化進度狀態
        _progressStartTime = Date.now();
        _progressTotalDuration = 180;
        _progressSegments = [...BASE_SEGMENTS];

        // 每秒更新
        _progressTimer = setInterval(() => {
            const elapsed = (Date.now() - _progressStartTime) / 1000;
            const pct = calcProgressPercent(elapsed);
            const fill = document.getElementById('agentProgressFill');
            const pctLabel = document.getElementById('agentProgressPct');
            const timeLabel = document.getElementById('agentProgressTime');
            if (fill) fill.style.width = `${pct}%`;
            if (pctLabel) pctLabel.textContent = `${Math.floor(pct)}%`;
            if (timeLabel) timeLabel.textContent = formatElapsed(elapsed);
            chatArea.scrollTop = chatArea.scrollHeight;
        }, 1000);
    } else {
        // 編輯/問答模式：泡泡動畫
        loading.className = 'agent-loading';
        loading.innerHTML = `
            <div class="agent-loading-dot"></div>
            <div class="agent-loading-dot"></div>
            <div class="agent-loading-dot"></div>
        `;
        chatArea.appendChild(loading);
        chatArea.scrollTop = chatArea.scrollHeight;
    }
}

export function hideAgentLoading() {
    if (_progressTimer) {
        clearInterval(_progressTimer);
        _progressTimer = null;
    }
    const loading = document.getElementById('agentLoadingIndicator');
    if (loading) loading.remove();
}

function buildScheduleIndex(rows) {
    const index = new Map();
    rows.forEach(row => {
        if (row?.date) index.set(row.date, row);
    });
    return index;
}

function buildChangedCellSet(baseScheduleData, nextScheduleData, userServiceItems) {
    const changedCells = new Set();
    const baseIndex = buildScheduleIndex(baseScheduleData);
    const nextIndex = buildScheduleIndex(nextScheduleData);
    const allDates = new Set([...baseIndex.keys(), ...nextIndex.keys()]);

    allDates.forEach(date => {
        const baseRow = baseIndex.get(date) || {};
        const nextRow = nextIndex.get(date) || {};
        userServiceItems.forEach(service => {
            const baseValue = JSON.stringify(baseRow[service] || []);
            const nextValue = JSON.stringify(nextRow[service] || []);
            if (baseValue !== nextValue) {
                changedCells.add(`${date}|${service}`);
            }
        });
    });

    return changedCells;
}

function toSortedArray(setObj) {
    return Array.from(setObj || []).sort((a, b) => a.localeCompare(b));
}

function validateScopedChanges({
    baseScheduleData,
    nextScheduleData,
    serviceItems,
    nonUserColumns,
    activeRules,
    changedCells,
    referenceWeeks = [],
    generateWeeks = []
}) {
    const warnings = [];
    const validatedCellsByRule = {
        consecutive: new Set(),
        maxRoles: new Set(),
        serviceKnownPeople: new Set(),
        frequencyParity: new Set()
    };
    const userServiceItems = serviceItems.filter(s => !nonUserColumns.includes(s));
    if (!changedCells || changedCells.size === 0) {
        return {
            valid: true,
            warnings: [],
            debug: {
                changedCells: [],
                validatedCells: {
                    consecutive: [],
                    maxRoles: [],
                    serviceKnownPeople: []
                }
            }
        };
    }

    const nextIndex = buildScheduleIndex(nextScheduleData);
    const changedByDate = new Map(); // date -> Set(service)
    changedCells.forEach(key => {
        const [date, service] = key.split('|');
        if (!date || !service) return;
        if (!changedByDate.has(date)) changedByDate.set(date, new Set());
        changedByDate.get(date).add(service);
    });

    // 規則1: 禁止連續 N 週同服事（只檢查包含變更格的視窗）
    if (activeRules?.consecutive) {
        const consecutiveWeeks = Math.max(2, parseInt(activeRules?.consecutiveWeeks, 10) || 2);
        const rows = nextScheduleData;
        const dateToIndex = new Map();
        rows.forEach((row, idx) => dateToIndex.set(row.date, idx));
        const seenConsecutive = new Set();

        changedByDate.forEach((services, date) => {
            const changedIdx = dateToIndex.get(date);
            if (changedIdx === undefined) return;

            services.forEach(service => {
                if (!userServiceItems.includes(service)) return;

                const startMin = Math.max(0, changedIdx - consecutiveWeeks + 1);
                const startMax = Math.min(changedIdx, rows.length - consecutiveWeeks);
                for (let start = startMin; start <= startMax; start++) {
                    const windowRows = rows.slice(start, start + consecutiveWeeks);
                    windowRows.forEach(r => validatedCellsByRule.consecutive.add(`${r.date}|${service}`));
                    let common = new Set(windowRows[0][service] || []);

                    for (let w = 1; w < windowRows.length; w++) {
                        const currentSet = new Set(windowRows[w][service] || []);
                        common = new Set([...common].filter(name => currentSet.has(name)));
                        if (common.size === 0) break;
                    }

                    const startDate = windowRows[0].date;
                    const endDate = windowRows[windowRows.length - 1].date;
                    common.forEach(name => {
                        const dedupeKey = `${service}|${name}|${startDate}|${endDate}`;
                        if (seenConsecutive.has(dedupeKey)) return;
                        seenConsecutive.add(dedupeKey);

                        warnings.push({
                            type: 'consecutive',
                            message: `⚠️ ${name} 連續${consecutiveWeeks}週擔任「${service}」（${startDate} → ${endDate}）`,
                            date: endDate,
                            service,
                            person: name
                        });
                    });
                }
            });
        });
    }

    // 規則2: 每人每週最多 N 項（只檢查有變更的日期）
    if (activeRules?.maxRoles) {
        const maxRoles = Math.max(1, parseInt(activeRules?.maxRolesLimit, 10) || 3);
        changedByDate.forEach((_services, date) => {
            const row = nextIndex.get(date);
            if (!row) return;
            userServiceItems.forEach(service => {
                validatedCellsByRule.maxRoles.add(`${date}|${service}`);
            });

            const counts = {};
            userServiceItems.forEach(service => {
                (row[service] || []).forEach(name => {
                    counts[name] = (counts[name] || 0) + 1;
                });
            });

            Object.entries(counts).forEach(([name, count]) => {
                if (count > maxRoles) {
                    warnings.push({
                        type: 'maxRoles',
                        message: `⚠️ ${name} 在 ${date} 擔任了 ${count} 項服事（上限 ${maxRoles}）`,
                        date,
                        person: name,
                        count
                    });
                }
            });
        });
    }

    // 規則3: 只使用該服事歷史人員（只檢查變更格）
    if (activeRules?.serviceKnownPeople) {
        const allowedByService = {};
        userServiceItems.forEach(service => {
            allowedByService[service] = new Set();
        });

        baseScheduleData.forEach(row => {
            userServiceItems.forEach(service => {
                (row[service] || []).forEach(name => allowedByService[service].add(name));
            });
        });

        const seenKnownPeople = new Set();
        changedByDate.forEach((services, date) => {
            const row = nextIndex.get(date);
            if (!row) return;

            services.forEach(service => {
                if (!userServiceItems.includes(service)) return;
                validatedCellsByRule.serviceKnownPeople.add(`${date}|${service}`);
                (row[service] || []).forEach(name => {
                    if (allowedByService[service].has(name)) return;
                    const dedupeKey = `${date}|${service}|${name}`;
                    if (seenKnownPeople.has(dedupeKey)) return;
                    seenKnownPeople.add(dedupeKey);
                    warnings.push({
                        type: 'serviceKnownPeople',
                        message: `⚠️ ${name} 不在 ${service} 的歷史名單`,
                        date,
                        service,
                        person: name
                    });
                });
            });
        });
    }

    // 規則4: 服事頻率與參考班表一致（盡量；用比例誤差判斷）
    // 期望次數 = (參考週次中該人次數 / 參考週次總數) × 生成週次總數
    // 相對誤差 = |actual − expected| / expected，超過 FREQUENCY_PARITY_TOLERANCE 視為違反
    // 特例：expected = 0（該人在參考範圍內未服事）→ 不檢查（新加入的人允許自由排）
    if (activeRules?.frequencyParity && referenceWeeks.length > 0 && generateWeeks.length > 0) {
        const refSet = new Set(referenceWeeks);
        const genSet = new Set(generateWeeks);

        const countByName = (rows, dateSet) => {
            const counts = new Map();
            rows.forEach(row => {
                if (!dateSet.has(row.date)) return;
                userServiceItems.forEach(service => {
                    (row[service] || []).forEach(name => {
                        counts.set(name, (counts.get(name) || 0) + 1);
                    });
                });
            });
            return counts;
        };

        const refCounts = countByName(baseScheduleData, refSet);
        const genCounts = countByName(nextScheduleData, genSet);

        const refLen = referenceWeeks.length;
        const genLen = generateWeeks.length;
        const allNames = new Set([...refCounts.keys(), ...genCounts.keys()]);

        // 標記：所有生成週次的所有服事格皆視為「被驗證過」（這個規則是全局性的）
        generateWeeks.forEach(date => {
            userServiceItems.forEach(service => {
                validatedCellsByRule.frequencyParity.add(`${date}|${service}`);
            });
        });

        const tolPct = Math.round(FREQUENCY_PARITY_TOLERANCE * 100);
        const seenParityWarnings = new Set();
        for (const name of allNames) {
            const refC = refCounts.get(name) || 0;
            const genC = genCounts.get(name) || 0;
            const expected = (refC / refLen) * genLen;
            if (expected <= 0) continue;  // 該人在參考範圍內沒服事 → 不限制
            const relDiff = Math.abs(genC - expected) / expected;
            if (relDiff > FREQUENCY_PARITY_TOLERANCE) {
                if (seenParityWarnings.has(name)) continue;
                seenParityWarnings.add(name);
                warnings.push({
                    type: 'frequencyParity',
                    message: `⚠️ ${name} 服事頻率偏離參考（參考 ${refC}/${refLen} 週 → 生成 ${genC}/${genLen} 週，期望約 ${expected.toFixed(1)}，誤差 ${(relDiff * 100).toFixed(0)}% 超過 ${tolPct}%）`,
                    person: name,
                    refCount: refC,
                    genCount: genC,
                    expected: expected
                });
            }
        }
    }

    return {
        valid: warnings.length === 0,
        warnings,
        debug: {
            changedCells: toSortedArray(changedCells),
            validatedCells: {
                consecutive: toSortedArray(validatedCellsByRule.consecutive),
                maxRoles: toSortedArray(validatedCellsByRule.maxRoles),
                serviceKnownPeople: toSortedArray(validatedCellsByRule.serviceKnownPeople),
                frequencyParity: toSortedArray(validatedCellsByRule.frequencyParity)
            }
        }
    };
}

// --- API 呼叫 ---
export async function sendAgentRequest() {
    const promptInput = document.getElementById('agentPromptInput');
    const promptRaw = promptInput.value.trim();
    if (agentIsLoading) return;

    if (!AGENT_API_URL) {
        addChatMessage('未設定 Agent API URL，請先檢查 firebase-config.js。', 'error');
        return;
    }

    const selectedMode = getSelectedMode();
    const scheduling = selectedMode === MODE_SCHEDULING;
    // 排班模式 prompt 為「額外指令」，非必填；空時用最小指令當 user_request 內容
    // 其他模式 prompt 仍必填
    const prompt = promptRaw || (scheduling ? '請依參考範圍與規則排班' : '');
    if (!prompt) return;
    const csvTextToSend = (!scheduling && attachedCsvText) ? attachedCsvText : '';
    const csvFileNameToSend = attachedCsvFileName || 'uploaded.csv';
    if (csvTextToSend) {
        addChatMessage(`[附件] ${csvFileNameToSend}`, 'user', { mode: selectedMode });
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
            serviceKnownPeople: document.getElementById('ruleServiceKnownPeople')?.checked ?? true,
            frequencyParity: document.getElementById('ruleFrequencyParity')?.checked ?? false
        }
        : {};

    // --- 參考範圍：必填欄位（從下拉選單讀起訖日期再展開） ---
    const readSel = (id) => (scheduling ? document.getElementById(id)?.value || '' : '');
    const refStart = readSel('agentReferenceStart');
    const refEnd = readSel('agentReferenceEnd');
    const genStart = readSel('agentGenerateStart');
    const genEnd = readSel('agentGenerateEnd');

    // 候選池：reference 只允許既有；generate 允許既有 + 未來週日候選
    const _existingDates = scheduleData.map(r => r.date);
    const _latestExisting = [..._existingDates].sort().pop() || null;
    const _futureCandidates = _latestExisting ? getFutureSundayCandidates(_latestExisting) : [];

    if (scheduling) {
        if (!refStart || !refEnd) {
            addChatMessage('❌ 請選擇「參考週次」的起始與結束', 'error', { mode: selectedMode });
            return;
        }
        if (!genStart || !genEnd) {
            addChatMessage('❌ 請選擇「生成週次」的起始與結束', 'error', { mode: selectedMode });
            return;
        }
    }

    const referenceWeeks = expandDateRange(refStart, refEnd, _existingDates);
    const generateWeeks = expandDateRange(genStart, genEnd, [..._existingDates, ..._futureCandidates]);

    // 生成週次：如果有不存在的，先在前端 + Firestore 建空週次後才打 API
    if (generateWeeks.length > 0) {
        const existingDates = new Set(scheduleData.map(r => r.date));
        const missing = generateWeeks.filter(d => !existingDates.has(d)).sort();
        if (missing.length > 0) {
            updateStatus(`新增 ${missing.length} 個週次中...`);
            try {
                for (const dateStr of missing) {
                    const blank = {};
                    serviceItems.forEach(item => { blank[item] = []; });
                    scheduleData.push({ date: dateStr, ...blank, _version: 0 });
                    await saveSchedule(dateStr, blank);
                }
                scheduleData.sort((a, b) => a.date.localeCompare(b.date));
                pushHistory();
                updateEditDifference('ai');
                renderTable();
                populateReferenceRangeDropdowns();  // 新週次加入後同步重填下拉
                addChatMessage(`✅ 已自動新增 ${missing.length} 個週次：${missing.join(', ')}`, 'assistant', { mode: selectedMode });
            } catch (err) {
                addChatMessage(`❌ 新增週次失敗：${err.message}`, 'error', { mode: selectedMode });
                updateStatus('就緒');
                return;
            }
            updateStatus('就緒');
        }
    }

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
    // 剝除內部 metadata（_version 是樂觀鎖用，不該給 LLM 看見否則會被當作欄位回填）
    let effectiveScheduleData = JSON.parse(JSON.stringify(scheduleData)).map(row => {
        const { _version, ...rest } = row;
        return rest;
    });
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

    const historyViewContext = getHistoryViewContext();

    // 如果有歷史資料，直接把它接在 effectiveScheduleData 的最前面
    if (historyViewContext.showingPast && historyViewContext.pastData && historyViewContext.pastData.length > 0) {
        effectiveScheduleData = [...historyViewContext.pastData, ...effectiveScheduleData];
    }

    // referenceWeeks 非空時，只把指定週次送給 LLM
    const scheduleToSend = referenceWeeks.length > 0
        ? effectiveScheduleData.filter(r => referenceWeeks.includes(r.date))
        : effectiveScheduleData;

    const payload = {
        prompt,
        currentSchedule: JSON.stringify({ scheduleData: scheduleToSend, serviceItems, nonUserColumns }),
        selectedMode,
        activeRules,
        chatHistory
    };

    if (csvTextToSend) payload.attachedCsvText = csvTextToSend;

    // 生成週次非空：通知後端限縮輸出範圍並 suppress addWeeks/removeWeeks tool 欄位
    if (generateWeeks.length > 0) {
        payload.generateWeeks = generateWeeks;
        payload.suppressStructural = true;
    }

    agentIsLoading = true;
    document.getElementById('agentSendBtn').disabled = true;
    showAgentLoading(selectedMode);

    let retryCount = 0;
    const MAX_RETRIES = 1;
    let apiErrorRetryCount = 0;
    const MAX_API_ERROR_RETRIES = 1;
    let lastResult = null;

    // Prompt Engineering 實驗：排班模式才會被後端落檔。
    // 同一個 sendAgentRequest 裡每次 fetch 共用 experimentStartTime，retry 計數隨迴圈累加。
    const pad2 = n => String(n).padStart(2, '0');
    const _now = new Date();
    const experimentStartTime = `${_now.getFullYear()}-${pad2(_now.getMonth() + 1)}-${pad2(_now.getDate())}_${pad2(_now.getHours())}-${pad2(_now.getMinutes())}-${pad2(_now.getSeconds())}`;

    while (retryCount <= MAX_RETRIES) {
        try {
            const experimentRetryCount = retryCount + apiErrorRetryCount;
            const experimentFields = scheduling
                ? { experimentStartTime, experimentRetryCount }
                : {};
            const response = await fetch(AGENT_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(retryCount > 0 ? {
                    ...payload,
                    ...experimentFields,
                    prompt: `${prompt}\n\n[系統提示] 上次產生的班表違反規則，請修正：\n${lastResult.warnings.map(w => w.message).join('\n')}`
                } : { ...payload, ...experimentFields })
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

            const userServiceItems = serviceItems.filter(s => !nonUserColumns.includes(s));
            const changedCells = buildChangedCellSet(effectiveScheduleData, result.scheduleData, userServiceItems);
            const validation = validateScopedChanges({
                baseScheduleData: effectiveScheduleData,
                nextScheduleData: result.scheduleData,
                serviceItems,
                nonUserColumns,
                activeRules,
                changedCells,
                referenceWeeks,
                generateWeeks
            });

            if (!validation.valid && retryCount < MAX_RETRIES) {
                lastResult = validation;
                retryCount++;
                extendProgressDuration(180); // 規則違反重試：再延長 3 分鐘
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

            // 若啟用「生成週次」限縮，多一層前端護欄：LLM 多回的日期直接丟棄
            let nextScheduleData = result.scheduleData;
            if (generateWeeks.length > 0) {
                const allowed = new Set(generateWeeks);
                nextScheduleData = nextScheduleData.filter(r => allowed.has(r.date));
            }

            // 最後才計算內容差異，此時 scheduleData 已經是擴充後的狀態
            setPendingChanges(nextScheduleData);

            break;

        } catch (error) {
            const status = Number(error?.status || 0);
            const message = String(error?.message || '');
            const isRetryableApiError = [502, 503, 504].includes(status) ||
                /Claude API error: Error code: 500|Internal server error/i.test(message);

            if (isRetryableApiError && apiErrorRetryCount < MAX_API_ERROR_RETRIES) {
                apiErrorRetryCount++;
                extendProgressDuration(120); // 連線錯誤重試：再延長 2 分鐘
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
        updateEditDifference('ai');

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
        updateEditDifference('ai');

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
}
