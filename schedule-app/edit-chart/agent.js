import {
    scheduleData, serviceItems, nonUserColumns, allPersonNames,
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

function isThinkingEnabled() {
    return !!document.getElementById('thinkingToggle')?.checked;
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
    const leaveSection = document.getElementById('agentLeaveSection');
    if (leaveSection) {
        leaveSection.style.display = scheduling ? '' : 'none';
    }

    if (scheduling) {
        // 進排班模式時，依當下 scheduleData 重新填下拉選項與請假區域
        populateReferenceRangeDropdowns();
        rebuildLeaveRows();
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
const MAX_GENERATE_WEEKS = 13;   // 生成週次（end - start）最多 13 週

function _weekDiff(a, b) {
    if (!a || !b) return 0;
    const m = /^(\d{4})\.(\d{2})\.(\d{2})$/;
    const ma = m.exec(a); const mb = m.exec(b);
    if (!ma || !mb) return 0;
    const ta = new Date(+ma[1], +ma[2] - 1, +ma[3]).getTime();
    const tb = new Date(+mb[1], +mb[2] - 1, +mb[3]).getTime();
    return Math.round((tb - ta) / (7 * 24 * 3600 * 1000));
}

// 「頻率與參考班表一致」規則的相對誤差容忍度。
// 0.50 = ±50%：例如某人在參考週次中應該排約 4 次，生成範圍內 [2.0, 6.0] 之間都算合格。
// 工程師調整這個常數即可改寬/緊。
const FREQUENCY_PARITY_TOLERANCE = 0.50;

// 請假區域：每列一筆 {person, dates: []}。person 用搜尋型 input + datalist，dates 是多選週次。
// 預設一列空白。送出前 pivot 成 {date: [persons]} 給後端 leaveByDate。
let _leaveRows = [{ person: '', dates: [] }];

// =====================================================
// 實驗：把人員名稱匿名化成預設英文池後再送給 LLM
// =====================================================
// True  → 排班模式送 LLM 前，把 currentSchedule / leaveByDate / prompt / warning
//         內所有中文人名替換成 ENGLISH_NAMES 內的英文，response 解回來再 reverse-map 回原始中文。
//         服事名稱保留中文（讓 LLM 看得到 schema 上下文，不會誤把欄位 key 當人名）。
// False → 沿用原本中文流程。
const USE_ANONYMIZATION = false;

// 常見且省 token 的英文名（多數英文 tokenizer 一個 token就能 cover）
const ENGLISH_NAMES = [
    // 男 50
    "Adam", "Andrew", "Ben", "Bill", "Bob", "Brad", "Brian", "Chris",
    "Daniel", "David", "Dennis", "Donald", "Edward", "Eric", "Frank", "Gary",
    "George", "Greg", "Jack", "Jacob", "James", "Jason", "Jerry", "Joe",
    "John", "Joseph", "Joshua", "Justin", "Kevin", "Lee", "Mark", "Matthew",
    "Michael", "Mike", "Paul", "Pete", "Richard", "Robert", "Ronald", "Ryan",
    "Sam", "Samuel", "Scott", "Sean", "Steven", "Thomas", "Tim", "Tom",
    "Tony", "William",
    // 女 50
    "Alice", "Amy", "Anna", "Anne", "Beth", "Betty", "Brenda", "Carol",
    "Diana", "Donna", "Ellen", "Emily", "Emma", "Erin", "Eve", "Grace",
    "Hannah", "Helen", "Iris", "Ivy", "Jane", "Janet", "Joan", "Julia",
    "Karen", "Kate", "Kim", "Laura", "Lily", "Linda", "Lisa", "Maria",
    "Mary", "Megan", "Mia", "Nancy", "Nicole", "Olivia", "Pam", "Rachel",
    "Rose", "Ruth", "Sandra", "Sarah", "Sophia", "Sue", "Susan", "Tina",
    "Tracy", "Wendy"
];  // 100

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
        if (k === 'date') return false;
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

    // 參考週次：若已 fetch 過歷史資料，把它的日期也加入候選（讓使用者能參考過去班表）
    const historyCtx = getHistoryViewContext();
    const pastDates = (historyCtx && Array.isArray(historyCtx.pastData))
        ? historyCtx.pastData.map(r => r.date) : [];
    const refDates = [...new Set([...pastDates, ...existing])].sort();
    const genDates = [...existing, ...future];  // 生成下拉多附未來候選（不含歷史）

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

    // 若先前狀態 start/end 距離 > MAX_GENERATE_WEEKS，先把 end 清掉，避免畫面殘留無效範圍
    const genStartEl = document.getElementById('agentGenerateStart');
    const genEndEl = document.getElementById('agentGenerateEnd');
    if (genStartEl && genEndEl && genStartEl.value && genEndEl.value
        && _weekDiff(genStartEl.value, genEndEl.value) > MAX_GENERATE_WEEKS) {
        genEndEl.value = '';
    }

    _applyRangeConstraints(...REFERENCE_RANGE_IDS);
    _applyRangeConstraints(...GENERATE_RANGE_IDS, MAX_GENERATE_WEEKS);
}

function _applyRangeConstraints(startId, endId, maxWeeks = 0) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    const startVal = startEl.value;
    const endVal = endEl.value;
    // 用 hidden 而非 disabled，讓不能選的日期不顯示而非灰色保留
    [...endEl.options].forEach(o => {
        if (!o.value) { o.hidden = false; return; }
        const tooEarly = !!(startVal && o.value < startVal);
        const tooFar = !!(maxWeeks > 0 && startVal && _weekDiff(startVal, o.value) > maxWeeks);
        o.hidden = tooEarly || tooFar;
    });
    [...startEl.options].forEach(o => {
        if (!o.value) { o.hidden = false; return; }
        const tooLate = !!(endVal && o.value > endVal);
        const tooFar = !!(maxWeeks > 0 && endVal && _weekDiff(o.value, endVal) > maxWeeks);
        o.hidden = tooLate || tooFar;
    });
}

function _wireRangePair(startId, endId, onChange, maxWeeks = 0) {
    const startEl = document.getElementById(startId);
    const endEl = document.getElementById(endId);
    if (!startEl || !endEl) return;
    const fire = () => {
        _applyRangeConstraints(startId, endId, maxWeeks);
        if (typeof onChange === 'function') onChange();
    };
    startEl.addEventListener('change', () => {
        // 若 start 改到比 end 還晚 → 清掉 end 避免送出無效範圍
        if (startEl.value && endEl.value && startEl.value > endEl.value) {
            endEl.value = '';
        }
        // 超過最大週數上限 → 清掉 end，強迫使用者重選
        if (maxWeeks > 0 && startEl.value && endEl.value
            && _weekDiff(startEl.value, endEl.value) > maxWeeks) {
            endEl.value = '';
        }
        fire();
    });
    endEl.addEventListener('change', () => {
        if (startEl.value && endEl.value && startEl.value > endEl.value) {
            startEl.value = '';
        }
        if (maxWeeks > 0 && startEl.value && endEl.value
            && _weekDiff(startEl.value, endEl.value) > maxWeeks) {
            startEl.value = '';
        }
        fire();
    });
}

function setupReferenceRangeListeners() {
    _wireRangePair(...REFERENCE_RANGE_IDS);
    _wireRangePair(...GENERATE_RANGE_IDS, () => rebuildLeaveRows(), MAX_GENERATE_WEEKS);
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

// 計算「禁止連續 N 週同服事」需要 LLM 看見的相鄰 boundary 週次。
// 若生成週次的第一週 = 7/5、N=2，則 6/28（在現有 scheduleData 中）需被當 read-only context 送進去。
// 同理向後 (n-1) 週也檢查（以防 LLM 動 7/5 但 7/12 已是某人 → 仍可違反）。
// 回傳的日期一定要在 schedRows 中存在（沒資料就無從比對）。
function _computeConsecutiveContextDates(generateWeeks, n, schedRows) {
    if (!Array.isArray(generateWeeks) || generateWeeks.length === 0) return [];
    const N = Math.max(0, parseInt(n, 10) || 0);
    if (N <= 1) return [];
    const allDates = (schedRows || []).map(r => r.date).filter(Boolean).sort();
    const genSet = new Set(generateWeeks);
    const sortedGen = [...generateWeeks].sort();
    const firstGen = sortedGen[0];
    const lastGen = sortedGen[sortedGen.length - 1];
    const firstIdx = allDates.indexOf(firstGen);
    const lastIdx = allDates.indexOf(lastGen);
    const out = new Set();
    // 前 N-1 週
    if (firstIdx > 0) {
        for (let i = 1; i <= N - 1; i++) {
            const idx = firstIdx - i;
            if (idx < 0) break;
            const d = allDates[idx];
            if (!genSet.has(d)) out.add(d);
        }
    }
    // 後 N-1 週
    if (lastIdx >= 0 && lastIdx < allDates.length - 1) {
        for (let i = 1; i <= N - 1; i++) {
            const idx = lastIdx + i;
            if (idx >= allDates.length) break;
            const d = allDates[idx];
            if (!genSet.has(d)) out.add(d);
        }
    }
    return [...out].sort();
}

// --- 匿名化 helpers（USE_ANONYMIZATION 為 true 時啟用） ---

// 從 schedule + leave 收集所有出現過的人名
function _collectAllPersons(scheduleData, leaveByDate) {
    const set = new Set();
    (scheduleData || []).forEach(row => {
        Object.entries(row).forEach(([k, v]) => {
            if (k === 'date') return;
            if (Array.isArray(v)) v.forEach(n => {
                if (typeof n === 'string' && n.trim()) set.add(n);
            });
        });
    });
    Object.values(leaveByDate || {}).forEach(arr => {
        (arr || []).forEach(n => {
            if (typeof n === 'string' && n.trim()) set.add(n);
        });
    });
    return [...set];
}

// 建立 person ↔ english 的雙向 map。排序後按 index 配池避免隨機性。
// extraPersons：把 allPersonNames 等「全域」人名也納入，避免 user_request 提到 referenceWeeks
// 範圍外的人名而沒被翻譯。
function _buildAnonMap(scheduleData, leaveByDate, extraPersons = []) {
    const localPersons = _collectAllPersons(scheduleData, leaveByDate);
    const extras = (extraPersons || []).filter(n => typeof n === 'string' && n.trim());
    const persons = [...new Set([...localPersons, ...extras])].sort();
    if (persons.length > ENGLISH_NAMES.length) {
        throw new Error(`人員數 (${persons.length}) 超過匿名池容量 (${ENGLISH_NAMES.length})`);
    }
    const personMap = new Map();
    const reversePerson = new Map();
    persons.forEach((p, i) => {
        personMap.set(p, ENGLISH_NAMES[i]);
        reversePerson.set(ENGLISH_NAMES[i], p);
    });
    return { personMap, reversePerson };
}

// 對自由文字（prompt / warning）做 longest-first 字串替換
function _anonText(text, maps) {
    if (!text || !maps) return text;
    const pairs = [...maps.personMap.entries()]
        .filter(([k]) => k && String(k).length > 0)
        .sort((a, b) => String(b[0]).length - String(a[0]).length);
    let out = String(text);
    for (const [from, to] of pairs) {
        out = out.split(from).join(to);
    }
    return out;
}

// 反向：把 LLM 回應內的英文人名還原成中文
function _deanonText(text, maps) {
    if (!text || !maps) return text;
    const pairs = [...maps.reversePerson.entries()]
        .filter(([k]) => k && String(k).length > 0)
        .sort((a, b) => String(b[0]).length - String(a[0]).length);
    let out = String(text);
    for (const [from, to] of pairs) {
        out = out.split(from).join(to);
    }
    return out;
}

// 把前端要送 LLM 的 currentSchedule JSON 字串，把 cell 內人名替換成英文（服事名 key 維持中文）
function _anonymizeCurrentSchedule(currentScheduleStr, maps) {
    let parsed;
    try { parsed = JSON.parse(currentScheduleStr); } catch (_) { return currentScheduleStr; }
    const sd = (parsed.scheduleData || []).map(row => {
        const newRow = { date: row.date };
        Object.entries(row).forEach(([k, v]) => {
            if (k === 'date') return;
            if (Array.isArray(v)) {
                newRow[k] = v.map(n => maps.personMap.get(n) || n);
            } else {
                newRow[k] = v;
            }
        });
        return newRow;
    });
    return JSON.stringify({ ...parsed, scheduleData: sd });
}

function _anonymizeLeaveByDate(leaveByDate, maps) {
    const out = {};
    Object.entries(leaveByDate || {}).forEach(([d, names]) => {
        out[d] = (names || []).map(n => maps.personMap.get(n) || n);
    });
    return out;
}

// 把 LLM 回傳的 result 中的英文人名轉回中文。服事名 key 一直是中文，不需要還原。
function _deanonymizeResult(result, maps) {
    if (!result || typeof result !== 'object') return result;
    if (Array.isArray(result.scheduleData)) {
        result.scheduleData = result.scheduleData.map(row => {
            const newRow = { date: row.date };
            Object.entries(row).forEach(([k, v]) => {
                if (k === 'date') return;
                if (Array.isArray(v)) {
                    newRow[k] = v.map(n => maps.reversePerson.get(n) || n);
                } else {
                    newRow[k] = v;
                }
            });
            return newRow;
        });
    }
    // LLM 寫的自由文字（explanation / answer）也可能含英文人名 → 字串替換還原
    if (typeof result.explanation === 'string') {
        result.explanation = _deanonText(result.explanation, maps);
    }
    if (typeof result.answer === 'string') {
        result.answer = _deanonText(result.answer, maps);
    }
    return result;
}

// --- 請假區域 helpers ---

function _escapeAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;')
        .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 由生成週次推算可選日期；空時回傳 []
function _getGenerateRangeDates() {
    const genStart = document.getElementById('agentGenerateStart')?.value || '';
    const genEnd = document.getElementById('agentGenerateEnd')?.value || '';
    const existingDates = scheduleData.map(r => r.date);
    const latestExisting = [...existingDates].sort().pop() || null;
    const futureCandidates = latestExisting ? getFutureSundayCandidates(latestExisting) : [];
    return expandDateRange(genStart, genEnd, [...existingDates, ...futureCandidates]);
}

// YYYY.MM.DD → MM/DD，多日用「、」串接；給請假區域的按鈕 label 用
function _formatLeaveDatesLabel(dates) {
    return (dates || [])
        .map(d => {
            const m = /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(d || '');
            return m ? `${m[2]}/${m[3]}` : d;
        })
        .join('、');
}

function rebuildLeaveRows() {
    const container = document.getElementById('agentLeaveRows');
    if (!container) return;

    if (!_leaveRows || _leaveRows.length === 0) {
        _leaveRows = [{ person: '', dates: [] }];
    }

    const dateOptions = _getGenerateRangeDates();
    const personOptions = Array.from(allPersonNames || []).sort();

    // 若舊 row 的某些 dates 已不在新範圍 → 過濾掉（保留 person，使用者可重選）
    _leaveRows.forEach(r => {
        if (Array.isArray(r.dates)) {
            r.dates = r.dates.filter(d => dateOptions.includes(d));
        } else {
            r.dates = [];
        }
        // 相容舊資料：若還有單一 date 欄位（不該有），併進 dates 後丟掉
        if (typeof r.date === 'string') {
            if (r.date && dateOptions.includes(r.date) && !r.dates.includes(r.date)) {
                r.dates.push(r.date);
            }
            delete r.date;
        }
    });

    // datalist 給人名搜尋用（共用一個，避免每列重複）
    const datalist = document.getElementById('agentLeavePersonOptions');
    if (datalist) {
        datalist.innerHTML = personOptions
            .map(n => `<option value="${_escapeAttr(n)}"></option>`).join('');
    }

    const datePlaceholder = dateOptions.length === 0 ? '請先選擇生成週次' : '未選日期';

    container.innerHTML = _leaveRows.map((row, i) => {
        const selectedDates = row.dates || [];
        const buttonLabel = selectedDates.length === 0
            ? datePlaceholder
            : _formatLeaveDatesLabel(selectedDates);
        const optionsHtml = dateOptions.length === 0
            ? '<div class="agent-leave-dates-empty">請先選擇生成週次</div>'
            : dateOptions.map(d => `
                <label class="agent-leave-dates-option">
                    <input type="checkbox" value="${d}" data-idx="${i}">
                    <span>${d}</span>
                </label>
            `).join('');
        return `
            <div class="agent-leave-row" data-idx="${i}">
                <input class="agent-leave-person" list="agentLeavePersonOptions"
                    data-idx="${i}" placeholder="輸入或選擇人名"
                    autocomplete="off">
                <div class="agent-leave-dates" data-idx="${i}">
                    <button type="button" class="agent-leave-dates-button" data-idx="${i}"
                        aria-expanded="false">
                        <span class="agent-leave-dates-label">${buttonLabel}</span>
                        <span class="caret">▾</span>
                    </button>
                    <div class="agent-leave-dates-popup" data-idx="${i}" hidden>
                        ${optionsHtml}
                    </div>
                </div>
                <button type="button" class="agent-leave-remove" data-idx="${i}"
                    title="移除此列">×</button>
            </div>
        `;
    }).join('');

    // 還原已選值（innerHTML 重建後欄位會被 reset）
    _leaveRows.forEach((r, i) => {
        const pEl = container.querySelector(`.agent-leave-person[data-idx="${i}"]`);
        if (pEl && r.person) pEl.value = r.person;
        (r.dates || []).forEach(d => {
            const cb = container.querySelector(
                `.agent-leave-dates-popup[data-idx="${i}"] input[type="checkbox"][value="${d}"]`
            );
            if (cb) cb.checked = true;
        });
    });

    // 綁事件：人名輸入
    container.querySelectorAll('.agent-leave-person').forEach(el => {
        el.addEventListener('input', () => {
            const idx = parseInt(el.dataset.idx, 10);
            if (Number.isFinite(idx) && _leaveRows[idx]) _leaveRows[idx].person = el.value.trim();
        });
    });

    // 綁事件：日期下拉按鈕（toggle popup；同時關掉其他 popup）
    container.querySelectorAll('.agent-leave-dates-button').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const idx = btn.dataset.idx;
            const popup = container.querySelector(`.agent-leave-dates-popup[data-idx="${idx}"]`);
            const isOpen = popup && !popup.hidden;
            // 先關掉所有 popup
            container.querySelectorAll('.agent-leave-dates-popup').forEach(p => { p.hidden = true; });
            container.querySelectorAll('.agent-leave-dates-button').forEach(b => {
                b.setAttribute('aria-expanded', 'false');
            });
            if (popup && !isOpen) {
                popup.hidden = false;
                btn.setAttribute('aria-expanded', 'true');
            }
        });
    });

    // 綁事件：checkbox 變更 → 更新 state + 重新計算 button label
    container.querySelectorAll('.agent-leave-dates-popup input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => {
            const idx = parseInt(cb.dataset.idx, 10);
            if (!Number.isFinite(idx) || !_leaveRows[idx]) return;
            const popup = cb.closest('.agent-leave-dates-popup');
            const selected = Array.from(popup.querySelectorAll('input[type="checkbox"]:checked'))
                .map(x => x.value);
            _leaveRows[idx].dates = selected;
            const labelEl = container.querySelector(
                `.agent-leave-dates-button[data-idx="${idx}"] .agent-leave-dates-label`
            );
            if (labelEl) {
                labelEl.textContent = selected.length === 0
                    ? (dateOptions.length === 0 ? '請先選擇生成週次' : '未選日期')
                    : _formatLeaveDatesLabel(selected);
            }
        });
    });

    // 阻止點 popup 內部時冒泡關閉
    container.querySelectorAll('.agent-leave-dates-popup').forEach(popup => {
        popup.addEventListener('click', (e) => e.stopPropagation());
    });

    // 綁事件：移除列
    container.querySelectorAll('.agent-leave-remove').forEach(el => {
        el.addEventListener('click', () => {
            const idx = parseInt(el.dataset.idx, 10);
            if (!Number.isFinite(idx) || !_leaveRows[idx]) return;
            _leaveRows.splice(idx, 1);
            if (_leaveRows.length === 0) _leaveRows.push({ person: '', dates: [] });
            rebuildLeaveRows();
        });
    });
}

// 全域點擊外部時關閉所有日期 popup（只綁一次）
if (typeof window !== 'undefined' && !window.__agentLeaveOutsideClickBound) {
    window.__agentLeaveOutsideClickBound = true;
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.agent-leave-dates')) {
            document.querySelectorAll('.agent-leave-dates-popup').forEach(p => { p.hidden = true; });
            document.querySelectorAll('.agent-leave-dates-button').forEach(b => {
                b.setAttribute('aria-expanded', 'false');
            });
        }
    });
}

function _addLeaveRow() {
    _leaveRows.push({ person: '', dates: [] });
    rebuildLeaveRows();
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

    // 排班規則 radio btn-group active 狀態切換（連續週次、單週最多服事數）
    const bindRuleRadioGroup = (radioName, items) => {
        const resolved = items.map(([btnId, radioId]) => ({
            btn: document.getElementById(btnId),
            radio: document.getElementById(radioId),
        }));
        if (resolved.some(it => !it.btn || !it.radio)) return;
        const update = () => {
            resolved.forEach(({ btn, radio }) => {
                const isActive = radio.checked;
                btn.classList.toggle('btn-primary', isActive);
                btn.classList.toggle('btn-secondary', !isActive);
            });
        };
        document.querySelectorAll(`input[name="${radioName}"]`).forEach(r => {
            r.addEventListener('change', update);
        });
        update();
    };
    bindRuleRadioGroup('ruleConsecutiveWeeks', [
        ['consecutiveWeeks2Btn', 'consecutiveWeeks2'],
        ['consecutiveWeeks3Btn', 'consecutiveWeeks3'],
    ]);
    bindRuleRadioGroup('ruleMaxRolesLimit', [
        ['maxRolesLimit1Btn', 'maxRolesLimit1'],
        ['maxRolesLimit2Btn', 'maxRolesLimit2'],
        ['maxRolesLimit3Btn', 'maxRolesLimit3'],
    ]);

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

    // 請假區域收合/展開
    const leaveToggle = document.getElementById('agentLeaveToggle');
    const leaveContent = document.getElementById('agentLeaveContent');
    const leaveIcon = document.getElementById('agentLeaveIcon');
    if (leaveToggle && leaveContent && leaveIcon) {
        leaveToggle.addEventListener('click', () => {
            if (leaveContent.style.display === 'none') {
                leaveContent.style.display = '';
                leaveIcon.textContent = '▼';
            } else {
                leaveContent.style.display = 'none';
                leaveIcon.textContent = '▶';
            }
        });
    }

    // 請假區域「+ 新增請假」按鈕
    const leaveAddBtn = document.getElementById('agentLeaveAddBtn');
    if (leaveAddBtn) {
        leaveAddBtn.addEventListener('click', () => _addLeaveRow());
    }

    // 監聽歷史資料載入事件 → 即時重整參考週次下拉，把歷史日期加入候選
    window.addEventListener('pastDataLoaded', () => {
        if (isSchedulingMode()) {
            populateReferenceRangeDropdowns();
        }
    });

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

function appendChatMessageNode(text, role, options = {}) {
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

    // 排班模式完成時，在對話框「外面」右下角顯示耗時 badge
    const secs = Number(options.inferenceSeconds);
    if (role === 'assistant' && Number.isFinite(secs) && secs > 0) {
        const wrap = document.createElement('div');
        wrap.className = 'agent-msg-wrap assistant';
        wrap.appendChild(msg);
        const badge = document.createElement('span');
        badge.className = 'agent-msg-timing';
        badge.textContent = `${secs.toFixed(1)} 秒`;
        wrap.appendChild(badge);
        chatArea.appendChild(wrap);
    } else {
        chatArea.appendChild(msg);
    }
    chatArea.scrollTop = chatArea.scrollHeight;
}

export function addChatMessage(text, role = 'user', options = {}) {
    const mode = options.mode || getSelectedMode();
    if (options.persist !== false) {
        getModeHistory(mode).push({ role, content: text });
    }
    if (mode === getSelectedMode()) {
        appendChatMessageNode(text, role, options);
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

function buildChangedCellSet(baseScheduleData, nextScheduleData, userServiceItems, allowedDates) {
    const changedCells = new Set();
    const baseIndex = buildScheduleIndex(baseScheduleData);
    const nextIndex = buildScheduleIndex(nextScheduleData);
    const allDates = new Set([...baseIndex.keys(), ...nextIndex.keys()]);
    // 若有 allowedDates（例如 generateWeeks），只在這些日期內偵測變更，
    // 避免「LLM 沒回 context 週的 row」被誤判成「整列被清空」
    const allowSet = (allowedDates && allowedDates.length > 0) ? new Set(allowedDates) : null;

    allDates.forEach(date => {
        if (allowSet && !allowSet.has(date)) return;
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
    generateWeeks = [],
    leaveByDate = {},
    consecutiveContextWeeks = []
}) {
    const warnings = [];
    const validatedCellsByRule = {
        consecutive: new Set(),
        maxRoles: new Set(),
        serviceKnownPeople: new Set(),
        frequencyParity: new Set(),
        personUnavailability: new Set()
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
        // 把 base 的 boundary context 列併進來（LLM 沒回但仍是真實狀態），讓 window 跨越 generate 範圍邊界
        const baseIdx = buildScheduleIndex(baseScheduleData);
        const nextDateSet = new Set(nextScheduleData.map(r => r.date));
        const augmented = [...nextScheduleData];
        (consecutiveContextWeeks || []).forEach(d => {
            if (nextDateSet.has(d)) return;
            const baseRow = baseIdx.get(d);
            if (baseRow) augmented.push(baseRow);
        });
        const rows = augmented.sort((a, b) => String(a.date).localeCompare(String(b.date)));
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
    if (activeRules?.frequencyParity) {
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

    // 規則5: 請假區域 — 該週指定的人不應出現在任何 user service
    if (leaveByDate && Object.keys(leaveByDate).length > 0) {
        const seenLeave = new Set();
        Object.entries(leaveByDate).forEach(([date, names]) => {
            const row = nextIndex.get(date);
            if (!row || !Array.isArray(names) || names.length === 0) return;
            const nameSet = new Set(names);
            userServiceItems.forEach(service => {
                validatedCellsByRule.personUnavailability.add(`${date}|${service}`);
                (row[service] || []).forEach(n => {
                    if (!nameSet.has(n)) return;
                    const key = `${date}|${service}|${n}`;
                    if (seenLeave.has(key)) return;
                    seenLeave.add(key);
                    warnings.push({
                        type: 'personUnavailability',
                        message: `⚠️ ${n} 在 ${date} 請假，但仍被排了「${service}」`,
                        date,
                        service,
                        person: n
                    });
                });
            });
        });
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
                frequencyParity: toSortedArray(validatedCellsByRule.frequencyParity),
                personUnavailability: toSortedArray(validatedCellsByRule.personUnavailability)
            }
        }
    };
}

// --- Firestore agent_log 寫入 ---
// 後端回應的 body._debug 包含 system_prompt / messages / inference_time / mode / provider / model；
// 我們把它跟前端自己的 timing / retry 資訊組合後寫一筆到 Firestore agent_log。
// 失敗都 silent print，不影響主流程；後端不接 Firestore，所有寫入都在這裡。
const AGENT_LOG_COLLECTION = 'agent_log';
const AGENT_LOG_MAX_FIELD_BYTES = 500_000; // 單欄位 500KB 截斷上限，雙保險（Firestore single doc 上限 1MB）
const _AGENT_LOG_DOC_ID_UNSAFE_RE = /[^0-9A-Za-z._-]/g;

function _byteLengthUtf8(s) {
    return new TextEncoder().encode(s).length;
}

function _truncateUtf8(value, maxBytes) {
    // 回傳 [新字串, 是否被截斷]。在多 byte 字元邊界回退，避免切到一半。
    if (value === null || value === undefined) return [value, false];
    const s = typeof value === 'string' ? value : String(value);
    const enc = new TextEncoder();
    const bytes = enc.encode(s);
    if (bytes.length <= maxBytes) return [s, false];
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
    const cut = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, end));
    return [cut + `\n[...truncated, original ${bytes.length} bytes]`, true];
}

function _sanitizeAgentLogIdPart(value, fallback) {
    const v = String(value || '').trim();
    if (!v) return fallback;
    const cleaned = v.replace(_AGENT_LOG_DOC_ID_UNSAFE_RE, '_').slice(0, 64);
    return cleaned || fallback;
}

async function writeAgentLog({ startTime, retryCount, statusCode, debug, responseBody, selectedMode, serveId }) {
    try {
        if (!window.db || !window.firestore) return;
        const { collection, doc, getDoc, setDoc } = window.firestore;

        // doc id：沿用 {start-time}-{retry} 命名，字典序 ≈ 時間序
        const fallbackStart = new Date().toISOString().replace(/[:.]/g, '-');
        const safeStart = _sanitizeAgentLogIdPart(startTime, fallbackStart);
        const retryInt = Number.isFinite(Number(retryCount)) ? Number(retryCount) : 0;
        const baseId = `${safeStart}-${retryInt}`;
        let docId = baseId;

        // 同名衝突（同 start_time + retry 重送）加 _dup{i}
        const colRef = collection(window.db, AGENT_LOG_COLLECTION);
        for (let i = 0; i < 50; i++) {
            const snap = await getDoc(doc(colRef, docId));
            if (!snap.exists()) break;
            docId = `${baseId}_dup${i + 1}`;
            if (i === 49) docId = `${baseId}_dup${Date.now()}`;
        }

        // 欄位截斷
        const truncated = [];
        const dbg = debug || {};

        const [spStr, spT] = _truncateUtf8(dbg.system_prompt || '', AGENT_LOG_MAX_FIELD_BYTES);
        if (spT) truncated.push('system_prompt');

        const [thinkStr, thinkT] = _truncateUtf8(dbg.thinking || '', AGENT_LOG_MAX_FIELD_BYTES);
        if (thinkT) truncated.push('thinking');

        const cleanMessages = [];
        let msgTruncated = false;
        for (const m of (dbg.messages || [])) {
            const role = (m && m.role) || '';
            let content = (m && m.content !== undefined) ? m.content : '';
            if (typeof content !== 'string') {
                try { content = JSON.stringify(content); } catch { content = String(content); }
            }
            const [ct, t] = _truncateUtf8(content, AGENT_LOG_MAX_FIELD_BYTES);
            if (t) msgTruncated = true;
            cleanMessages.push({ role, content: ct });
        }
        if (msgTruncated) truncated.push('messages');

        // response_body：序列化後若過大存 preview
        let rbValue = responseBody;
        try {
            const rbJson = JSON.stringify(responseBody);
            if (rbJson && _byteLengthUtf8(rbJson) > AGENT_LOG_MAX_FIELD_BYTES) {
                const [preview] = _truncateUtf8(rbJson, AGENT_LOG_MAX_FIELD_BYTES);
                rbValue = { _truncated: true, preview };
                truncated.push('response_body');
            }
        } catch {
            rbValue = { _unserializable: String(responseBody).slice(0, 5000) };
        }

        const payload = {
            wall_clock_utc: new Date().toISOString(),
            start_time: startTime || null,
            retry_count: retryInt,
            'serve-id': serveId || '', // 對應的崇拜 collection（如 _service_1），與 _edit_chart_log 同欄位名
            mode: dbg.mode || selectedMode || '',
            provider: dbg.provider || '',
            model: dbg.model || '',
            enable_thinking: !!dbg.enable_thinking,
            status_code: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
            inference_time: (typeof dbg.inference_time === 'number') ? dbg.inference_time : null,
            stop_reason: typeof dbg.stop_reason === 'string' ? dbg.stop_reason : '',
            system_prompt: spStr,
            thinking: thinkStr,
            messages: cleanMessages,
            response_body: rbValue,
            truncated_fields: truncated,
        };

        try {
            await setDoc(doc(colRef, docId), payload);
        } catch (writeErr) {
            // 整 doc 寫入失敗（極端情境，超過 1MB 上限）→ fallback 寫精簡 metadata
            console.warn('[agent-log] full write failed, fallback metadata-only:', writeErr);
            await setDoc(doc(colRef, docId), {
                wall_clock_utc: payload.wall_clock_utc,
                start_time: payload.start_time,
                retry_count: payload.retry_count,
                'serve-id': payload['serve-id'],
                mode: payload.mode,
                provider: payload.provider,
                model: payload.model,
                enable_thinking: payload.enable_thinking,
                status_code: payload.status_code,
                inference_time: payload.inference_time,
                stop_reason: payload.stop_reason || '',
                system_prompt: '(omitted: full-doc write failed)',
                thinking: '(omitted: full-doc write failed)',
                messages: [],
                response_body: { _omitted: true, reason: String(writeErr).slice(0, 500) },
                truncated_fields: ['system_prompt', 'thinking', 'messages', 'response_body'],
            });
        }
    } catch (e) {
        console.warn('[agent-log] write failed:', e);
    }
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
            consecutiveWeeks: Math.max(2, parseInt(document.querySelector('input[name="ruleConsecutiveWeeks"]:checked')?.value, 10) || 2),
            maxRoles: document.getElementById('ruleMaxRoles')?.checked ?? false,
            maxRolesLimit: Math.max(1, parseInt(document.querySelector('input[name="ruleMaxRolesLimit"]:checked')?.value, 10) || 2),
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

    // 候選池：reference 跟下拉選單一致（pastData ∪ existing）；generate 允許既有 + 未來週日候選
    // ※ 參考週次下拉是 pastData ∪ existing；若這裡只用 _existingDates 當 candidates，
    //   使用者選到僅在 pastData 裡的日期時 expandDateRange 會回傳 []，導致後段 fallback 把整張表送出去
    const _existingDates = scheduleData.map(r => r.date);
    const _latestExisting = [..._existingDates].sort().pop() || null;
    const _futureCandidates = _latestExisting ? getFutureSundayCandidates(_latestExisting) : [];
    const _historyCtx = getHistoryViewContext();
    const _historyDates = (_historyCtx?.pastData || []).map(r => r.date).filter(Boolean);
    const _refCandidates = [...new Set([..._historyDates, ..._existingDates])];

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

    const referenceWeeks = expandDateRange(refStart, refEnd, _refCandidates);
    const generateWeeks = expandDateRange(genStart, genEnd, [..._existingDates, ..._futureCandidates]);

    // 生成週次：如果有不存在的，先在前端 + Firestore 建空週次後才打 API
    if (scheduling) {
        const existingDates = new Set(scheduleData.map(r => r.date));
        const missing = generateWeeks.filter(d => !existingDates.has(d)).sort();
        if (missing.length > 0) {
            updateStatus(`新增 ${missing.length} 個週次中...`);
            try {
                for (const dateStr of missing) {
                    const blank = {};
                    serviceItems.forEach(item => { blank[item] = []; });
                    scheduleData.push({ date: dateStr, ...blank });
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

    const historyViewContext = _historyCtx;

    // 已載入的歷史資料一律前置，讓使用者可把過去日期當 referenceWeeks 使用
    // (referenceWeeks 後續 .filter 仍會限縮到使用者實際選的範圍，不會放大送 LLM 的內容)
    if (historyViewContext.pastData && historyViewContext.pastData.length > 0) {
        effectiveScheduleData = [...historyViewContext.pastData, ...effectiveScheduleData];
    }

    // 「禁止連續 N 週」boundary context：把生成週次的前後 (N-1) 週也納入 LLM 視野
    // 否則 LLM 看不到 generate 週次外的近鄰，無法判斷跨邊界違規（例：6/28 已排了某人，
    // LLM 在 7/5 又把同人放同位置 → 連續 2 週違規）
    let consecutiveContextWeeks = [];
    if (scheduling && activeRules.consecutive) {
        consecutiveContextWeeks = _computeConsecutiveContextDates(
            generateWeeks,
            activeRules.consecutiveWeeks,
            effectiveScheduleData
        );
    }

    // 排班模式：只送 referenceWeeks + boundary context 週；其他模式（chat）送完整班表
    const includedDates = new Set([...referenceWeeks, ...consecutiveContextWeeks]);
    const scheduleToSend = scheduling
        ? effectiveScheduleData.filter(r => includedDates.has(r.date))
        : effectiveScheduleData;

    // 送給 agent 前把每列的 nonUserColumns 拿掉，只保留人員欄位
    // key 順序固定為「date → serviceItems 內順序」，缺的欄位補 []，
    // 這樣每列序列化後結構完全一致，prompt cache hit rate 最大化
    const nonUserSet = new Set(nonUserColumns || []);
    const userColumns = (serviceItems || []).filter(s => !nonUserSet.has(s));
    const scheduleToSendClean = scheduleToSend.map(row => {
        const out = { date: row.date };
        for (const s of userColumns) {
            const v = row[s];
            out[s] = Array.isArray(v) ? v : [];
        }
        return out;
    });

    const payload = {
        prompt,
        currentSchedule: JSON.stringify({ scheduleData: scheduleToSendClean }),
        selectedMode,
        activeRules,
        chatHistory,
        enableThinking: isThinkingEnabled()
    };

    if (csvTextToSend) payload.attachedCsvText = csvTextToSend;

    // 排班模式：通知後端限縮輸出範圍並 suppress addWeeks/removeWeeks tool 欄位
    if (scheduling) {
        payload.generateWeeks = generateWeeks;
        payload.suppressStructural = true;
    }
    if (consecutiveContextWeeks.length > 0) {
        payload.consecutiveContextWeeks = consecutiveContextWeeks;
    }

    // 請假區域：每列 {person, dates: []}。完全空 → 略過；只填人沒選日期 / 只選日期沒填人 → 錯誤。
    // pivot 成 {date: [persons]} 給後端 leaveByDate
    const leaveByDate = {};
    if (scheduling) {
        const leaveErrors = [];
        _leaveRows.forEach((row, i) => {
            const p = (row.person || '').trim();
            const dates = Array.isArray(row.dates) ? row.dates.filter(Boolean) : [];
            if (!p && dates.length === 0) return;       // 完全空 → 略過
            if (!p) {
                leaveErrors.push(`第 ${i + 1} 列：人員未填`);
                return;
            }
            if (dates.length === 0) {
                leaveErrors.push(`第 ${i + 1} 列：未選任何週次`);
                return;
            }
            dates.forEach(d => {
                if (!leaveByDate[d]) leaveByDate[d] = [];
                if (!leaveByDate[d].includes(p)) leaveByDate[d].push(p);
            });
        });
        if (leaveErrors.length > 0) {
            addChatMessage(
                `❌ 請假區域格式錯誤：\n${leaveErrors.join('\n')}`,
                'error',
                { mode: selectedMode }
            );
            return;
        }
    }
    if (Object.keys(leaveByDate).length > 0) {
        payload.leaveByDate = leaveByDate;
    }

    // === 實驗：把 currentSchedule / leaveByDate / prompt / chatHistory 內所有中文匿名化成英文 ===
    // 建一張 per-request map；response 解回時用 reverse map 還原。
    let anonMaps = null;
    if (scheduling && USE_ANONYMIZATION) {
        try {
            const csParsed = JSON.parse(payload.currentSchedule);
            // 也把 allPersonNames 帶進來：避免 user_request 提到 reference 範圍外的人名沒被翻
            anonMaps = _buildAnonMap(
                csParsed.scheduleData || [],
                payload.leaveByDate || {},
                Array.from(allPersonNames || [])
            );
        } catch (err) {
            addChatMessage(`❌ 匿名化建表失敗:${err.message}`, 'error', { mode: selectedMode });
            return;
        }
        payload.currentSchedule = _anonymizeCurrentSchedule(payload.currentSchedule, anonMaps);
        if (payload.leaveByDate) {
            payload.leaveByDate = _anonymizeLeaveByDate(payload.leaveByDate, anonMaps);
        }
        // prompt 也可能含中文人名 / 服事名，做 longest-first 字串替換
        payload.prompt = _anonText(payload.prompt, anonMaps);
        // chatHistory：同一 session 的歷史訊息也翻成英文，讓 LLM 看到的對話前後一致
        if (Array.isArray(payload.chatHistory)) {
            payload.chatHistory = payload.chatHistory.map(msg => ({
                role: msg.role,
                content: _anonText(msg.content, anonMaps)
            }));
        }
    }

    agentIsLoading = true;
    document.getElementById('agentSendBtn').disabled = true;
    showAgentLoading(selectedMode);

    let apiErrorRetryCount = 0;
    const MAX_API_ERROR_RETRIES = 1;

    // 同一個 sendAgentRequest 裡每次 fetch 共用 logStartTime，作為 Firestore agent_log doc id 的時間部分；
    // 只有 API error retry 會增加 apiErrorRetryCount。
    const pad2 = n => String(n).padStart(2, '0');
    const _now = new Date();
    const logStartTime = `${_now.getFullYear()}-${pad2(_now.getMonth() + 1)}-${pad2(_now.getDate())}_${pad2(_now.getHours())}-${pad2(_now.getMinutes())}-${pad2(_now.getSeconds())}`;

    while (apiErrorRetryCount <= MAX_API_ERROR_RETRIES) {
        try {
            const response = await fetch(AGENT_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            // 統一讀 body 一次（成功失敗都讀）→ 嘗試 JSON parse → 抽 _debug → 寫 Firestore agent_log
            const responseText = await response.text();
            let result;
            try {
                result = JSON.parse(responseText);
            } catch {
                result = { _raw_text: responseText };
            }

            // 從 body 抽出 _debug 並刪除（下游邏輯不要看到內部欄位）
            const debug = (result && typeof result === 'object' && result._debug) || null;
            if (debug) delete result._debug;

            // 寫一筆 log（不論成功失敗都寫；await 確保 dashboard 能立即看到）
            await writeAgentLog({
                startTime: logStartTime,
                retryCount: apiErrorRetryCount,
                statusCode: response.status,
                debug,
                responseBody: result,
                selectedMode,
                serveId: window.COLLECTION_NAME || '',
            });

            if (!response.ok) {
                const apiError = new Error(`API 錯誤 (${response.status}): ${typeof result === 'string' ? result : JSON.stringify(result).slice(0, 500)}`);
                apiError.status = response.status;
                throw apiError;
            }

            // anon 模式：把 LLM 的英文回應還原成中文，後續所有邏輯（validator、setPendingChanges）用原始中文跑
            if (anonMaps) {
                _deanonymizeResult(result, anonMaps);
            }

            // 問答型回覆（不含排班變更）直接顯示，不進入驗證/套用流程
            if (result.answerOnly || result.mode === 'answer_only' || !Array.isArray(result.scheduleData)) {
                hideAgentLoading();
                addChatMessage(result.answer || result.explanation || '已收到回覆。', 'assistant', { mode: selectedMode });
                break;
            }

            const userServiceItems = serviceItems.filter(s => !nonUserColumns.includes(s));
            const changedCells = buildChangedCellSet(
                effectiveScheduleData,
                result.scheduleData,
                userServiceItems,
                scheduling ? generateWeeks : null
            );
            const validation = validateScopedChanges({
                baseScheduleData: effectiveScheduleData,
                nextScheduleData: result.scheduleData,
                serviceItems,
                nonUserColumns,
                activeRules,
                changedCells,
                referenceWeeks,
                generateWeeks,
                leaveByDate,
                consecutiveContextWeeks
            });

            hideAgentLoading();

            // 排班模式才在 explanation 右下角顯示推論耗時
            const timingOpts = (selectedMode === 'scheduling' && Number.isFinite(Number(result.inferenceSeconds)))
                ? { inferenceSeconds: Number(result.inferenceSeconds) }
                : {};

            if (!validation.valid) {
                // 如果有警告，優先顯示警告資訊
                addChatMessage((result.explanation || '已產生排班建議') + `（但有 ${validation.warnings.length} 項規則警告）`, 'assistant', { mode: selectedMode, ...timingOpts });
                validation.warnings.forEach(w => addChatMessage(w.message, 'error', { mode: selectedMode }));
            } else {
                // 有 explanation 就顯示 explanation，否則顯示預設字眼
                addChatMessage(result.explanation || '已產生排班建議，請檢視表格中的變更。', 'assistant', { mode: selectedMode, ...timingOpts });
            }

            // --- 處理結構變更 (Structural Changes) ---
            // 必須先處理結構變更，表格中有了對應的日期列/服事欄後，setPendingChanges 才能正確比對出差異

            await applyAgentStructuralChanges({
                addWeeks: result.addWeeks || 0,
                removeWeeks: result.removeWeeks || 0,
                addServiceColumns: result.addServiceColumns || [],
                removeServiceColumns: result.removeServiceColumns || []
            });

            // 排班模式：多一層前端護欄，LLM 多回的日期（generateWeeks 之外）直接丟棄
            let nextScheduleData = result.scheduleData;
            if (scheduling) {
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

    // 不在 await 前動 row[service]，等寫入成功才 commit（saveSchedule 失敗時記憶體不殘留幻影 edit）
    const newArr = [...change.new];
    const data = { ...row, [service]: newArr };
    delete data.date;

    try {
        await saveSchedule(row.date, data);
    } catch (error) {
        // 分頁鎖定 → modal 已顯示，靜默 swallow
        if (!error || error.message !== 'TAB_LOCKED') {
            console.error('acceptCellChange failed:', error);
            addChatMessage(`單格儲存失敗：${error && error.message ? error.message : error}`, 'error');
        }
        return;
    }

    row[service] = newArr;
    pushHistory();
    updateEditDifference('ai');

    delete pendingAgentChanges[date][service];
    if (Object.keys(pendingAgentChanges[date]).length === 0) delete pendingAgentChanges[date];

    checkPendingComplete();
    renderTable();
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

    // 逐筆呼叫 saveSchedule，受分頁鎖保護；若 LLM 回應到使用者按 Accept 之間分頁被搶走，
    // 第一個 saveSchedule 就會拋 TAB_LOCKED，後續 iteration 沒意義。其他 save error
    // （網路、權限）則保留那筆 pending 給使用者重試。
    const failedDates = [];
    let lockedOut = false;

    for (const [date, services] of Object.entries(pendingAgentChanges)) {
        const row = scheduleData.find(r => r.date === date);
        if (!row) continue;

        const newRow = { ...row };
        Object.entries(services).forEach(([service, change]) => {
            newRow[service] = [...change.new];
        });
        const data = { ...newRow };
        delete data.date;

        try {
            await saveSchedule(date, data);
            Object.entries(services).forEach(([service, change]) => {
                row[service] = [...change.new];
            });
        } catch (err) {
            if (err && err.message === 'TAB_LOCKED') {
                lockedOut = true;
                break;
            }
            failedDates.push(date);
            console.error(`acceptAllChanges save failed for ${date}:`, err);
        }
    }

    if (lockedOut) return;  // modal 已顯示

    if (failedDates.length === 0) {
        pushHistory();
        updateEditDifference('ai');
        pendingAgentChanges = null;
        document.getElementById('agentReviewBar').classList.add('hidden');
        renderTable();
        addChatMessage('✅ 已接受所有變更', 'assistant');
        updateStatus('Agent 變更已套用');
    } else {
        // 部分成功：保留失敗的 pending 給使用者重試
        const stillPending = {};
        failedDates.forEach(d => { if (pendingAgentChanges[d]) stillPending[d] = pendingAgentChanges[d]; });
        Object.keys(pendingAgentChanges).forEach(d => {
            if (!failedDates.includes(d)) delete pendingAgentChanges[d];
        });
        pushHistory();
        updateEditDifference('ai');
        renderTable();
        addChatMessage(`⚠️ 已套用部分變更，${failedDates.length} 列儲存失敗：${failedDates.join(', ')}`, 'error');
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
