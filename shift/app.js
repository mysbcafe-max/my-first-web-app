/* シフト自動生成 — 画面側の処理(データ保存・フォーム・結果表示) */
(function () {
  'use strict';

  const S = window.ShiftScheduler;
  const STORAGE_KEY = 'shift-scheduler-v1';
  const WD = S.WEEKDAY_LABELS;
  const LEVELS = [1, 2, 3, 4, 5];
  const DEFAULT_LEVEL_NAMES = ['研修中', '一般', '中堅', 'リーダー', '店長代行'];

  // ---------------- 状態 ----------------

  const defaultSettings = () => ({
    startDate: '',
    endDate: '',
    levelNames: DEFAULT_LEVEL_NAMES.slice(),
    options: Object.assign({}, S.DEFAULT_OPTIONS),
  });

  // レベル n の呼び名。未設定・空欄なら既定に戻す
  function levelName(n) {
    const names = (state.settings && state.settings.levelNames) || [];
    const v = (names[n - 1] || '').trim();
    return v || DEFAULT_LEVEL_NAMES[n - 1] || '';
  }

  // 「3(中堅)」のような表示
  function levelLabel(n) {
    const name = levelName(n);
    return name ? `${n}(${name})` : String(n);
  }

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          employees: Array.isArray(parsed.employees) ? parsed.employees : [],
          stores: Array.isArray(parsed.stores) ? parsed.stores : [],
          settings: Object.assign(defaultSettings(), parsed.settings || {}),
          result: parsed.result || null,
        };
      }
    } catch (e) {
      console.warn('保存データを読み込めませんでした', e);
    }
    return { employees: [], stores: [], settings: defaultSettings(), result: null };
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      alert('ブラウザへの保存に失敗しました。プライベートモードや容量不足の可能性があります。');
    }
  }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // ---------------- ユーティリティ ----------------

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function storeName(id) {
    const s = state.stores.find((x) => x.id === id);
    return s ? s.name : '(削除済み店舗)';
  }

  function weekdayText(list) {
    if (!Array.isArray(list) || list.length === 0 || list.length === 7) return '毎日';
    return list.slice().sort().map((d) => WD[d]).join('・');
  }

  function parseDates(text) {
    return String(text || '')
      .split(/[\s,、]+/)
      .map((s) => s.trim().replace(/\//g, '-'))
      .filter((s) => /^\d{4}-\d{1,2}-\d{1,2}$/.test(s))
      .map((s) => {
        const [y, m, d] = s.split('-');
        return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
      });
  }

  function download(filename, content, type) {
    const blob = new Blob([content], { type: type || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function nextMonday() {
    const now = new Date();
    const today = S.formatDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
    const wd = S.weekdayOf(today);
    return S.addDays(today, ((8 - wd) % 7) || 7);
  }

  // ---------------- タブ ----------------

  function showTab(name) {
    $$('.tab').forEach((b) => {
      const on = b.dataset.tab === name;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    try { localStorage.setItem(STORAGE_KEY + ':tab', name); } catch (e) { /* ignore */ }
    if (name === 'employees') { renderLevelOptions(); renderEmployeeForm(); }
    if (name === 'stores') { renderLevelOptions(); renderStoreForm(); }
  }

  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------------- 曜日・店舗チェックボックス ----------------

  function renderWeekdayChecks(container, selected) {
    const name = container.dataset.weekdays;
    const sel = Array.isArray(selected) && selected.length ? selected.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    container.innerHTML = WD.map((label, i) =>
      `<label><input type="checkbox" name="${name}" value="${i}" ${sel.includes(i) ? 'checked' : ''}>${label}</label>`
    ).join('');
  }

  function renderStoreChecks(container, selected) {
    const name = container.dataset.storelist;
    const sel = Array.isArray(selected) ? selected : [];
    if (!state.stores.length) {
      container.innerHTML = '<small>店舗が未登録です。先に「店舗」タブで登録してください。</small>';
      return;
    }
    container.innerHTML = state.stores.map((s) =>
      `<label><input type="checkbox" name="${name}" value="${esc(s.id)}" ${sel.includes(s.id) ? 'checked' : ''}>${esc(s.name)}</label>`
    ).join('');
  }

  // レベルを選ぶ <select> の中身を、現在の呼び名で作り直す
  function renderLevelOptions() {
    $$('[data-level-options]').forEach((sel) => {
      const kind = sel.dataset.levelOptions;
      const keep = sel.value;
      let html = '';
      if (kind === 'leader') html += '<option value="0">不要</option>';
      LEVELS.forEach((n) => {
        if (kind === 'leader' && n === 1) return; // Lv1 以上は制約にならない
        const label = kind === 'employee' ? levelLabel(n) : `${levelLabel(n)} 以上`;
        html += `<option value="${n}">${esc(label)}</option>`;
      });
      sel.innerHTML = html;
      if (keep !== '') sel.value = keep;
    });
  }

  function checkedValues(form, name) {
    return $$(`input[name="${name}"]:checked`, form).map((i) => i.value);
  }

  // ---------------- 社員 ----------------

  const formEmployee = $('#form-employee');

  function renderEmployeeForm(emp) {
    const e = emp || {};
    formEmployee.reset();
    formEmployee.id.value = e.id || '';
    formEmployee.name.value = e.name || '';
    formEmployee.level.value = e.level || 3;
    formEmployee.address.value = e.address || '';
    formEmployee.lat.value = e.lat ?? '';
    formEmployee.lng.value = e.lng ?? '';
    formEmployee.maxDaysPerWeek.value = e.maxDaysPerWeek ?? 5;
    formEmployee.unavailableDates.value = (e.unavailableDates || []).join('\n');
    formEmployee.memo.value = e.memo || '';
    renderWeekdayChecks($('[data-weekdays="availableWeekdays"]', formEmployee), e.availableWeekdays);
    renderStoreChecks($('[data-storelist="ngStoreIds"]', formEmployee), e.ngStoreIds);
    renderStoreChecks($('[data-storelist="preferredStoreIds"]', formEmployee), e.preferredStoreIds);
    $('#employee-form-title').textContent = e.id ? `社員を編集: ${e.name}` : '社員を追加';
  }

  formEmployee.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formEmployee;
    const ng = checkedValues(f, 'ngStoreIds');
    const pref = checkedValues(f, 'preferredStoreIds').filter((id) => !ng.includes(id));
    const emp = {
      id: f.id.value || newId('e'),
      name: f.name.value.trim(),
      level: Number(f.level.value),
      address: f.address.value.trim(),
      lat: f.lat.value === '' ? null : Number(f.lat.value),
      lng: f.lng.value === '' ? null : Number(f.lng.value),
      maxDaysPerWeek: Number(f.maxDaysPerWeek.value),
      availableWeekdays: checkedValues(f, 'availableWeekdays').map(Number),
      unavailableDates: parseDates(f.unavailableDates.value),
      ngStoreIds: ng,
      preferredStoreIds: pref,
      memo: f.memo.value.trim(),
    };
    if (!emp.name) return;
    if (emp.availableWeekdays.length === 0) {
      alert('勤務可能な曜日を 1 つ以上選んでください。');
      return;
    }
    const idx = state.employees.findIndex((x) => x.id === emp.id);
    if (idx >= 0) state.employees[idx] = emp; else state.employees.push(emp);
    saveState();
    renderEmployeeForm();
    renderEmployees();
  });

  $('[data-action="reset-form"]', formEmployee).addEventListener('click', () => renderEmployeeForm());

  function renderEmployees() {
    const t = $('#table-employees');
    $('#count-employees').textContent = state.employees.length;
    if (!state.employees.length) {
      t.innerHTML = '<tr><td class="empty">社員が登録されていません。上のフォームから追加するか、「データ」タブでサンプルを読み込んでください。</td></tr>';
      return;
    }
    const rows = state.employees.map((e) => `
      <tr>
        <td>${esc(e.name)}</td>
        <td class="num"><span class="level" title="${esc(levelName(e.level))}">${esc(e.level)}</span> <small>${esc(levelName(e.level))}</small></td>
        <td>${esc(e.address)}${e.lat != null && e.lng != null ? ' <small>(座標あり)</small>' : ''}</td>
        <td class="num">${esc(e.maxDaysPerWeek)}</td>
        <td>${esc(weekdayText(e.availableWeekdays))}</td>
        <td>${(e.unavailableDates || []).map((d) => `<span class="chip">${esc(d)}</span>`).join('') || '<small>—</small>'}</td>
        <td>${(e.ngStoreIds || []).map((id) => `<span class="chip chip--ng">${esc(storeName(id))}</span>`).join('') || '<small>—</small>'}</td>
        <td>${(e.preferredStoreIds || []).map((id) => `<span class="chip chip--pref">${esc(storeName(id))}</span>`).join('') || '<small>—</small>'}</td>
        <td>${esc(e.memo)}</td>
        <td class="actions">
          <button class="btn btn-sm" data-edit="${esc(e.id)}">編集</button>
          <button class="btn btn-sm" data-delete="${esc(e.id)}">削除</button>
        </td>
      </tr>`).join('');
    t.innerHTML = `
      <thead><tr><th>名前</th><th>Lv</th><th>住所</th><th>週上限</th><th>勤務可能曜日</th><th>希望休</th><th>NG店舗</th><th>希望店舗</th><th>メモ</th><th></th></tr></thead>
      <tbody>${rows}</tbody>`;
  }

  $('#table-employees').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.edit) {
      renderEmployeeForm(state.employees.find((x) => x.id === btn.dataset.edit));
      formEmployee.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (btn.dataset.delete) {
      const e = state.employees.find((x) => x.id === btn.dataset.delete);
      if (e && confirm(`「${e.name}」を削除しますか?`)) {
        state.employees = state.employees.filter((x) => x.id !== e.id);
        saveState();
        renderEmployees();
      }
    }
  });

  // ---------------- 店舗 ----------------

  const formStore = $('#form-store');

  function renderStoreForm(store) {
    const s = store || {};
    formStore.reset();
    formStore.id.value = s.id || '';
    formStore.name.value = s.name || '';
    formStore.requiredStaff.value = s.requiredStaff ?? 2;
    formStore.address.value = s.address || '';
    formStore.lat.value = s.lat ?? '';
    formStore.lng.value = s.lng ?? '';
    formStore.minLevel.value = s.minLevel || 1;
    formStore.leaderLevel.value = s.leaderLevel || 0;
    formStore.memo.value = s.memo || '';
    renderWeekdayChecks($('[data-weekdays="openWeekdays"]', formStore), s.openWeekdays);
    $('#store-form-title').textContent = s.id ? `店舗を編集: ${s.name}` : '店舗を追加';
  }

  formStore.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formStore;
    const store = {
      id: f.id.value || newId('s'),
      name: f.name.value.trim(),
      requiredStaff: Number(f.requiredStaff.value),
      address: f.address.value.trim(),
      lat: f.lat.value === '' ? null : Number(f.lat.value),
      lng: f.lng.value === '' ? null : Number(f.lng.value),
      minLevel: Number(f.minLevel.value),
      leaderLevel: Number(f.leaderLevel.value),
      openWeekdays: checkedValues(f, 'openWeekdays').map(Number),
      memo: f.memo.value.trim(),
    };
    if (!store.name) return;
    if (store.openWeekdays.length === 0) {
      alert('営業日を 1 つ以上選んでください。');
      return;
    }
    const idx = state.stores.findIndex((x) => x.id === store.id);
    if (idx >= 0) state.stores[idx] = store; else state.stores.push(store);
    saveState();
    renderStoreForm();
    renderStores();
  });

  $('[data-action="reset-form"]', formStore).addEventListener('click', () => renderStoreForm());

  function renderStores() {
    const t = $('#table-stores');
    $('#count-stores').textContent = state.stores.length;
    if (!state.stores.length) {
      t.innerHTML = '<tr><td class="empty">店舗が登録されていません。上のフォームから追加してください。</td></tr>';
      return;
    }
    const rows = state.stores.map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${esc(s.address)}${s.lat != null && s.lng != null ? ' <small>(座標あり)</small>' : ''}</td>
        <td class="num">${esc(s.requiredStaff)} 名</td>
        <td class="num" title="${esc(levelName(s.minLevel))}">${esc(s.minLevel)} 以上</td>
        <td class="num" title="${s.leaderLevel ? esc(levelName(s.leaderLevel)) : ''}">${s.leaderLevel ? esc(s.leaderLevel) + ' 以上' : '<small>—</small>'}</td>
        <td>${esc(weekdayText(s.openWeekdays))}</td>
        <td>${esc(s.memo)}</td>
        <td class="actions">
          <button class="btn btn-sm" data-edit="${esc(s.id)}">編集</button>
          <button class="btn btn-sm" data-delete="${esc(s.id)}">削除</button>
        </td>
      </tr>`).join('');
    t.innerHTML = `
      <thead><tr><th>店舗名</th><th>住所</th><th>必要人数/日</th><th>必要Lv</th><th>リーダー</th><th>営業日</th><th>メモ</th><th></th></tr></thead>
      <tbody>${rows}</tbody>`;
  }

  $('#table-stores').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.edit) {
      renderStoreForm(state.stores.find((x) => x.id === btn.dataset.edit));
      formStore.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (btn.dataset.delete) {
      const s = state.stores.find((x) => x.id === btn.dataset.delete);
      if (s && confirm(`「${s.name}」を削除しますか?\n社員の NG店舗・希望店舗からも外れます。`)) {
        state.stores = state.stores.filter((x) => x.id !== s.id);
        state.employees.forEach((e) => {
          e.ngStoreIds = (e.ngStoreIds || []).filter((id) => id !== s.id);
          e.preferredStoreIds = (e.preferredStoreIds || []).filter((id) => id !== s.id);
        });
        saveState();
        renderStores();
        renderEmployees();
      }
    }
  });

  // ---------------- シフト生成 ----------------

  const formGenerate = $('#form-generate');

  function renderGenerateForm() {
    const st = state.settings;
    formGenerate.startDate.value = st.startDate || nextMonday();
    formGenerate.endDate.value = st.endDate || S.addDays(formGenerate.startDate.value, 6);
    const o = Object.assign({}, S.DEFAULT_OPTIONS, st.options || {});
    ['maxDistanceKm', 'maxConsecutiveDays', 'weightDistance', 'weightFairness', 'weightPreferred', 'weightContinuity', 'weightOverLevel']
      .forEach((k) => { formGenerate[k].value = o[k]; });
  }

  formGenerate.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formGenerate;
    const options = {};
    ['maxDistanceKm', 'maxConsecutiveDays', 'weightDistance', 'weightFairness', 'weightPreferred', 'weightContinuity', 'weightOverLevel']
      .forEach((k) => { options[k] = Number(f[k].value); });
    const startDate = f.startDate.value;
    const endDate = f.endDate.value;
    const status = $('#generate-status');
    if (endDate < startDate) {
      status.textContent = '終了日は開始日以降にしてください。';
      return;
    }
    if (S.eachDate(startDate, endDate).length > 92) {
      status.textContent = '期間は 92 日(約 3 か月)以内にしてください。';
      return;
    }
    state.settings = { startDate, endDate, options };
    const t0 = performance.now();
    state.result = S.generate({ employees: state.employees, stores: state.stores, startDate, endDate, options });
    saveState();
    status.textContent = `生成しました(${Math.round(performance.now() - t0)} ms)`;
    renderResult();
  });

  function renderResult() {
    const r = state.result;
    const box = $('#result');
    if (!r) { box.hidden = true; return; }
    box.hidden = false;
    $('#result-period').textContent = `${r.startDate} 〜 ${r.endDate}(${r.dates.length} 日)`;

    // 警告
    const groups = { error: [], warn: [], info: [] };
    r.warnings.forEach((w) => groups[w.level].push(w.message));
    const titles = { error: '人数が足りない日があります', warn: '注意', info: '参考情報' };
    let html = '';
    ['error', 'warn', 'info'].forEach((lv) => {
      if (!groups[lv].length) return;
      html += `<div class="alert alert--${lv}"><strong>${titles[lv]}(${groups[lv].length} 件)</strong><ul>${groups[lv].map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
    });
    if (!groups.error.length && !groups.warn.length && r.days.length) {
      html = '<div class="alert alert--ok">すべての店舗・日程で必要人数を満たしました。</div>' + html;
    }
    $('#result-warnings').innerHTML = html;

    // 店舗 × 日付
    const storeIds = state.stores.map((s) => s.id).filter((id) => r.storeStats[id]);
    const head = '<tr><th class="store">店舗</th>' + r.days.map((d) => {
      const cls = d.weekday === 6 ? 'sat' : d.weekday === 0 ? 'sun' : '';
      return `<th class="date ${cls}">${esc(d.date.slice(5).replace('-', '/'))}<br><small>${esc(d.weekdayLabel)}</small></th>`;
    }).join('') + '</tr>';
    const body = storeIds.map((id) => {
      const cells = r.days.map((d) => {
        const cls = d.weekday === 6 ? 'sat' : d.weekday === 0 ? 'sun' : '';
        const s = d.stores.find((x) => x.storeId === id);
        if (!s) return `<td class="closed ${cls}">定休</td>`;
        let inner = s.assigned.map((a) =>
          `<span class="name">${esc(a.name)} <small title="${esc(levelName(a.level))}・${esc(S.methodLabel(a.method))}">Lv${esc(a.level)}・${esc(a.km)}km</small></span>`
        ).join('');
        if (s.shortage > 0) inner += `<span class="shortage">${s.shortage} 名不足</span>`;
        if (s.leaderMissing) inner += '<span class="leader-missing">リーダー不在</span>';
        return `<td class="${cls} ${s.shortage > 0 ? 'short' : ''}">${inner}</td>`;
      }).join('');
      return `<tr><th class="store">${esc(r.storeStats[id].name)}<br><small>${esc(r.storeStats[id].filled)}/${esc(r.storeStats[id].required)} 枠</small></th>${cells}</tr>`;
    }).join('');
    $('#result-matrix').innerHTML = `<thead>${head}</thead><tbody>${body || '<tr><td class="empty">営業日がありません</td></tr>'}</tbody>`;

    // 社員別
    const empRows = state.employees.map((e) => {
      const st = r.employeeStats[e.id];
      if (!st) return '';
      const stores = Object.entries(st.storeCounts).map(([sid, n]) => `${esc(storeName(sid))} ×${n}`).join('、') || '<small>—</small>';
      const dates = st.dates.map((x) => `<span class="chip" title="${esc(storeName(x.storeId))}">${esc(x.date.slice(5).replace('-', '/'))}</span>`).join('');
      return `<tr><td>${esc(e.name)}</td><td class="num"><span class="level" title="${esc(levelName(e.level))}">${esc(e.level)}</span></td><td class="num">${st.days} 日</td><td class="num">${st.km} km</td><td>${stores}</td><td>${dates || '<small>—</small>'}</td></tr>`;
    }).join('');
    $('#result-employees').innerHTML = `<thead><tr><th>社員</th><th>Lv</th><th>出勤日数</th><th>合計距離(片道)</th><th>店舗</th><th>出勤日</th></tr></thead><tbody>${empRows}</tbody>`;

    // 店舗別
    const storeRows = storeIds.map((id) => {
      const st = r.storeStats[id];
      const rate = st.required ? Math.round((st.filled / st.required) * 100) : 100;
      return `<tr><td>${esc(st.name)}</td><td class="num">${st.required}</td><td class="num">${st.filled}</td><td class="num">${st.required - st.filled}</td><td class="num">${rate}%</td></tr>`;
    }).join('');
    $('#result-stores').innerHTML = `<thead><tr><th>店舗</th><th>必要枠</th><th>充足</th><th>不足</th><th>充足率</th></tr></thead><tbody>${storeRows}</tbody>`;
  }

  $('#btn-csv-list').addEventListener('click', () => {
    if (!state.result) return;
    download(`shift_${state.result.startDate}_${state.result.endDate}_list.csv`, S.toCSV(state.result), 'text/csv;charset=utf-8');
  });
  $('#btn-csv-matrix').addEventListener('click', () => {
    if (!state.result) return;
    download(`shift_${state.result.startDate}_${state.result.endDate}_matrix.csv`, S.toMatrixCSV(state.result), 'text/csv;charset=utf-8');
  });
  $('#btn-print').addEventListener('click', () => window.print());

  // ---------------- データ ----------------

  const formLevels = $('#form-levels');

  function renderLevelSettings() {
    $('#level-names').innerHTML = LEVELS.map((n) =>
      `<label><span class="level">${n}</span><input type="text" name="level${n}" maxlength="20" value="${esc(levelName(n))}" placeholder="${esc(DEFAULT_LEVEL_NAMES[n - 1])}"></label>`
    ).join('');
  }

  formLevels.addEventListener('submit', (ev) => {
    ev.preventDefault();
    state.settings.levelNames = LEVELS.map((n) => formLevels['level' + n].value.trim());
    saveState();
    renderAll();
    $('#levels-status').textContent = '保存しました';
    setTimeout(() => { $('#levels-status').textContent = ''; }, 3000);
  });

  $('#btn-levels-reset').addEventListener('click', () => {
    state.settings.levelNames = DEFAULT_LEVEL_NAMES.slice();
    saveState();
    renderAll();
    $('#levels-status').textContent = '既定に戻しました';
    setTimeout(() => { $('#levels-status').textContent = ''; }, 3000);
  });

  $('#btn-export').addEventListener('click', () => {
    const data = { version: 1, exportedAt: new Date().toISOString(), employees: state.employees, stores: state.stores, settings: state.settings };
    download(`shift-data_${S.formatDate(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
  });

  $('#input-import').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!Array.isArray(data.employees) || !Array.isArray(data.stores)) throw new Error('形式が違います');
        if (!confirm(`社員 ${data.employees.length} 名・店舗 ${data.stores.length} 店を読み込みます。現在のデータは置き換えられます。よろしいですか?`)) return;
        state = {
          employees: data.employees,
          stores: data.stores,
          settings: Object.assign(defaultSettings(), data.settings || {}),
          result: null,
        };
        saveState();
        renderAll();
        alert('読み込みました。');
      } catch (e) {
        alert('JSON を読み込めませんでした: ' + e.message);
      } finally {
        ev.target.value = '';
      }
    };
    reader.readAsText(file);
  });

  $('#btn-sample').addEventListener('click', () => {
    if (state.employees.length || state.stores.length) {
      if (!confirm('現在のデータをサンプルで置き換えます。よろしいですか?')) return;
    }
    state = sampleData();
    saveState();
    renderAll();
    showTab('generate');
  });

  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('このブラウザに保存された社員・店舗・生成結果をすべて削除します。元に戻せません。よろしいですか?')) return;
    state = { employees: [], stores: [], settings: defaultSettings(), result: null };
    saveState();
    renderAll();
  });

  function sampleData() {
    const stores = [
      { id: 's-shinjuku', name: '新宿西口店', address: '東京都新宿区西新宿1-1-3', lat: 35.6896, lng: 139.6995, requiredStaff: 2, minLevel: 1, leaderLevel: 4, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '旗艦店。1 名は Lv4 以上' },
      { id: 's-shibuya', name: '渋谷センター街店', address: '東京都渋谷区宇田川町25-1', lat: 35.6614, lng: 139.6982, requiredStaff: 2, minLevel: 2, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '新規契約が多いため Lv2 以上' },
      { id: 's-yokohama', name: '横浜みなとみらい店', address: '神奈川県横浜市西区みなとみらい2-2-1', lat: 35.4571, lng: 139.6329, requiredStaff: 2, minLevel: 1, leaderLevel: 3, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '1 名は Lv3 以上' },
      { id: 's-kawasaki', name: '川崎駅前店', address: '神奈川県川崎市川崎区駅前本町26-1', lat: 35.5308, lng: 139.6970, requiredStaff: 1, minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '' },
      { id: 's-omiya', name: '大宮店', address: '埼玉県さいたま市大宮区桜木町1-7-5', lat: 35.9064, lng: 139.6238, requiredStaff: 1, minLevel: 3, leaderLevel: 0, openWeekdays: [1, 2, 3, 4, 5], memo: '平日のみ営業。ひとり体制のため Lv3 以上' },
    ];
    const employees = [
      { id: 'e01', name: '佐藤 一郎', address: '東京都新宿区北新宿3-1-1', lat: 35.7030, lng: 139.6930, level: 5, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: ['s-shinjuku'], memo: '店長代行。日曜は不可' },
      { id: 'e02', name: '鈴木 花子', address: '東京都渋谷区神宮前6-1-1', lat: 35.6690, lng: 139.7050, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: ['s-omiya'], preferredStoreIds: ['s-shibuya'], memo: '' },
      { id: 'e03', name: '高橋 健', address: '神奈川県横浜市神奈川区鶴屋町2-1', lat: 35.4680, lng: 139.6210, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: ['s-omiya'], preferredStoreIds: ['s-yokohama'], memo: '' },
      { id: 'e04', name: '田中 美咲', address: '埼玉県さいたま市浦和区高砂1-1-1', lat: 35.8617, lng: 139.6455, level: 3, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5], unavailableDates: [], ngStoreIds: ['s-yokohama', 's-kawasaki'], preferredStoreIds: ['s-omiya'], memo: '育児のため土日は不可' },
      { id: 'e05', name: '伊藤 翔', address: '東京都中野区中野4-1-1', lat: 35.7070, lng: 139.6650, level: 3, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: [], memo: '' },
      { id: 'e06', name: '渡辺 さくら', address: '東京都世田谷区三軒茶屋1-1-1', lat: 35.6430, lng: 139.6690, level: 2, maxDaysPerWeek: 3, availableWeekdays: [0, 3, 6], unavailableDates: [], ngStoreIds: ['s-omiya'], preferredStoreIds: ['s-shibuya'], memo: '学生。水・土・日のみ、週3まで' },
      { id: 'e07', name: '山本 大輔', address: '神奈川県川崎市川崎区砂子1-1-1', lat: 35.5310, lng: 139.6970, level: 2, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: ['s-kawasaki'], memo: '' },
      { id: 'e08', name: '中村 結衣', address: '東京都豊島区南池袋1-1-1', lat: 35.7280, lng: 139.7130, level: 1, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: ['s-yokohama', 's-omiya'], preferredStoreIds: [], memo: '研修中。Lv2 以上の店舗には入れない' },
      { id: 'e09', name: '小林 直人', address: '神奈川県横浜市港北区新横浜2-1-1', lat: 35.5070, lng: 139.6170, level: 3, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: ['s-yokohama'], memo: '' },
      { id: 'e10', name: '加藤 恵', address: '東京都杉並区荻窪5-1-1', lat: 35.7040, lng: 139.6200, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: [], memo: '本業あり。金・土・日のみ' },
      { id: 'e11', name: '吉田 亮', address: '神奈川県川崎市中原区小杉町3-1-1', lat: 35.5760, lng: 139.6590, level: 2, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: ['s-omiya'], preferredStoreIds: [], memo: '' },
      { id: 'e12', name: '松本 由紀', address: '神奈川県横浜市西区北幸1-1-1', lat: 35.4650, lng: 139.6200, level: 5, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: ['s-omiya'], preferredStoreIds: ['s-yokohama'], memo: 'ベテラン。横浜エリア中心' },
    ];
    // 希望休のサンプル(生成期間の初日+2日)
    const start = nextMonday();
    employees[1].unavailableDates = [S.addDays(start, 2)];          // 鈴木: 水曜に希望休
    employees[4].unavailableDates = [S.addDays(start, 4), S.addDays(start, 5)]; // 伊藤: 金土に希望休
    return {
      employees,
      stores,
      settings: Object.assign(defaultSettings(), { startDate: start, endDate: S.addDays(start, 6) }),
      result: null,
    };
  }

  // ---------------- 初期化 ----------------

  function renderAll() {
    renderLevelOptions();
    renderLevelSettings();
    renderEmployees();
    renderStores();
    renderEmployeeForm();
    renderStoreForm();
    renderGenerateForm();
    renderResult();
  }

  renderAll();
  let initialTab = 'generate';
  try { initialTab = localStorage.getItem(STORAGE_KEY + ':tab') || 'generate'; } catch (e) { /* ignore */ }
  if (!state.employees.length && !state.stores.length) initialTab = 'data';
  showTab(initialTab);
})();
