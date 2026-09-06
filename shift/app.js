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

  let state = loadState();

  // 旧データ(店舗モデル)を案件モデルに読み替える
  function migrate(parsed) {
    const projects = Array.isArray(parsed.projects) ? parsed.projects
      : Array.isArray(parsed.stores) ? parsed.stores.map((s) => Object.assign({}, s, { startDate: '', endDate: '', requiredAvgLevel: 0 }))
      : [];
    const employees = (Array.isArray(parsed.employees) ? parsed.employees : []).map((e) => {
      const o = Object.assign({}, e);
      if (!o.ngProjectIds && o.ngStoreIds) o.ngProjectIds = o.ngStoreIds;
      if (!o.preferredProjectIds && o.preferredStoreIds) o.preferredProjectIds = o.preferredStoreIds;
      delete o.ngStoreIds;
      delete o.preferredStoreIds;
      return o;
    });
    return { employees, projects };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        const m = migrate(parsed);
        return {
          employees: m.employees,
          projects: m.projects,
          settings: Object.assign(defaultSettings(), parsed.settings || {}),
          result: null, // モデル変更のため保存済みの結果は使わない
        };
      }
    } catch (e) {
      console.warn('保存データを読み込めませんでした', e);
    }
    return { employees: [], projects: [], settings: defaultSettings(), result: null };
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

  function levelName(n) {
    const names = (state.settings && state.settings.levelNames) || [];
    const v = (names[n - 1] || '').trim();
    return v || DEFAULT_LEVEL_NAMES[n - 1] || '';
  }

  function levelLabel(n) {
    const name = levelName(n);
    return name ? `${n}(${name})` : String(n);
  }

  function projectName(id) {
    const p = state.projects.find((x) => x.id === id);
    return p ? p.name : '(削除済みの案件)';
  }

  function weekdayText(list) {
    if (!Array.isArray(list) || list.length === 0 || list.length === 7) return '毎日';
    return list.slice().sort().map((d) => WD[d]).join('・');
  }

  function periodText(p) {
    if (!p.startDate && !p.endDate) return '常設';
    const md = (d) => (d ? d.slice(5).replace('-', '/') : '');
    if (p.startDate && p.endDate) {
      const days = S.eachDate(p.startDate, p.endDate).length;
      return `${md(p.startDate)} 〜 ${md(p.endDate)}(${days}日)`;
    }
    return p.startDate ? `${md(p.startDate)} 〜` : `〜 ${md(p.endDate)}`;
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
    if (name === 'projects') { renderLevelOptions(); renderProjectForm(); }
  }

  $$('.tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------------- チェックボックス・選択肢 ----------------

  function renderWeekdayChecks(container, selected) {
    const name = container.dataset.weekdays;
    const sel = Array.isArray(selected) && selected.length ? selected.map(Number) : [0, 1, 2, 3, 4, 5, 6];
    container.innerHTML = WD.map((label, i) =>
      `<label><input type="checkbox" name="${name}" value="${i}" ${sel.includes(i) ? 'checked' : ''}>${label}</label>`
    ).join('');
  }

  function renderProjectChecks(container, selected) {
    const name = container.dataset.projectlist;
    const sel = Array.isArray(selected) ? selected : [];
    if (!state.projects.length) {
      container.innerHTML = '<small>案件が未登録です。先に「案件」タブで登録してください。</small>';
      return;
    }
    container.innerHTML = state.projects.map((p) =>
      `<label><input type="checkbox" name="${name}" value="${esc(p.id)}" ${sel.includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`
    ).join('');
  }

  function renderLevelOptions() {
    $$('[data-level-options]').forEach((sel) => {
      const kind = sel.dataset.levelOptions;
      const keep = sel.value;
      let html = '';
      if (kind === 'leader') html += '<option value="0">不要</option>';
      LEVELS.forEach((n) => {
        if (kind === 'leader' && n === 1) return;
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

  // ---------------- スタッフ ----------------

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
    renderProjectChecks($('[data-projectlist="ngProjectIds"]', formEmployee), e.ngProjectIds);
    renderProjectChecks($('[data-projectlist="preferredProjectIds"]', formEmployee), e.preferredProjectIds);
    $('#employee-form-title').textContent = e.id ? `スタッフを編集: ${e.name}` : 'スタッフを追加';
  }

  formEmployee.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formEmployee;
    const ng = checkedValues(f, 'ngProjectIds');
    const pref = checkedValues(f, 'preferredProjectIds').filter((id) => !ng.includes(id));
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
      ngProjectIds: ng,
      preferredProjectIds: pref,
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
      t.innerHTML = '<tr><td class="empty">スタッフが登録されていません。上のフォームから追加するか、「データ」タブでサンプルを読み込んでください。</td></tr>';
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
        <td>${(e.ngProjectIds || []).map((id) => `<span class="chip chip--ng">${esc(projectName(id))}</span>`).join('') || '<small>—</small>'}</td>
        <td>${(e.preferredProjectIds || []).map((id) => `<span class="chip chip--pref">${esc(projectName(id))}</span>`).join('') || '<small>—</small>'}</td>
        <td>${esc(e.memo)}</td>
        <td class="actions">
          <button class="btn btn-sm" data-edit="${esc(e.id)}">編集</button>
          <button class="btn btn-sm" data-delete="${esc(e.id)}">削除</button>
        </td>
      </tr>`).join('');
    t.innerHTML = `
      <thead><tr><th>名前</th><th>Lv</th><th>住所</th><th>週上限</th><th>勤務可能曜日</th><th>希望休</th><th>NG案件</th><th>希望案件</th><th>メモ</th><th></th></tr></thead>
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

  // ---------------- 案件 ----------------

  const formProject = $('#form-project');

  function renderProjectForm(project) {
    const p = project || {};
    formProject.reset();
    formProject.id.value = p.id || '';
    formProject.name.value = p.name || '';
    formProject.requiredStaff.value = p.requiredStaff ?? 2;
    formProject.startDate.value = p.startDate || '';
    formProject.endDate.value = p.endDate || '';
    formProject.address.value = p.address || '';
    formProject.lat.value = p.lat ?? '';
    formProject.lng.value = p.lng ?? '';
    formProject.requiredAvgLevel.value = p.requiredAvgLevel ?? 0;
    formProject.minLevel.value = p.minLevel || 1;
    formProject.leaderLevel.value = p.leaderLevel || 0;
    formProject.memo.value = p.memo || '';
    renderWeekdayChecks($('[data-weekdays="openWeekdays"]', formProject), p.openWeekdays);
    $('#project-form-title').textContent = p.id ? `案件を編集: ${p.name}` : '案件を追加';
  }

  formProject.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formProject;
    const project = {
      id: f.id.value || newId('p'),
      name: f.name.value.trim(),
      requiredStaff: Number(f.requiredStaff.value),
      startDate: f.startDate.value,
      endDate: f.endDate.value,
      address: f.address.value.trim(),
      lat: f.lat.value === '' ? null : Number(f.lat.value),
      lng: f.lng.value === '' ? null : Number(f.lng.value),
      requiredAvgLevel: Number(f.requiredAvgLevel.value),
      minLevel: Number(f.minLevel.value),
      leaderLevel: Number(f.leaderLevel.value),
      openWeekdays: checkedValues(f, 'openWeekdays').map(Number),
      memo: f.memo.value.trim(),
    };
    if (!project.name) return;
    if (project.openWeekdays.length === 0) {
      alert('稼働曜日を 1 つ以上選んでください。');
      return;
    }
    if (project.startDate && project.endDate && project.endDate < project.startDate) {
      alert('終了日は開始日以降にしてください。');
      return;
    }
    const idx = state.projects.findIndex((x) => x.id === project.id);
    if (idx >= 0) state.projects[idx] = project; else state.projects.push(project);
    saveState();
    renderProjectForm();
    renderProjects();
  });

  $('[data-action="reset-form"]', formProject).addEventListener('click', () => renderProjectForm());

  function renderProjects() {
    const t = $('#table-projects');
    $('#count-projects').textContent = state.projects.length;
    if (!state.projects.length) {
      t.innerHTML = '<tr><td class="empty">案件が登録されていません。上のフォームから追加してください。</td></tr>';
      return;
    }
    const rows = state.projects.map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${esc(periodText(p))}</td>
        <td>${esc(p.address)}${p.lat != null && p.lng != null ? ' <small>(座標あり)</small>' : ''}</td>
        <td class="num">${esc(p.requiredStaff)} 名</td>
        <td class="num">${p.requiredAvgLevel > 0 ? esc(p.requiredAvgLevel) + ' 以上' : '<small>不問</small>'}</td>
        <td class="num" title="${esc(levelName(p.minLevel))}">${esc(p.minLevel)} 以上</td>
        <td class="num" title="${p.leaderLevel ? esc(levelName(p.leaderLevel)) : ''}">${p.leaderLevel ? esc(p.leaderLevel) + ' 以上' : '<small>—</small>'}</td>
        <td>${esc(weekdayText(p.openWeekdays))}</td>
        <td>${esc(p.memo)}</td>
        <td class="actions">
          <button class="btn btn-sm" data-edit="${esc(p.id)}">編集</button>
          <button class="btn btn-sm" data-copy="${esc(p.id)}" title="同じ条件で新しい案件を作る">複製</button>
          <button class="btn btn-sm" data-delete="${esc(p.id)}">削除</button>
        </td>
      </tr>`).join('');
    t.innerHTML = `
      <thead><tr><th>案件名</th><th>期間</th><th>現場の住所</th><th>必要人数/日</th><th>平均必要Lv</th><th>最低Lv</th><th>リーダー</th><th>稼働曜日</th><th>メモ</th><th></th></tr></thead>
      <tbody>${rows}</tbody>`;
  }

  $('#table-projects').addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    if (btn.dataset.edit) {
      renderProjectForm(state.projects.find((x) => x.id === btn.dataset.edit));
      formProject.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (btn.dataset.copy) {
      // 受注のたびに似た案件を登録するため、条件をコピーして日付だけ入れ替えられるようにする
      const p = state.projects.find((x) => x.id === btn.dataset.copy);
      if (!p) return;
      const copy = Object.assign({}, p, { id: '', name: p.name + '(コピー)', startDate: '', endDate: '' });
      renderProjectForm(copy);
      formProject.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (btn.dataset.delete) {
      const p = state.projects.find((x) => x.id === btn.dataset.delete);
      if (p && confirm(`「${p.name}」を削除しますか?\nスタッフの NG案件・希望案件からも外れます。`)) {
        state.projects = state.projects.filter((x) => x.id !== p.id);
        state.employees.forEach((e) => {
          e.ngProjectIds = (e.ngProjectIds || []).filter((id) => id !== p.id);
          e.preferredProjectIds = (e.preferredProjectIds || []).filter((id) => id !== p.id);
        });
        saveState();
        renderProjects();
        renderEmployees();
      }
    }
  });

  // ---------------- シフト生成 ----------------

  const formGenerate = $('#form-generate');
  const OPTION_KEYS = ['maxDistanceKm', 'maxConsecutiveDays', 'weightDistance', 'weightFairness',
    'weightPreferred', 'weightContinuity', 'weightCore', 'weightCoverage', 'weightOverLevel'];

  function renderGenerateForm() {
    const st = state.settings;
    const fit = S.suggestPeriod(state.projects);
    formGenerate.startDate.value = st.startDate || (fit ? fit.startDate : nextMonday());
    formGenerate.endDate.value = st.endDate || (fit ? fit.endDate : S.addDays(formGenerate.startDate.value, 6));
    const o = Object.assign({}, S.DEFAULT_OPTIONS, st.options || {});
    OPTION_KEYS.forEach((k) => { if (formGenerate[k]) formGenerate[k].value = o[k]; });
  }

  $('#btn-fit-period').addEventListener('click', () => {
    const fit = S.suggestPeriod(state.projects);
    if (!fit) {
      alert('期間が入力された案件がありません。');
      return;
    }
    formGenerate.startDate.value = fit.startDate;
    formGenerate.endDate.value = fit.endDate;
  });

  formGenerate.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = formGenerate;
    const options = {};
    OPTION_KEYS.forEach((k) => { if (f[k]) options[k] = Number(f[k].value); });
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
    state.settings = Object.assign({}, state.settings, { startDate, endDate, options });
    const t0 = performance.now();
    state.result = S.generate({ employees: state.employees, projects: state.projects, startDate, endDate, options });
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

    const groups = { error: [], warn: [], info: [] };
    r.warnings.forEach((w) => groups[w.level].push(w.message));
    const titles = { error: '対応が必要です', warn: '注意', info: '参考情報' };
    let html = '';
    ['error', 'warn', 'info'].forEach((lv) => {
      if (!groups[lv].length) return;
      html += `<div class="alert alert--${lv}"><strong>${titles[lv]}(${groups[lv].length} 件)</strong><ul>${groups[lv].map((m) => `<li>${esc(m)}</li>`).join('')}</ul></div>`;
    });
    if (!groups.error.length && !groups.warn.length && r.days.length) {
      html = '<div class="alert alert--ok">すべての案件・日程で必要人数と平均レベルを満たしました。</div>' + html;
    }
    $('#result-warnings').innerHTML = html;

    // 案件 × 日付
    const ids = state.projects.map((p) => p.id).filter((id) => r.projectStats[id] && r.projectStats[id].activeDays > 0);
    const head = '<tr><th class="store">案件</th>' + r.days.map((d) => {
      const cls = d.weekday === 6 ? 'sat' : d.weekday === 0 ? 'sun' : '';
      return `<th class="date ${cls}">${esc(d.date.slice(5).replace('-', '/'))}<br><small>${esc(d.weekdayLabel)}</small></th>`;
    }).join('') + '</tr>';
    const body = ids.map((id) => {
      const ps = r.projectStats[id];
      const cells = r.days.map((d) => {
        const cls = d.weekday === 6 ? 'sat' : d.weekday === 0 ? 'sun' : '';
        const p = d.projects.find((x) => x.projectId === id);
        if (!p) return `<td class="closed ${cls}">—</td>`;
        let inner = p.assigned.map((a) =>
          `<span class="name">${a.core ? '' : '<em class="sub" title="交代要員">△</em>'}${esc(a.name)} <small title="${esc(levelName(a.level))}・${esc(S.methodLabel(a.method))}">Lv${esc(a.level)}・${esc(a.km)}km</small></span>`
        ).join('');
        if (p.requiredAvgLevel > 0) {
          inner += `<span class="avg ${p.avgShort ? 'avg--short' : ''}">平均 ${esc(p.avgLevel)}${p.avgShort ? ` / 必要 ${esc(p.requiredAvgLevel)}` : ''}</span>`;
        }
        if (p.shortage > 0) inner += `<span class="shortage">${p.shortage} 名不足</span>`;
        if (p.leaderMissing) inner += '<span class="leader-missing">リーダー不在</span>';
        return `<td class="${cls} ${p.shortage > 0 || p.avgShort ? 'short' : ''}">${inner}</td>`;
      }).join('');
      return `<tr><th class="store">${esc(ps.name)}<br><small>${esc(ps.filled)}/${esc(ps.required)} 枠</small></th>${cells}</tr>`;
    }).join('');
    $('#result-matrix').innerHTML = `<thead>${head}</thead><tbody>${body || '<tr><td class="empty">この期間に稼働する案件がありません</td></tr>'}</tbody>`;

    // 案件別のまとめ
    const projectRows = ids.map((id) => {
      const ps = r.projectStats[id];
      const rate = ps.required ? Math.round((ps.filled / ps.required) * 100) : 100;
      const coreNames = ps.coreMembers.map((m) => esc(m.name)).join('、') || '<small>—</small>';
      const avgCls = ps.requiredAvgLevel > 0 && ps.avgLevel < ps.requiredAvgLevel ? ' class="bad"' : '';
      return `<tr>
        <td>${esc(ps.name)}</td>
        <td>${esc(periodText(ps))}</td>
        <td class="num">${ps.activeDays} 日</td>
        <td class="num">${ps.required}</td>
        <td class="num">${ps.filled}</td>
        <td class="num">${rate}%</td>
        <td class="num"${avgCls}>${ps.avgLevel || '—'}${ps.requiredAvgLevel > 0 ? ` <small>/ 必要 ${esc(ps.requiredAvgLevel)}</small>` : ''}</td>
        <td>${coreNames}</td>
        <td class="num">${ps.distinctStaff} 名 <small>(継続 ${Math.round(ps.continuity * 100)}%)</small></td>
      </tr>`;
    }).join('');
    $('#result-projects').innerHTML = `<thead><tr><th>案件</th><th>期間</th><th>稼働日</th><th>必要枠</th><th>充足</th><th>充足率</th><th>平均Lv</th><th>コアメンバー</th><th>のべ担当</th></tr></thead><tbody>${projectRows}</tbody>`;

    // スタッフ別
    const empRows = state.employees.map((e) => {
      const st = r.employeeStats[e.id];
      if (!st) return '';
      const projects = Object.entries(st.projectCounts).map(([pid, n]) => `${esc(projectName(pid))} ×${n}`).join('、') || '<small>—</small>';
      const dates = st.dates.map((x) => `<span class="chip" title="${esc(projectName(x.projectId))}">${esc(x.date.slice(5).replace('-', '/'))}</span>`).join('');
      return `<tr><td>${esc(e.name)}</td><td class="num"><span class="level" title="${esc(levelName(e.level))}">${esc(e.level)}</span></td><td class="num">${st.days} 日</td><td class="num">${st.km} km</td><td>${projects}</td><td>${dates || '<small>—</small>'}</td></tr>`;
    }).join('');
    $('#result-employees').innerHTML = `<thead><tr><th>スタッフ</th><th>Lv</th><th>出勤日数</th><th>合計距離(片道)</th><th>案件</th><th>出勤日</th></tr></thead><tbody>${empRows}</tbody>`;
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

  // ---------------- レベルの呼び名 ----------------

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

  // ---------------- データ ----------------

  $('#btn-export').addEventListener('click', () => {
    const data = { version: 2, exportedAt: new Date().toISOString(), employees: state.employees, projects: state.projects, settings: state.settings };
    download(`shift-data_${S.formatDate(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
  });

  $('#input-import').addEventListener('change', (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!Array.isArray(data.employees) || !(Array.isArray(data.projects) || Array.isArray(data.stores))) {
          throw new Error('形式が違います');
        }
        const m = migrate(data);
        if (!confirm(`スタッフ ${m.employees.length} 名・案件 ${m.projects.length} 件を読み込みます。現在のデータは置き換えられます。よろしいですか?`)) return;
        state = {
          employees: m.employees,
          projects: m.projects,
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
    if (state.employees.length || state.projects.length) {
      if (!confirm('現在のデータをサンプルで置き換えます。よろしいですか?')) return;
    }
    state = sampleData();
    saveState();
    renderAll();
    showTab('generate');
  });

  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('このブラウザに保存されているスタッフ・案件・生成結果をすべて削除します。元に戻せません。よろしいですか?')) return;
    state = { employees: [], projects: [], settings: defaultSettings(), result: null };
    saveState();
    renderAll();
  });

  function sampleData() {
    const d0 = nextMonday();
    const D = (n) => S.addDays(d0, n);
    const projects = [
      { id: 'p1', name: '新宿ビル 什器搬入', address: '東京都新宿区西新宿1-1-3', lat: 35.6896, lng: 139.6995, startDate: D(0), endDate: D(4), requiredStaff: 2, requiredAvgLevel: 3, minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '5日間。平均Lv3以上' },
      { id: 'p2', name: '横浜 店舗改装', address: '神奈川県横浜市西区みなとみらい2-2-1', lat: 35.4571, lng: 139.6329, startDate: D(1), endDate: D(4), requiredStaff: 2, requiredAvgLevel: 2, minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '4日間' },
      { id: 'p3', name: '渋谷 イベント設営', address: '東京都渋谷区宇田川町25-1', lat: 35.6614, lng: 139.6982, startDate: D(5), endDate: D(9), requiredStaff: 3, requiredAvgLevel: 3.5, minLevel: 2, leaderLevel: 4, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '5日間。難度が高く平均Lv3.5以上・リーダー必須' },
      { id: 'p4', name: '川崎 倉庫棚卸', address: '神奈川県川崎市川崎区駅前本町26-1', lat: 35.5308, lng: 139.6970, startDate: D(7), endDate: D(10), requiredStaff: 2, requiredAvgLevel: 2.5, minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '4日間' },
      { id: 'p5', name: '大宮 什器入替', address: '埼玉県さいたま市大宮区桜木町1-7-5', lat: 35.9064, lng: 139.6238, startDate: D(10), endDate: D(13), requiredStaff: 2, requiredAvgLevel: 3, minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], memo: '4日間' },
      { id: 'p6', name: '本社受付(常設)', address: '東京都新宿区西新宿2-8-1', lat: 35.6894, lng: 139.6917, startDate: '', endDate: '', requiredStaff: 1, requiredAvgLevel: 0, minLevel: 3, leaderLevel: 0, openWeekdays: [1, 2, 3, 4, 5], memo: '期間なし=常設。平日のみ' },
    ];
    const employees = [
      { id: 'e01', name: '佐藤 一郎', address: '東京都新宿区北新宿3-1-1', lat: 35.7030, lng: 139.6930, level: 5, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: ['p1'], memo: '日曜は不可' },
      { id: 'e02', name: '鈴木 花子', address: '東京都渋谷区神宮前6-1-1', lat: 35.6690, lng: 139.7050, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: ['p3'], memo: '' },
      { id: 'e03', name: '高橋 健', address: '神奈川県横浜市神奈川区鶴屋町2-1', lat: 35.4680, lng: 139.6210, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: ['p2'], memo: '' },
      { id: 'e04', name: '田中 美咲', address: '埼玉県さいたま市浦和区高砂1-1-1', lat: 35.8617, lng: 139.6455, level: 3, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5], unavailableDates: [], ngProjectIds: ['p2'], preferredProjectIds: ['p5'], memo: '育児のため土日は不可' },
      { id: 'e05', name: '伊藤 翔', address: '東京都中野区中野4-1-1', lat: 35.7070, lng: 139.6650, level: 3, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: [], memo: '' },
      { id: 'e06', name: '渡辺 さくら', address: '東京都世田谷区三軒茶屋1-1-1', lat: 35.6430, lng: 139.6690, level: 2, maxDaysPerWeek: 3, availableWeekdays: [0, 3, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: ['p3'], memo: '学生。水・土・日のみ、週3まで' },
      { id: 'e07', name: '山本 大輔', address: '神奈川県川崎市川崎区砂子1-1-1', lat: 35.5310, lng: 139.6970, level: 2, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: ['p4'], memo: '' },
      { id: 'e08', name: '中村 結衣', address: '東京都豊島区南池袋1-1-1', lat: 35.7280, lng: 139.7130, level: 1, maxDaysPerWeek: 5, availableWeekdays: [1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: [], memo: '研修中' },
      { id: 'e09', name: '小林 直人', address: '神奈川県横浜市港北区新横浜2-1-1', lat: 35.5070, lng: 139.6170, level: 3, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: ['p2'], memo: '' },
      { id: 'e10', name: '加藤 恵', address: '東京都杉並区荻窪5-1-1', lat: 35.7040, lng: 139.6200, level: 4, maxDaysPerWeek: 5, availableWeekdays: [0, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: [], memo: '本業あり。金・土・日のみ' },
      { id: 'e11', name: '吉田 亮', address: '神奈川県川崎市中原区小杉町3-1-1', lat: 35.5760, lng: 139.6590, level: 2, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: [], memo: '' },
      { id: 'e12', name: '松本 由紀', address: '神奈川県横浜市西区北幸1-1-1', lat: 35.4650, lng: 139.6200, level: 5, maxDaysPerWeek: 5, availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: ['p5'], preferredProjectIds: ['p2'], memo: 'ベテラン' },
    ];
    employees[1].unavailableDates = [D(6)];        // 鈴木: 案件3 の途中で 1 日希望休
    employees[4].unavailableDates = [D(2), D(3)];  // 伊藤: 2 日希望休
    return {
      employees,
      projects,
      settings: Object.assign(defaultSettings(), { startDate: D(0), endDate: D(13) }),
      result: null,
    };
  }

  // ---------------- 初期化 ----------------

  function renderAll() {
    renderLevelOptions();
    renderLevelSettings();
    renderEmployees();
    renderProjects();
    renderEmployeeForm();
    renderProjectForm();
    renderGenerateForm();
    renderResult();
  }

  renderAll();
  let initialTab = 'generate';
  try { initialTab = localStorage.getItem(STORAGE_KEY + ':tab') || 'generate'; } catch (e) { /* ignore */ }
  if (initialTab === 'stores') initialTab = 'projects';
  if (!state.employees.length && !state.projects.length) initialTab = 'data';
  showTab(initialTab);
})();
