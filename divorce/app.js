'use strict';

// ===== 定義（zoho/divorce_case_management.ds に準拠） =====
const STATUSES = [
    '0.受任・初期選任', '1.着手・受任通知', '2.事実関係整理・情報収集', '3.財産分与整理・協議財産開示',
    '4.協議交渉(書面・面談)', '5.協議書作成・公正証書化', '6.離婚調停準備', '7.離婚調停進行中',
    '8.訴訟・審判移行', '9.和解・判決', '10.履行確保・離婚届出', '11.精算・完了'
];
const POSITIONS = ['妻', '夫'];
const COUNTER_LAWYER = ['不明', 'あり', 'なし'];
const ISSUES = ['親権', '養育費', '財産分与', '慰謝料', '年金分割', 'DV・モラハラ', '面会交流', '婚姻費用'];
const DEADLINE_TYPES = ['調停期日', '書面提出期限', '回答期限', '口頭弁論期日', 'その他'];

const DONE_STATUS = STATUSES[STATUSES.length - 1];
const INITIAL_STATUS = STATUSES[0];
const INITIAL_COUNTER_LAWYER = '不明';
const SOON_DAYS = 7;
const TIME_ZONE = 'Asia/Tokyo';

const CASES_KEY = 'divorceCases.cases.v1';
const STAFF_KEY = 'divorceCases.staff.v1';

// ===== 状態 =====
let cases = load(CASES_KEY, []);
let staff = load(STAFF_KEY, []);
let editingId = null;
let sortKey = 'next_deadline';
let sortDir = 1;

const $ = (id) => document.getElementById(id);

// ===== ストレージ =====
function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        const value = raw ? JSON.parse(raw) : fallback;
        return Array.isArray(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

function save(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        showToast('保存に失敗しました。ブラウザの保存領域を確認してください。', true);
        return false;
    }
}

// ===== ユーティリティ =====
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
}

function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function todayStr() {
    // en-CA は yyyy-MM-dd 形式
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
}

function daysUntil(dateStr) {
    const today = Date.parse(todayStr() + 'T00:00:00Z');
    const target = Date.parse(dateStr + 'T00:00:00Z');
    return Math.round((target - today) / 86400000);
}

function deadlineState(c) {
    if (!c.next_deadline || c.status === DONE_STATUS) return '';
    const days = daysUntil(c.next_deadline);
    if (days < 0) return 'overdue';
    if (days <= SOON_DAYS) return 'soon';
    return '';
}

function deadlineNote(c) {
    const state = deadlineState(c);
    if (!state) return '';
    const days = daysUntil(c.next_deadline);
    if (days < 0) return `${-days}日超過`;
    if (days === 0) return '本日';
    return `あと${days}日`;
}

function fillSelect(select, values, blankLabel) {
    select.innerHTML = '';
    if (blankLabel !== undefined) select.add(new Option(blankLabel, ''));
    values.forEach((v) => select.add(new Option(v, v)));
}

function askConfirm(message, okLabel = 'OK') {
    return new Promise((resolve) => {
        const overlay = $('confirmOverlay');
        $('confirmMsg').textContent = message;
        $('confirmOk').textContent = okLabel;
        overlay.hidden = false;
        $('confirmCancel').focus();
        const close = (result) => {
            overlay.hidden = true;
            $('confirmOk').onclick = $('confirmCancel').onclick = overlay.onkeydown = null;
            resolve(result);
        };
        $('confirmOk').onclick = () => close(true);
        $('confirmCancel').onclick = () => close(false);
        overlay.onkeydown = (e) => { if (e.key === 'Escape') close(false); };
    });
}

let toastTimer;
function showToast(message, isError = false) {
    const toast = $('toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

// ===== 画面切替 =====
function showView(name) {
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
    document.querySelectorAll('.nav-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.view === name && !(name === 'form' && editingId));
    });
    if (name === 'list') renderList();
    if (name === 'settings') renderStaff();
    window.scrollTo(0, 0);
}

// ===== 一覧 =====
function filteredCases() {
    const q = $('fSearch').value.trim().toLowerCase();
    const status = $('fStatus').value;
    const lawyer = $('fLawyer').value;
    const issue = $('fIssue').value;
    const deadline = $('fDeadline').value;
    const showDone = $('fShowDone').checked;

    return cases.filter((c) => {
        if (status) {
            if (c.status !== status) return false;
        } else if (!showDone && c.status === DONE_STATUS) {
            return false;
        }
        if (lawyer && c.lawyer !== lawyer) return false;
        if (issue && !(c.key_issues || []).includes(issue)) return false;
        if (deadline && deadlineState(c) !== deadline) return false;
        if (q && !`${c.client_name} ${c.notes || ''}`.toLowerCase().includes(q)) return false;
        return true;
    });
}

function compareCases(a, b) {
    const va = a[sortKey] || '';
    const vb = b[sortKey] || '';
    // 未入力は並び順にかかわらず末尾
    if (!va && vb) return 1;
    if (va && !vb) return -1;
    let result;
    if (sortKey === 'status') {
        result = STATUSES.indexOf(va) - STATUSES.indexOf(vb);
    } else {
        result = String(va).localeCompare(String(vb), 'ja');
    }
    if (result === 0) result = String(a.client_name).localeCompare(String(b.client_name), 'ja');
    return result * sortDir;
}

function renderSummary() {
    const active = cases.filter((c) => c.status !== DONE_STATUS);
    $('sumActive').textContent = active.length;
    $('sumOverdue').textContent = active.filter((c) => deadlineState(c) === 'overdue').length;
    $('sumSoon').textContent = active.filter((c) => deadlineState(c) === 'soon').length;
    $('sumDone').textContent = cases.length - active.length;

    const deadline = $('fDeadline').value;
    document.querySelectorAll('[data-deadline-filter]').forEach((card) => {
        card.classList.toggle('selected', card.dataset.deadlineFilter === deadline);
    });

    const selectedStatus = $('fStatus').value;
    $('statusChips').innerHTML = STATUSES.map((s) => {
        const count = cases.filter((c) => c.status === s).length;
        const selected = s === selectedStatus ? ' selected' : '';
        return `<button type="button" class="chip${selected}" data-status="${escapeHtml(s)}">` +
            `${escapeHtml(s)}<span class="count">${count}</span></button>`;
    }).join('');
}

function renderLawyerFilter() {
    const select = $('fLawyer');
    const current = select.value;
    const names = new Set(staff);
    cases.forEach((c) => { if (c.lawyer) names.add(c.lawyer); });
    fillSelect(select, [...names].sort((a, b) => a.localeCompare(b, 'ja')), '担当弁護士：すべて');
    select.value = names.has(current) ? current : '';
}

function renderList() {
    renderLawyerFilter();
    renderSummary();

    document.querySelectorAll('#caseTable th[data-sort]').forEach((th) => {
        th.classList.toggle('sorted-asc', th.dataset.sort === sortKey && sortDir === 1);
        th.classList.toggle('sorted-desc', th.dataset.sort === sortKey && sortDir === -1);
    });

    const rows = filteredCases().sort(compareCases);
    $('caseRows').innerHTML = rows.map((c) => {
        const state = deadlineState(c);
        const note = deadlineNote(c);
        const issues = (c.key_issues || []).map((i) => `<span class="tag">${escapeHtml(i)}</span>`).join('');
        return `<tr data-id="${escapeHtml(c.id)}"${c.status === DONE_STATUS ? ' class="done"' : ''}>
            <td>${escapeHtml(c.client_name)}</td>
            <td>${escapeHtml(c.client_position)}</td>
            <td>${escapeHtml(c.status)}</td>
            <td class="issues">${issues}</td>
            <td>${escapeHtml(c.lawyer)}</td>
            <td>${escapeHtml(c.paralegal)}</td>
            <td class="deadline ${state}">${escapeHtml(c.next_deadline)}${note ? `<small>${note}</small>` : ''}</td>
            <td>${escapeHtml(c.deadline_type)}</td>
            <td>${escapeHtml(c.counter_lawyer)}</td>
        </tr>`;
    }).join('');
    $('emptyMsg').hidden = rows.length > 0 || cases.length === 0;
    $('firstRun').hidden = cases.length > 0;
    $('caseTable').closest('.table-wrap').hidden = cases.length === 0;
}

// ===== フォーム =====
function staffOptions(select, current) {
    const names = [...staff];
    if (current && !names.includes(current)) names.push(current);
    fillSelect(select, names, '（未選択）');
    select.value = current || '';
}

function clearErrors() {
    $('err_client_name').hidden = true;
    $('client_name').classList.remove('invalid');
}

function openForm(id = null) {
    editingId = id;
    const form = $('caseForm');
    form.reset();
    clearErrors();

    const c = id ? cases.find((x) => x.id === id) : null;
    $('formTitle').textContent = c ? '離婚案件の編集' : '離婚案件の新規登録';
    $('addActions').hidden = !!c;
    $('editActions').hidden = !c;

    staffOptions($('lawyer'), c?.lawyer);
    staffOptions($('paralegal'), c?.paralegal);
    $('staffHint').hidden = staff.length > 0;

    if (c) {
        ['client_name', 'status', 'client_position', 'counter_lawyer', 'next_deadline', 'deadline_type', 'notes']
            .forEach((f) => { $(f).value = c[f] || ''; });
        document.querySelectorAll('#key_issues input').forEach((cb) => {
            cb.checked = (c.key_issues || []).includes(cb.value);
        });
    }
    showView('form');
    $('client_name').focus();
}

function readForm() {
    return {
        client_name: $('client_name').value.trim(),
        status: $('status').value,
        client_position: $('client_position').value,
        counter_lawyer: $('counter_lawyer').value,
        key_issues: [...document.querySelectorAll('#key_issues input:checked')].map((cb) => cb.value),
        lawyer: $('lawyer').value,
        paralegal: $('paralegal').value,
        next_deadline: $('next_deadline').value,
        deadline_type: $('deadline_type').value,
        notes: $('notes').value
    };
}

function handleSubmit(event) {
    event.preventDefault();
    const data = readForm();
    clearErrors();
    if (!data.client_name) {
        $('err_client_name').hidden = false;
        $('client_name').classList.add('invalid');
        $('client_name').focus();
        return;
    }

    const now = new Date().toISOString();
    const next = editingId
        ? cases.map((c) => (c.id === editingId ? { ...c, ...data, updatedAt: now } : c))
        : [...cases, { id: newId(), ...data, createdAt: now, updatedAt: now }];

    if (!save(CASES_KEY, next)) return;
    cases = next;
    editingId = null;
    showToast('案件情報を保存しました。');
    showView('list');
}

async function handleDelete() {
    const c = cases.find((x) => x.id === editingId);
    if (!c || !await askConfirm(`「${c.client_name}」の案件を削除しますか？この操作は取り消せません。`, '削除する')) return;
    const next = cases.filter((x) => x.id !== editingId);
    if (!save(CASES_KEY, next)) return;
    cases = next;
    editingId = null;
    showToast('案件を削除しました。');
    showView('list');
}

// ===== 設定：担当者 =====
function renderStaff() {
    $('staffList').innerHTML = staff.length
        ? staff.map((name, i) => `<li><span>${escapeHtml(name)}</span>` +
            `<button type="button" data-remove="${i}">削除</button></li>`).join('')
        : '<li class="hint">担当者が登録されていません。</li>';
}

function addStaff(event) {
    event.preventDefault();
    const name = $('staffName').value.trim();
    if (!name) return;
    if (staff.includes(name)) {
        showToast('同じ名前の担当者が既に登録されています。', true);
        return;
    }
    const next = [...staff, name];
    if (!save(STAFF_KEY, next)) return;
    staff = next;
    $('staffName').value = '';
    renderStaff();
}

async function removeStaff(index) {
    const name = staff[index];
    if (!await askConfirm(`担当者「${name}」を選択肢から削除しますか？（既存案件の担当者欄はそのまま残ります）`, '削除する')) return;
    const next = staff.filter((_, i) => i !== index);
    if (!save(STAFF_KEY, next)) return;
    staff = next;
    renderStaff();
}

// ===== 設定：入出力 =====
let exportFile = null;

function showExport(title, filename, content, type) {
    exportFile = { filename, content, type };
    $('exportTitle').textContent = title;
    $('exportText').value = content.replace(/^\uFEFF/, '');
    $('exportPanel').hidden = false;
    $('exportText').scrollIntoView({ block: 'nearest' });
}

async function copyExport() {
    try {
        await navigator.clipboard.writeText($('exportText').value);
        showToast('コピーしました。');
    } catch {
        $('exportText').select();
        showToast('テキストを選択しました。Ctrl+C（⌘+C）でコピーしてください。');
    }
}

function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function exportJson() {
    const data = { version: 1, exportedAt: new Date().toISOString(), staff, cases };
    showExport('バックアップ（JSON）', `divorce_cases_${todayStr()}.json`, JSON.stringify(data, null, 2), 'application/json');
}

function exportCsv() {
    const headers = ['依頼者名', 'ステータス', '依頼者の立場', '相手方代理人', '主な争点',
        '担当弁護士', '担当事務員', '次回期日・期限', '期日の種類', '備考・メモ', '登録日時', '更新日時'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [headers.map(cell).join(',')];
    [...cases].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status)).forEach((c) => {
        lines.push([c.client_name, c.status, c.client_position, c.counter_lawyer, (c.key_issues || []).join('、'),
            c.lawyer, c.paralegal, c.next_deadline, c.deadline_type, c.notes, c.createdAt, c.updatedAt]
            .map(cell).join(','));
    });
    // Excel で文字化けしないよう BOM を付与
    showExport('CSV', `divorce_cases_${todayStr()}.csv`, '\uFEFF' + lines.join('\r\n'), 'text/csv');
}

function normalizeCase(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.client_name ?? '').trim();
    if (!name) return null;
    const pick = (v, list, fallback = '') => (list.includes(v) ? v : fallback);
    const str = (v) => (typeof v === 'string' ? v : '');
    return {
        id: str(raw.id) || newId(),
        client_name: name,
        status: pick(raw.status, STATUSES, INITIAL_STATUS),
        client_position: pick(raw.client_position, POSITIONS),
        counter_lawyer: pick(raw.counter_lawyer, COUNTER_LAWYER, INITIAL_COUNTER_LAWYER),
        key_issues: Array.isArray(raw.key_issues) ? raw.key_issues.filter((i) => ISSUES.includes(i)) : [],
        lawyer: str(raw.lawyer),
        paralegal: str(raw.paralegal),
        next_deadline: /^\d{4}-\d{2}-\d{2}$/.test(raw.next_deadline) ? raw.next_deadline : '',
        deadline_type: pick(raw.deadline_type, DEADLINE_TYPES),
        notes: str(raw.notes),
        createdAt: str(raw.createdAt),
        updatedAt: str(raw.updatedAt)
    };
}

function importJson(event) {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => restoreFromText(reader.result);
    reader.readAsText(file);
}

async function restoreFromText(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        showToast('JSONとして読み込めませんでした。内容を確認してください。', true);
        return;
    }
    const rawCases = Array.isArray(data) ? data : data?.cases;
    if (!Array.isArray(rawCases)) {
        showToast('案件データが見つかりません。', true);
        return;
    }
    const imported = rawCases.map(normalizeCase).filter(Boolean);
    const importedStaff = Array.isArray(data?.staff)
        ? [...new Set(data.staff.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
        : staff;
    if (!await askConfirm(`${imported.length}件の案件を読み込みます。現在のデータ（${cases.length}件）は置き換えられます。よろしいですか？`, '復元する')) return;
    if (!save(CASES_KEY, imported) || !save(STAFF_KEY, importedStaff)) return;
    cases = imported;
    staff = importedStaff;
    renderStaff();
    $('importText').value = '';
    showToast(`${imported.length}件の案件を復元しました。`);
}

// ===== サンプルデータ =====
function addDays(n) {
    const d = new Date(Date.parse(todayStr() + 'T00:00:00Z') + n * 86400000);
    return d.toISOString().slice(0, 10);
}

function loadSamples() {
    const now = new Date().toISOString();
    const sample = (client_name, status, client_position, counter_lawyer, key_issues, days, deadline_type, notes) => ({
        id: newId(), client_name, status, client_position, counter_lawyer, key_issues,
        lawyer: '', paralegal: '', next_deadline: days === null ? '' : addDays(days), deadline_type, notes,
        createdAt: now, updatedAt: now
    });
    const next = [
        sample('【サンプル】山本 花子', '7.離婚調停進行中', '妻', 'あり', ['親権', '養育費', '面会交流'], -2, '書面提出期限', '主張書面の提出が遅れている例'),
        sample('【サンプル】田中 一郎', '4.協議交渉(書面・面談)', '夫', 'なし', ['財産分与', '年金分割'], 5, '回答期限', '相手方からの回答待ち'),
        sample('【サンプル】佐々木 美咲', '2.事実関係整理・情報収集', '妻', '不明', ['DV・モラハラ', '慰謝料', '婚姻費用'], 21, 'その他', '保護命令の要否を検討'),
        sample('【サンプル】鈴木 健', '11.精算・完了', '夫', 'あり', ['養育費'], null, '', '')
    ];
    if (!save(CASES_KEY, next)) return;
    cases = next;
    renderList();
    showToast('サンプル案件を4件表示しました。不要になったら各案件を削除してください。');
}

// ===== 初期化 =====
function init() {
    fillSelect($('status'), STATUSES);
    fillSelect($('client_position'), POSITIONS, '（未選択）');
    fillSelect($('counter_lawyer'), COUNTER_LAWYER);
    fillSelect($('deadline_type'), DEADLINE_TYPES, '（未選択）');
    // form.reset() で初期値に戻るよう defaultSelected を設定
    [...$('status').options].forEach((o) => { o.defaultSelected = o.value === INITIAL_STATUS; });
    [...$('counter_lawyer').options].forEach((o) => { o.defaultSelected = o.value === INITIAL_COUNTER_LAWYER; });

    $('key_issues').innerHTML = ISSUES.map((i) =>
        `<label><input type="checkbox" value="${escapeHtml(i)}"> ${escapeHtml(i)}</label>`).join('');

    fillSelect($('fStatus'), STATUSES, 'ステータス：すべて');
    fillSelect($('fIssue'), ISSUES, '争点：すべて');

    document.querySelectorAll('.nav-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (btn.dataset.view === 'form') openForm();
            else showView(btn.dataset.view);
        });
    });

    ['fSearch', 'fStatus', 'fLawyer', 'fIssue', 'fDeadline', 'fShowDone'].forEach((id) => {
        $(id).addEventListener(id === 'fSearch' ? 'input' : 'change', renderList);
    });

    document.querySelectorAll('[data-deadline-filter]').forEach((card) => {
        card.addEventListener('click', () => {
            $('fDeadline').value = card.dataset.deadlineFilter;
            renderList();
        });
    });

    $('statusChips').addEventListener('click', (e) => {
        const chip = e.target.closest('[data-status]');
        if (!chip) return;
        $('fStatus').value = $('fStatus').value === chip.dataset.status ? '' : chip.dataset.status;
        renderList();
    });

    document.querySelectorAll('#caseTable th[data-sort]').forEach((th) => {
        th.addEventListener('click', () => {
            if (sortKey === th.dataset.sort) sortDir = -sortDir;
            else { sortKey = th.dataset.sort; sortDir = 1; }
            renderList();
        });
    });

    $('caseRows').addEventListener('click', (e) => {
        const row = e.target.closest('tr[data-id]');
        if (row) openForm(row.dataset.id);
    });

    $('caseForm').addEventListener('submit', handleSubmit);
    $('caseForm').addEventListener('reset', () => setTimeout(clearErrors));
    $('cancelBtn').addEventListener('click', () => { editingId = null; showView('list'); });
    $('deleteBtn').addEventListener('click', handleDelete);

    $('staffForm').addEventListener('submit', addStaff);
    $('staffList').addEventListener('click', (e) => {
        const btn = e.target.closest('[data-remove]');
        if (btn) removeStaff(Number(btn.dataset.remove));
    });
    $('exportJson').addEventListener('click', exportJson);
    $('exportCsv').addEventListener('click', exportCsv);
    $('importJson').addEventListener('change', importJson);
    $('importPaste').addEventListener('click', () => {
        const text = $('importText').value.trim();
        if (text) restoreFromText(text);
        else showToast('バックアップのJSONを貼り付けてください。', true);
    });
    $('exportCopy').addEventListener('click', copyExport);
    $('exportSave').addEventListener('click', () => {
        if (exportFile) download(exportFile.filename, exportFile.content, exportFile.type);
    });
    $('exportClose').addEventListener('click', () => { $('exportPanel').hidden = true; });
    $('loadSamples').addEventListener('click', loadSamples);
    $('firstAdd').addEventListener('click', () => openForm());

    // 別タブでの変更を反映
    window.addEventListener('storage', (e) => {
        if (e.key !== CASES_KEY && e.key !== STAFF_KEY) return;
        cases = load(CASES_KEY, []);
        staff = load(STAFF_KEY, []);
        if (!$('view-list').hidden) renderList();
        if (!$('view-settings').hidden) renderStaff();
    });

    showView('list');
}

init();
