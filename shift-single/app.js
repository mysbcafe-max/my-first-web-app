/*
 * 一店舗用シフト生成ツールの画面処理
 * - 入力は localStorage にだけ保存する(外部送信なし)
 * - シフトの組み立て自体は scheduler.js に任せる
 */
(function () {
  'use strict';

  const S = window.SingleShiftScheduler;
  const STORAGE_KEY = 'shift-single/v2';
  const LEGACY_KEY = 'shift-single/v1';
  const BACKUP_KEY = 'shift-single/last-backup';
  const BACKUP_REMIND_DAYS = 7;
  const WEEKDAYS = S.WEEKDAY_LABELS;

  // ---------------- 小物 ----------------

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    });
    return node;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function localDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  // offset 0 = 今月, 1 = 来月
  function monthRange(offset) {
    const now = new Date();
    const m = now.getMonth() + (offset || 0);
    return {
      start: localDate(new Date(now.getFullYear(), m, 1)),
      end: localDate(new Date(now.getFullYear(), m + 1, 0)),
    };
  }

  function thisMonth() {
    return monthRange(0);
  }

  function nextId(prefix, list) {
    let max = 0;
    list.forEach(function (item) {
      const m = String(item.id || '').match(new RegExp('^' + prefix + '(\\d+)$'));
      if (m) max = Math.max(max, Number(m[1]));
    });
    return prefix + (max + 1);
  }

  function toIntOrNull(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : null;
  }

  // ---------------- データ ----------------

  function defaultData() {
    const period = thisMonth();
    const parts = S.presetToStore('aushop');
    return {
      store: {
        name: '',
        periodStart: period.start,
        periodEnd: period.end,
        closedWeekdays: [],
        closedRules: [],
        closedDates: [],
        useHolidays: true,
        autoRelax: true,
        busyDates: [],
        dayMinCount: null,
        dayMinCountWeekend: null,
        dayCountMode: 'work',
        roles: parts.roles,
        levelLabels: parts.levelLabels,
        slots: parts.slots,
      },
      staff: [],
      options: Object.assign({}, S.DEFAULT_OPTIONS),
    };
  }

  // v1(フロア/キッチン固定)のデータを v2(役割マスタ)に読み替える
  function migrateV1(parsed) {
    const roles = [{ id: 'role1', name: 'フロア' }, { id: 'role2', name: 'キッチン' }];
    const store = Object.assign({}, parsed.store || {});
    store.roles = roles;
    store.levelLabels = S.DEFAULT_LEVEL_LABELS.slice();
    store.slots = (store.slots || []).map(function (slot) {
      const copy = Object.assign({}, slot);
      copy.requiredByRole = { role1: slot.requiredFloor || 0, role2: slot.requiredKitchen || 0 };
      delete copy.requiredFloor;
      delete copy.requiredKitchen;
      return copy;
    });
    const staff = (parsed.staff || []).map(function (person) {
      const copy = Object.assign({}, person);
      copy.roles = [];
      if (person.floor !== false) copy.roles.push('role1');
      if (person.kitchen) copy.roles.push('role2');
      delete copy.floor;
      delete copy.kitchen;
      return copy;
    });
    return { store: store, staff: staff, options: parsed.options || {} };
  }

  function loadData() {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let parsed = raw ? JSON.parse(raw) : null;
      if (!parsed) {
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (!legacy) return defaultData();
        parsed = migrateV1(JSON.parse(legacy));
      }
      const base = defaultData();
      return {
        store: Object.assign(base.store, parsed.store || {}),
        staff: Array.isArray(parsed.staff) ? parsed.staff : [],
        options: Object.assign(base.options, parsed.options || {}),
      };
    } catch (e) {
      return defaultData();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      setStatus('#data-status', '保存できませんでした(ブラウザの設定を確認してください)');
    }
  }

  let data = loadData();
  let lastResult = null;
  let editingDaysOff = [];
  let backupNoticeDismissed = false;

  // ---------------- 共通表示 ----------------

  function setStatus(sel, text) {
    const node = $(sel);
    if (!node) return;
    node.textContent = text;
    if (text) window.setTimeout(function () { if (node.textContent === text) node.textContent = ''; }, 4000);
  }

  function checkboxLabel(group, value, label, checked) {
    return el('label', {}, [
      el('input', { type: 'checkbox', 'data-group': group, value: String(value), checked: checked ? true : null }),
      label,
    ]);
  }

  function checkedValues(container, group) {
    return $$('input[data-group="' + group + '"]:checked', container).map(function (i) { return i.value; });
  }

  function weekdaysText(list) {
    if (!list || list.length === 7) return '毎日';
    if (!list.length) return 'なし';
    return list.slice().sort(function (a, b) { return a - b; }).map(function (i) { return WEEKDAYS[i]; }).join('');
  }

  // ---------------- 試用の案内・バックアップの督促 ----------------

  function renderTrialBanner() {
    const box = $('#trial-banner');
    const trial = window.ShiftTrial;
    if (!trial) { box.hidden = true; return; }
    const st = trial.status(trial.CONFIG, localDate(new Date()));
    if (!st.enabled) { box.hidden = true; return; }

    box.textContent = '';
    box.className = 'trial-banner trial-banner--' + st.phase;
    box.appendChild(el('strong', { text: st.storeName ? st.storeName + ' — 試用版' : '試用版' }));
    box.appendChild(el('span', { text: ' ' + st.message }));
    if (st.contact) {
      box.appendChild(el('span', { class: 'trial-banner__contact', text: 'ご相談: ' + st.contact }));
    }
    box.hidden = false;
  }

  function lastBackupAt() {
    try {
      const v = localStorage.getItem(BACKUP_KEY);
      return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
    } catch (e) {
      return '';
    }
  }

  function markBackedUp() {
    try {
      localStorage.setItem(BACKUP_KEY, localDate(new Date()));
    } catch (e) { /* 保存できなくても動作に影響はない */ }
    renderBackupNotice();
  }

  function daysSince(dateStr) {
    const a = new Date(dateStr + 'T00:00:00Z').getTime();
    const b = new Date(localDate(new Date()) + 'T00:00:00Z').getTime();
    return Math.round((b - a) / 86400000);
  }

  // データはこの端末のブラウザにしか無いので、書き出しをうながす
  function renderBackupNotice() {
    const notice = $('#backup-notice');
    const status = $('#backup-status');
    const last = lastBackupAt();
    const hasData = data.staff.length > 0;

    if (status) {
      status.textContent = last
        ? '最終バックアップ: ' + last.replace(/-/g, '/') + '(' + daysSince(last) + '日前)'
        : 'まだバックアップしていません。「JSON を書き出す」で保存できます。';
    }

    if (!hasData || backupNoticeDismissed) { notice.hidden = true; return; }
    const overdue = !last || daysSince(last) >= BACKUP_REMIND_DAYS;
    if (!overdue) { notice.hidden = true; return; }

    notice.textContent = '';
    notice.appendChild(el('span', {
      text: last
        ? 'バックアップから ' + daysSince(last) + ' 日たっています。データはこの端末のブラウザにだけ保存されています。'
        : 'データはこの端末のブラウザにだけ保存されています。念のためバックアップを取ってください。',
    }));
    notice.appendChild(el('button', {
      type: 'button', class: 'btn btn-small', text: 'いますぐ書き出す',
      onclick: function () { exportJson(); },
    }));
    notice.appendChild(el('button', {
      type: 'button', class: 'btn btn-small', text: 'あとで',
      onclick: function () { backupNoticeDismissed = true; notice.hidden = true; },
    }));
    notice.hidden = false;
  }

  function exportJson() {
    download('shift-single-data.json', JSON.stringify(data, null, 2), 'application/json');
    markBackedUp();
    setStatus('#data-status', '書き出しました');
  }

  // ---------------- タブ ----------------

  function initTabs() {
    $$('.tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        const name = tab.dataset.tab;
        $$('.tab').forEach(function (t) {
          const active = t === tab;
          t.classList.toggle('is-active', active);
          t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        $$('.panel').forEach(function (p) { p.hidden = p.id !== 'tab-' + name; });
        if (name === 'staff') renderStaffCheckboxes();
      });
    });
  }

  // ---------------- スタッフ ----------------

  function renderStaffCheckboxes() {
    const rl = $('#staff-roles');
    const shownRoles = $$('input[data-group="role"]', rl).map(function (i) { return i.value; });
    const currentRoles = checkedValues(rl, 'role');
    rl.textContent = '';
    if (!data.store.roles.length) {
      rl.appendChild(el('span', { class: 'status', text: '役割を使わない設定です(「店舗設定」タブで追加できます)' }));
    } else {
      data.store.roles.forEach(function (role) {
        const known = shownRoles.indexOf(role.id) >= 0;
        rl.appendChild(checkboxLabel('role', role.id, role.name, known ? currentRoles.indexOf(role.id) >= 0 : true));
      });
    }

    const wd = $('#staff-weekdays');
    const current = wd.children.length ? checkedValues(wd, 'weekday') : null;
    wd.textContent = '';
    WEEKDAYS.forEach(function (label, i) {
      wd.appendChild(checkboxLabel('weekday', i, label, current ? current.indexOf(String(i)) >= 0 : true));
    });

    const levelSelect = $('#form-staff [name=level]');
    const currentLevel = levelSelect.value || '3';
    levelSelect.textContent = '';
    data.store.levelLabels.forEach(function (label, i) {
      levelSelect.appendChild(el('option', { value: String(i + 1), text: (i + 1) + '(' + label + ')' }));
    });
    levelSelect.value = currentLevel;

    const sl = $('#staff-slots');
    // 画面に出ていた時間帯だけチェック状態を引き継ぎ、新しく増えた時間帯は「対応できる」にしておく
    const shownSlots = $$('input[data-group="slot"]', sl).map(function (i) { return i.value; });
    const currentSlots = checkedValues(sl, 'slot');
    sl.textContent = '';
    if (!data.store.slots.length) {
      sl.appendChild(el('span', { class: 'status', text: '「店舗設定」タブで時間帯を追加してください' }));
      return;
    }
    data.store.slots.forEach(function (slot) {
      const known = shownSlots.indexOf(slot.id) >= 0;
      sl.appendChild(checkboxLabel('slot', slot.id, slot.name, known ? currentSlots.indexOf(slot.id) >= 0 : true));
    });
  }

  // 「出勤日数」か「公休日数」か で入力欄を切り替える
  function syncDayCountFields() {
    const form = $('#form-staff');
    const mode = form.elements.dayCountMode.value || data.store.dayCountMode || 'work';
    const holiday = mode === 'holiday';
    $('#field-target-days').hidden = holiday;
    $('#field-holiday-days').hidden = !holiday;
    form.elements.targetDays.required = !holiday;
    form.elements.holidayDays.required = holiday;
    const total = S.eachDate(data.store.periodStart, data.store.periodEnd).length;
    const hint = $('#holiday-hint');
    if (hint) {
      const days = Math.max(0, Number(form.elements.holidayDays.value) || 0);
      hint.textContent = total
        ? '期間の全日数 ' + total + '日 − 公休 ' + days + '日 = 出勤 ' + Math.max(0, total - days) + '日'
        : '期間の全日数から引いた日数が出勤日数になります';
    }
  }

  function renderDaysOffChips() {
    const box = $('#staff-daysoff');
    box.textContent = '';
    editingDaysOff.slice().sort().forEach(function (date) {
      box.appendChild(el('span', { class: 'chip' }, [
        date,
        el('button', {
          type: 'button', 'aria-label': date + ' を削除', text: '×',
          onclick: function () {
            editingDaysOff = editingDaysOff.filter(function (d) { return d !== date; });
            renderDaysOffChips();
          },
        }),
      ]));
    });
  }

  function resetStaffForm() {
    const form = $('#form-staff');
    form.reset();
    form.elements.id.value = '';
    editingDaysOff = [];
    renderDaysOffChips();
    renderStaffCheckboxes();
    $$('#staff-weekdays input, #staff-slots input, #staff-roles input').forEach(function (i) { i.checked = true; });
    form.elements.canOpen.checked = true;
    form.elements.canClose.checked = true;
    form.elements.fixedStart.checked = false;
    syncDayCountFields();
    $('#staff-form-title').textContent = 'スタッフを追加';
    $('#btn-staff-submit').textContent = '追加';
    $('#btn-staff-cancel').hidden = true;
  }

  function fillStaffForm(person) {
    const form = $('#form-staff');
    form.elements.id.value = person.id;
    form.elements.name.value = person.name || '';
    form.elements.level.value = String(person.level || 3);
    form.elements.targetDays.value = person.targetDays === undefined ? 20 : person.targetDays;
    form.elements.dayCountMode.value = person.dayCountMode || '';
    form.elements.holidayDays.value = person.holidayDays === undefined ? 9 : person.holidayDays;
    form.elements.startLimit.value = person.startLimit || '';
    form.elements.fixedStart.checked = !!person.fixedStart;
    form.elements.headcount.value = (person.headcount === null || person.headcount === undefined) ? '' : person.headcount;
    form.elements.endLimit.value = person.endLimit || '';
    form.elements.canOpen.checked = person.canOpen !== false;
    form.elements.canClose.checked = person.canClose !== false;
    syncDayCountFields();
    form.elements.maxConsecutiveDays.value = person.maxConsecutiveDays ? person.maxConsecutiveDays : '';
    form.elements.note.value = person.note || '';

    renderStaffCheckboxes();
    const roleIds = Array.isArray(person.roles) ? person.roles.map(String) : null;
    $$('#staff-roles input').forEach(function (i) { i.checked = roleIds ? roleIds.indexOf(i.value) >= 0 : true; });
    const wdays = Array.isArray(person.availableWeekdays) ? person.availableWeekdays.map(String) : null;
    $$('#staff-weekdays input').forEach(function (i) { i.checked = wdays ? wdays.indexOf(i.value) >= 0 : true; });
    const slots = Array.isArray(person.availableSlots) ? person.availableSlots.map(String) : null;
    $$('#staff-slots input').forEach(function (i) { i.checked = slots ? slots.indexOf(i.value) >= 0 : true; });

    editingDaysOff = Array.isArray(person.daysOff) ? person.daysOff.slice() : [];
    renderDaysOffChips();

    $('#staff-form-title').textContent = 'スタッフを編集';
    $('#btn-staff-submit').textContent = '保存';
    $('#btn-staff-cancel').hidden = false;
    $('#form-staff').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onStaffSubmit(e) {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    if (!name) return;
    const roles = checkedValues($('#staff-roles'), 'role');
    if (data.store.roles.length && !roles.length) {
      setStatus('#staff-status', 'できる役割を 1 つ以上選んでください');
      return;
    }
    const weekdays = checkedValues($('#staff-weekdays'), 'weekday').map(Number);
    if (!weekdays.length) {
      setStatus('#staff-status', '勤務できる曜日を 1 つ以上選んでください');
      return;
    }
    const availableSlots = checkedValues($('#staff-slots'), 'slot');
    if (data.store.slots.length && !availableSlots.length) {
      setStatus('#staff-status', '対応できる時間帯を 1 つ以上選んでください');
      return;
    }
    const person = {
      id: form.elements.id.value || nextId('staff', data.staff),
      name: name,
      level: Number(form.elements.level.value),
      roles: roles,
      targetDays: Math.max(0, Number(form.elements.targetDays.value) || 0),
      dayCountMode: form.elements.dayCountMode.value,
      holidayDays: Math.max(0, Number(form.elements.holidayDays.value) || 0),
      startLimit: form.elements.startLimit.value,
      fixedStart: form.elements.fixedStart.checked,
      headcount: form.elements.headcount.value === '' ? null : Math.max(0, Number(form.elements.headcount.value) || 0),
      endLimit: form.elements.endLimit.value,
      canOpen: form.elements.canOpen.checked,
      canClose: form.elements.canClose.checked,
      availableWeekdays: weekdays,
      availableSlots: availableSlots,
      daysOff: editingDaysOff.slice().sort(),
      maxConsecutiveDays: toIntOrNull(form.elements.maxConsecutiveDays.value) || 0,
      note: form.elements.note.value.trim(),
    };
    const idx = data.staff.findIndex(function (p) { return p.id === person.id; });
    if (idx >= 0) data.staff[idx] = person;
    else data.staff.push(person);
    save();
    resetStaffForm();
    renderStaffTable();
    renderCounts();
    renderBackupNotice();
    setStatus('#staff-status', idx >= 0 ? '保存しました' : name + ' を追加しました');
  }

  function dayCountText(p) {
    const mode = p.dayCountMode || data.store.dayCountMode || 'work';
    return mode === 'holiday' ? '公休' + (p.holidayDays || 0) + '日' : '出勤' + (p.targetDays || 0) + '日';
  }

  function hoursText(p) {
    if (!p.startLimit && !p.endLimit) return '—';
    return (p.startLimit || '') + '〜' + (p.endLimit || '') + (p.fixedStart && p.startLimit ? '(固定)' : '');
  }

  function renderStaffTable() {
    const table = $('#staff-table');
    table.textContent = '';
    if (!data.staff.length) {
      table.appendChild(el('tbody', {}, el('tr', {}, el('td', { class: 'none', text: 'まだスタッフが登録されていません。上のフォームから追加するか、「データ」タブでサンプルを読み込んでください。' }))));
      return;
    }
    const head = ['名前', 'レベル'].concat(
      data.store.roles.map(function (r) { return r.name; }),
      ['勤務日数', '勤務時間', '締め', '勤務曜日', '対応時間帯', '希望休', 'メモ', '']
    );
    table.appendChild(el('thead', {}, el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))));

    const slotName = {};
    data.store.slots.forEach(function (s) { slotName[s.id] = s.name; });

    const body = el('tbody');
    data.staff.forEach(function (p) {
      const slots = Array.isArray(p.availableSlots) ? p.availableSlots : data.store.slots.map(function (s) { return s.id; });
      const slotText = slots.length === data.store.slots.length ? 'すべて'
        : (slots.map(function (id) { return slotName[id] || id; }).join('・') || 'なし');
      const personRoles = Array.isArray(p.roles) ? p.roles : data.store.roles.map(function (r) { return r.id; });
      body.appendChild(el('tr', {}, [
        el('td', { text: p.name }),
        el('td', { class: 'num', text: p.level }),
      ].concat(
        data.store.roles.map(function (r) {
          return el('td', { text: personRoles.indexOf(r.id) >= 0 ? '○' : '—' });
        }),
        [
        el('td', { class: 'num', text: dayCountText(p) }),
        el('td', { text: hoursText(p) }),
        el('td', { text: p.canClose === false ? '—' : '○' }),
        el('td', { text: weekdaysText(p.availableWeekdays) }),
        el('td', { text: slotText }),
        el('td', { text: (p.daysOff && p.daysOff.length) ? p.daysOff.length + '日' : '—', title: (p.daysOff || []).join(' ') }),
        el('td', { text: p.note || '' }),
        el('td', {}, el('div', { class: 'btn-group' }, [
          el('button', { type: 'button', class: 'btn btn-small', text: '編集', onclick: function () { fillStaffForm(p); } }),
          el('button', {
            type: 'button', class: 'btn btn-small', text: '複製',
            onclick: function () {
              const copy = JSON.parse(JSON.stringify(p));
              copy.id = nextId('staff', data.staff);
              copy.name = p.name + ' のコピー';
              data.staff.push(copy);
              save(); renderStaffTable(); renderCounts();
            },
          }),
          el('button', {
            type: 'button', class: 'btn btn-small btn-danger', text: '削除',
            onclick: function () {
              if (!window.confirm(p.name + ' を削除しますか?')) return;
              data.staff = data.staff.filter(function (x) { return x.id !== p.id; });
              save(); resetStaffForm(); renderStaffTable(); renderCounts();
            },
          }),
        ])),
        ]
      )));
    });
    table.appendChild(body);
  }

  // ---------------- 店舗設定 ----------------

  function renderStoreForm() {
    const form = $('#form-store');
    form.elements.name.value = data.store.name || '';
    form.elements.periodStart.value = data.store.periodStart || '';
    form.elements.periodEnd.value = data.store.periodEnd || '';
    form.elements.dayCountMode.value = data.store.dayCountMode || 'work';
    form.elements.useHolidays.checked = data.store.useHolidays !== false;
    form.elements.autoRelax.checked = data.store.autoRelax !== false;
    form.elements.dayMinCount.value = data.store.dayMinCount === null || data.store.dayMinCount === undefined
      ? '' : data.store.dayMinCount;
    form.elements.dayMinCountWeekend.value = data.store.dayMinCountWeekend === null || data.store.dayMinCountWeekend === undefined
      ? '' : data.store.dayMinCountWeekend;

    renderClosedGrid();

    renderClosedDates();
    renderBusyDates();
    renderHolidayPreview();
  }

  // 期間内の祝日を一覧で見せる(認識できているかを店舗が確認できるように)
  function renderHolidayPreview() {
    const box = $('#holiday-preview');
    if (!box) return;
    if (data.store.useHolidays === false) {
      box.textContent = '祝日は平日と同じ人数で組みます。';
      return;
    }
    const dates = S.eachDate(data.store.periodStart, data.store.periodEnd);
    const list = dates
      .map(function (d) { return { date: d, name: S.holidayNameOf(d) }; })
      .filter(function (x) { return x.name; });
    box.textContent = list.length
      ? 'この期間の祝日: ' + list.map(function (x) {
        return x.date.slice(5).replace('-', '/') + ' ' + x.name;
      }).join('、')
      : 'この期間に祝日はありません。';
  }

  function renderBusyDates() {
    const box = $('#store-busy-dates');
    box.textContent = '';
    (data.store.busyDates || []).slice().sort().forEach(function (date) {
      box.appendChild(el('span', { class: 'chip' }, [
        date,
        el('button', {
          type: 'button', 'aria-label': date + ' を削除', text: '×',
          onclick: function () {
            data.store.busyDates = data.store.busyDates.filter(function (d) { return d !== date; });
            save(); renderBusyDates();
          },
        }),
      ]));
    });
  }

  const CLOSED_COLUMNS = [
    { key: 'all', label: '毎週' },
    { key: 1, label: '第1' },
    { key: 2, label: '第2' },
    { key: 3, label: '第3' },
    { key: 4, label: '第4' },
    { key: 5, label: '第5' },
    { key: 'last', label: '最終' },
  ];

  function hasRule(weekday, week) {
    return (data.store.closedRules || []).some(function (r) {
      return r.weekday === weekday && r.week === week;
    });
  }

  function setRule(weekday, week, on) {
    const rules = (data.store.closedRules || []).filter(function (r) {
      return !(r.weekday === weekday && r.week === week);
    });
    if (on) rules.push({ weekday: weekday, week: week });
    data.store.closedRules = rules;
  }

  // 曜日 × 第何週 の定休日グリッド
  function renderClosedGrid() {
    const table = $('#store-closed-grid');
    if (!table) return;
    table.textContent = '';
    table.appendChild(el('thead', {}, el('tr', {},
      [el('th', { text: '曜日' })].concat(CLOSED_COLUMNS.map(function (c) {
        return el('th', { class: 'num', text: c.label });
      })))));

    const body = el('tbody');
    WEEKDAYS.forEach(function (label, wd) {
      const everyWeek = (data.store.closedWeekdays || []).indexOf(wd) >= 0;
      const cells = CLOSED_COLUMNS.map(function (col) {
        const isAll = col.key === 'all';
        const input = el('input', {
          type: 'checkbox',
          checked: (isAll ? everyWeek : hasRule(wd, col.key)) ? true : null,
          disabled: (!isAll && everyWeek) ? true : null,
          'aria-label': label + '曜 ' + col.label,
          onchange: function () {
            if (isAll) {
              const list = (data.store.closedWeekdays || []).filter(function (w) { return w !== wd; });
              if (input.checked) {
                list.push(wd);
                // 毎週にしたら、その曜日の第○指定は不要なので消す
                data.store.closedRules = (data.store.closedRules || []).filter(function (r) {
                  return r.weekday !== wd;
                });
              }
              data.store.closedWeekdays = list.sort(function (a, b) { return a - b; });
            } else {
              setRule(wd, col.key, input.checked);
            }
            save();
            renderClosedGrid();
            renderClosedPreview();
          },
        });
        return el('td', { class: 'num' }, input);
      });
      body.appendChild(el('tr', {}, [el('th', { text: label })].concat(cells)));
    });
    table.appendChild(body);
    renderClosedPreview();
  }

  // この期間で実際に休みになる日を出す
  function renderClosedPreview() {
    const box = $('#closed-preview');
    if (!box) return;
    const dates = S.eachDate(data.store.periodStart, data.store.periodEnd);
    const store = {
      closedWeekdays: data.store.closedWeekdays || [],
      closedRules: data.store.closedRules || [],
      closedDates: data.store.closedDates || [],
    };
    const closed = dates.filter(function (d) { return S.isClosedDate(store, d); });
    if (!closed.length) {
      box.textContent = 'この期間に休みはありません。';
      return;
    }
    box.textContent = 'この期間の休み(' + closed.length + '日): ' + closed.map(function (d) {
      return d.slice(5).replace('-', '/') + '(' + WEEKDAYS[S.weekdayOf(d)] + ')';
    }).join('、');
  }

  function renderClosedDates() {
    const box = $('#store-closed-dates');
    box.textContent = '';
    (data.store.closedDates || []).slice().sort().forEach(function (date) {
      box.appendChild(el('span', { class: 'chip' }, [
        date,
        el('button', {
          type: 'button', 'aria-label': date + ' を削除', text: '×',
          onclick: function () {
            data.store.closedDates = data.store.closedDates.filter(function (d) { return d !== date; });
            save(); renderClosedDates(); renderClosedPreview();
          },
        }),
      ]));
    });
  }

  function renderRoles() {
    const list = $('#role-list');
    list.textContent = '';
    if (!data.store.roles.length) {
      list.appendChild(el('p', { class: 'slot-empty', text: '役割なし(誰でもどの枠にも入れる設定です)' }));
      return;
    }
    const grid = el('div', { class: 'form-grid' });
    data.store.roles.forEach(function (role, index) {
      const input = el('input', { type: 'text', value: role.name, placeholder: '役割名' });
      input.addEventListener('input', function () {
        role.name = input.value;
        save();
      });
      input.addEventListener('change', function () {
        renderSlots();
        renderStaffTable();
      });
      const remove = el('button', {
        type: 'button', class: 'btn btn-small btn-danger', text: '削除',
        onclick: function () {
          if (!window.confirm('役割「' + role.name + '」を削除しますか?(スタッフ・時間帯の設定からも外れます)')) return;
          data.store.roles.splice(index, 1);
          data.store.slots.forEach(function (slot) {
            if (slot.requiredByRole) delete slot.requiredByRole[role.id];
          });
          data.staff.forEach(function (p) {
            if (Array.isArray(p.roles)) p.roles = p.roles.filter(function (id) { return id !== role.id; });
          });
          save(); renderRoles(); renderSlots(); renderStaffCheckboxes(); renderStaffTable();
        },
      });
      grid.appendChild(el('label', {}, ['役割 ' + (index + 1), el('div', { class: 'chip-input' }, [input, remove])]));
    });
    list.appendChild(grid);
  }

  function renderLevelLabels() {
    const box = $('#level-labels');
    box.textContent = '';
    data.store.levelLabels.forEach(function (label, i) {
      const input = el('input', { type: 'text', value: label, placeholder: S.DEFAULT_LEVEL_LABELS[i] });
      input.addEventListener('input', function () {
        data.store.levelLabels[i] = input.value;
        save();
      });
      box.appendChild(el('label', {}, ['レベル' + (i + 1), input]));
    });
  }

  function renderPresetOptions() {
    const presetSelect = $('#preset-select');
    const sampleSelect = $('#sample-select');
    presetSelect.textContent = '';
    sampleSelect.textContent = '';
    Object.keys(S.PRESETS).forEach(function (key) {
      presetSelect.appendChild(el('option', { value: key, text: S.PRESETS[key].label }));
      sampleSelect.appendChild(el('option', { value: key, text: S.PRESETS[key].label }));
    });
  }

  // ひな形の適用: 役割・レベルの呼び方・時間帯を差し替える(スタッフはそのまま残す)
  function applyPreset(key) {
    const parts = S.presetToStore(key);
    data.store.roles = parts.roles;
    data.store.levelLabels = parts.levelLabels;
    data.store.slots = parts.slots;
    const roleIds = parts.roles.map(function (r) { return r.id; });
    const slotIds = parts.slots.map(function (s) { return s.id; });
    data.staff.forEach(function (p) {
      p.roles = Array.isArray(p.roles) ? p.roles.filter(function (id) { return roleIds.indexOf(id) >= 0; }) : roleIds.slice();
      if (!p.roles.length) p.roles = roleIds.slice();
      p.availableSlots = slotIds.slice();
    });
    save();
    renderAll();
  }

  function renderSlots() {
    const list = $('#slot-list');
    list.textContent = '';
    if (!data.store.slots.length) {
      list.appendChild(el('p', { class: 'slot-empty', text: '時間帯がありません。「時間帯を追加」で作ってください。' }));
      renderCounts();
      return;
    }

    data.store.slots.forEach(function (slot, index) {
      const card = el('div', { class: 'slot-card' });
      card.appendChild(el('div', { class: 'slot-card__head' }, [
        el('h4', { text: slot.name || '時間帯' + (index + 1) }),
        el('button', {
          type: 'button', class: 'btn btn-small btn-danger', text: '削除',
          onclick: function () {
            if (!window.confirm('「' + slot.name + '」を削除しますか?')) return;
            data.store.slots.splice(index, 1);
            data.staff.forEach(function (p) {
              if (Array.isArray(p.availableSlots)) {
                p.availableSlots = p.availableSlots.filter(function (id) { return id !== slot.id; });
              }
            });
            save(); renderSlots(); renderStaffTable(); renderCounts();
          },
        }),
      ]));

      function field(labelText, input, hint) {
        return el('label', {}, [labelText, input, hint ? el('small', { text: hint }) : null]);
      }

      function bind(name, type, attrs) {
        const input = el('input', Object.assign({ type: type, value: slot[name] === null || slot[name] === undefined ? '' : slot[name] }, attrs || {}));
        input.addEventListener('input', function () {
          if (type === 'number') {
            slot[name] = name === 'requiredWeekend'
              ? (input.value === '' ? null : Math.max(0, Number(input.value) || 0))
              : Math.max(0, Number(input.value) || 0);
          } else {
            slot[name] = input.value;
          }
          save();
        });
        return input;
      }

      const grid = el('div', { class: 'form-grid' }, [
        field('名前', bind('name', 'text', { placeholder: '早番' })),
        field('開始', bind('start', 'time')),
        field('終了', bind('end', 'time')),
        field('必要人数(平日)', bind('required', 'number', { min: '0', max: '30', step: '1' })),
        field('必要人数(土日祝)', bind('requiredWeekend', 'number', { min: '0', max: '30', step: '1', placeholder: '平日と同じ' }), '空欄なら平日と同じ'),
      ]);

      // 役割ごとの必須人数
      slot.requiredByRole = slot.requiredByRole || {};
      data.store.roles.forEach(function (role) {
        const input = el('input', {
          type: 'number', min: '0', max: '30', step: '1',
          value: slot.requiredByRole[role.id] === undefined ? 0 : slot.requiredByRole[role.id],
        });
        input.addEventListener('input', function () {
          slot.requiredByRole[role.id] = Math.max(0, Number(input.value) || 0);
          save();
        });
        grid.appendChild(el('label', {}, ['うち' + role.name + '必須', input]));
      });

      const leader = el('select', {}, [0, 1, 2, 3, 4, 5].map(function (lv) {
        return el('option', { value: String(lv), selected: Number(slot.leaderLevel || 0) === lv ? true : null, text: lv === 0 ? '指定なし' : 'レベル' + lv + '以上を 1 名' });
      }));
      leader.addEventListener('change', function () { slot.leaderLevel = Number(leader.value); save(); });
      grid.appendChild(field('リーダー要件', leader, 'その枠に必ず入れたいレベル'));

      // 開店準備・締め作業をこの枠で行うか
      const dutyBox = el('div', { class: 'check-row' });
      [['requiresOpen', '開店準備あり(' + (slot.start || '開始時刻') + 'から)'],
        ['requiresClose', '締め作業あり(' + (slot.end || '終了時刻') + 'まで)']].forEach(function (pair) {
        const input = el('input', {
          type: 'checkbox', checked: slot[pair[0]] ? true : null,
          onchange: function () { slot[pair[0]] = input.checked; save(); },
        });
        dutyBox.appendChild(el('label', {}, [input, pair[1]]));
      });
      grid.appendChild(el('fieldset', { class: 'form-grid__full' }, [
        el('legend', { text: '開店準備・締め作業' }),
        dutyBox,
        el('small', { text: '担当できる人(その時間まで居られて、できる設定の人)を必ず1人入れます' }),
      ]));

      const wdBox = el('div', { class: 'check-row' });
      WEEKDAYS.forEach(function (label, i) {
        const input = el('input', {
          type: 'checkbox', value: String(i),
          checked: (slot.weekdays || [0, 1, 2, 3, 4, 5, 6]).indexOf(i) >= 0 ? true : null,
          onchange: function () {
            const cur = (slot.weekdays || [0, 1, 2, 3, 4, 5, 6]).filter(function (w) { return w !== i; });
            if (input.checked) cur.push(i);
            slot.weekdays = cur.sort(function (a, b) { return a - b; });
            save();
          },
        });
        wdBox.appendChild(el('label', {}, [input, label]));
      });
      grid.appendChild(el('fieldset', { class: 'form-grid__full' }, [el('legend', { text: 'この時間帯を設ける曜日' }), wdBox]));

      card.appendChild(grid);
      list.appendChild(card);
    });
    renderCounts();
  }

  function renderCounts() {
    $('#count-staff').textContent = String(data.staff.length);
    $('#count-slots').textContent = String(data.store.slots.length);
  }

  // ---------------- 生成 ----------------

  function fillOptionForm() {
    const form = $('#form-generate');
    const o = data.options || {};
    ['maxConsecutiveDays', 'weightNeed', 'weightContinuity', 'weightLevel', 'weightConsecutive'].forEach(function (k) {
      if (form.elements[k] && o[k] !== undefined && o[k] !== null) form.elements[k].value = o[k];
    });
    form.elements.improve.checked = o.improve !== false;
  }

  function readOptions() {
    const form = $('#form-generate');
    return {
      maxConsecutiveDays: Math.max(0, Number(form.elements.maxConsecutiveDays.value) || 0),
      weightNeed: Math.max(0, Number(form.elements.weightNeed.value) || 0),
      weightContinuity: Math.max(0, Number(form.elements.weightContinuity.value) || 0),
      weightLevel: Math.max(0, Number(form.elements.weightLevel.value) || 0),
      weightConsecutive: Math.max(0, Number(form.elements.weightConsecutive.value) || 0),
      improve: form.elements.improve.checked,
    };
  }

  function onGenerate(e) {
    e.preventDefault();
    data.options = readOptions();
    save();
    const result = S.generate({ store: data.store, staff: data.staff, options: data.options });
    lastResult = result;
    renderResult(result);
    setStatus('#generate-status', result.ok ? '生成しました' : '生成できませんでした');
  }

  function renderResult(result) {
    const box = $('#result');
    box.hidden = false;
    const warnBox = $('#result-warnings');
    warnBox.textContent = '';
    $('#result-matrix').textContent = '';
    $('#result-staff').textContent = '';
    $('#result-stats').textContent = '';

    if (!result.ok) {
      warnBox.appendChild(el('div', { class: 'notice notice-error' }, [
        el('strong', { text: '生成できませんでした' }),
        el('ul', {}, result.errors.map(function (m) { return el('li', { text: m }); })),
      ]));
      $('#result-period').textContent = '';
      return;
    }

    const st = result.stats;
    $('#result-period').textContent = (result.store.name ? result.store.name + ' / ' : '')
      + result.store.periodStart + ' 〜 ' + result.store.periodEnd;

    const assignedDays = result.staffSummary.reduce(function (n, r) { return n + r.assignedDays; }, 0);
    const fc = S.formatCount;
    [
      ['営業日数', st.openDays + '日', '(定休 ' + st.closedDays + '日)'],
      ['必要カウント', fc(st.requiredTotal), ''],
      ['割り当て', fc(st.assignedTotal), st.shortage > 0 ? '(不足 ' + fc(st.shortage) + ')' : '(不足なし)'],
      ['のべ人数', st.assignedPeople + '人', ''],
      ['充足率', Math.round(Math.min(1, st.fillRate) * 100) + '%', ''],
      ['出勤日数の合計', assignedDays + '日', '/ 目標 ' + st.targetTotal + '日'],
    ].forEach(function (row) {
      $('#result-stats').appendChild(el('li', {}, [row[0] + ' ', el('b', { text: row[1] }), ' ' + row[2]]));
    });

    renderWarnings(warnBox, result);
    renderShiftGrid(result);
    renderMatrix(result);
    renderStaffResult(result);
  }

  function renderWarnings(box, result) {
    const groups = {
      relaxed: { title: '人手にあわせた調整', cls: 'notice-info', items: [] },
      dayShortage: { title: '1日の合計カウントが足りない日', cls: 'notice-error', items: [] },
      shortage: { title: '人数・カウントが足りない枠', cls: 'notice-error', items: [] },
      close: { title: '締め作業の担当がいない枠', cls: 'notice-error', items: [] },
      open: { title: '開店準備の担当がいない枠', cls: 'notice-warn', items: [] },
      leader: { title: 'リーダー要件を満たせない枠', cls: 'notice-warn', items: [] },
      unmet: { title: '勤務日数が設定どおりにならないスタッフ', cls: 'notice-warn', items: [] },
      setup: { title: '設定の確認', cls: 'notice-warn', items: [] },
    };
    result.warnings.forEach(function (w) {
      if (groups[w.type]) groups[w.type].items.push(w.message);
    });

    let any = false;
    Object.keys(groups).forEach(function (key) {
      const g = groups[key];
      if (!g.items.length) return;
      any = true;
      const details = el('details', { class: 'notice ' + g.cls, open: g.items.length <= 5 ? true : null }, [
        el('summary', { text: g.title + '(' + g.items.length + '件)' }),
        el('ul', {}, g.items.map(function (m) { return el('li', { text: m }); })),
      ]);
      box.appendChild(details);
    });
    if (!any) {
      box.appendChild(el('div', { class: 'notice notice-ok', text: '必要人数・リーダー要件・出勤日数をすべて満たすシフトができました。' }));
    }
  }

  // 完成版のシフト表(縦=スタッフ / 横=日付)
  function renderShiftGrid(result) {
    const table = $('#result-shift-grid');
    table.textContent = '';
    const m = S.toStaffMatrix(result);

    function dayClass(d) {
      if (d.closed) return 'closed-col';
      if (d.holidayName) return 'sun';
      if (d.weekday === 0) return 'sun';
      if (d.weekday === 6) return 'sat';
      return null;
    }

    const head = el('tr', {}, [el('th', { class: 'name-col', text: 'スタッフ' })].concat(
      m.days.map(function (d) {
        return el('th', {
          class: dayClass(d),
          title: d.date + (d.holidayName ? ' ' + d.holidayName : ''),
        }, [String(d.day), el('small', { text: d.weekdayLabel })]);
      }),
      [el('th', { class: 'num', text: '出勤' }), el('th', { class: 'num', text: '休' })]
    ));
    table.appendChild(el('thead', {}, head));

    const body = el('tbody');
    m.rows.forEach(function (row) {
      const cells = row.cells.map(function (c, i) {
        const d = m.days[i];
        if (d.closed) return el('td', { class: 'closed-col', text: '休' });
        if (!c) return el('td', { class: dayClass(d) });
        return el('td', {
          class: (dayClass(d) ? dayClass(d) + ' ' : '') + 'on-duty',
          title: c.slotName + ' ' + c.start + '〜' + c.end + (c.isLeader ? '(リーダー)' : ''),
        }, [
          c.short,
          c.shortened ? el('small', { class: 'short-time', text: c.end } ) : null,
        ]);
      });
      body.appendChild(el('tr', {}, [el('th', { class: 'name-col', text: row.name })].concat(
        cells,
        [
          el('td', { class: 'num', text: row.assignedDays }),
          el('td', { class: 'num', text: row.restDays }),
        ]
      )));
    });

    // 日ごとの合計カウント
    const totals = el('tr', { class: 'total-row' }, [el('th', { class: 'name-col', text: '合計' })].concat(
      m.days.map(function (d) {
        return el('td', {
          class: (dayClass(d) ? dayClass(d) + ' ' : '') + (d.dayRequired > 0 && d.assignedCount < d.dayRequired ? 'diff-minus' : ''),
          text: d.closed ? '' : S.formatCount(d.assignedCount),
        });
      }),
      [el('td', {}), el('td', {})]
    ));
    body.appendChild(totals);
    table.appendChild(body);

    const legend = $('#shift-grid-legend');
    legend.textContent = '記号: ' + (result.slots || []).map(function (slot) {
      return S.slotShortName(slot) + ' = ' + slot.name + '(' + slot.start + '〜' + slot.end + ')';
    }).join(' / ') + '。空欄は休み、時短の人はマスに退勤時刻を出しています。';
  }

  function renderMatrix(result) {
    const table = $('#result-matrix');
    const slots = result.slots;
    table.appendChild(el('thead', {}, el('tr', {}, [el('th', { text: '日付' })].concat(
      slots.map(function (s) {
        return el('th', {}, [s.name, s.start || s.end ? el('small', { text: ' ' + (s.start || '') + '〜' + (s.end || '') }) : null]);
      })
    ))));

    const matrix = S.toMatrix(result);
    const body = el('tbody');
    matrix.forEach(function (row) {
      const weekendClass = row.weekday === 0 ? 'sun' : row.weekday === 6 ? 'sat' : '';
      const tr = el('tr', { class: row.busy ? 'is-weekend' : null });
      tr.appendChild(el('td', {}, [
        row.date.slice(5).replace('-', '/') + ' ',
        el('span', { class: row.holidayName ? 'sun' : weekendClass, text: '(' + row.weekdayLabel + ')' }),
        row.holidayName ? el('small', { class: 'holiday-name', text: ' ' + row.holidayName }) : null,
        row.dayRequired > 0 ? el('small', {
          class: 'day-count' + (row.dayShort > 0 ? ' diff-minus' : ''),
          text: S.formatCount(row.assignedCount) + '/' + S.formatCount(row.dayRequired),
        }) : null,
      ]));
      if (row.closed) {
        tr.appendChild(el('td', { class: 'closed', colspan: String(Math.max(1, slots.length)), text: '定休日' }));
        body.appendChild(tr);
        return;
      }
      row.cells.forEach(function (cell) {
        if (!cell) {
          tr.appendChild(el('td', { class: 'none', text: '—' }));
          return;
        }
        const ul = el('ul', {}, cell.assigned.map(function (a) {
          const isCloser = cell.slot.requiresClose && a.canClose && a.coversClose;
          const isOpener = cell.slot.requiresOpen && a.canOpen && a.coversOpen;
          return el('li', {}, [
            el('span', { class: 'tag ' + (a.role === S.ANY_ROLE ? 'tag-any' : 'tag-role'), text: a.roleLabel }),
            a.name,
            a.isLeader ? el('span', { class: 'leader-mark', text: ' ★', title: 'リーダー' }) : null,
            isCloser ? el('span', { class: 'duty-mark', text: '締', title: '締め作業' }) : null,
            isOpener ? el('span', { class: 'duty-mark', text: '開', title: '開店準備' }) : null,
            a.shortened ? el('small', { class: 'short-time', text: ' ' + a.start + '〜' + a.end }) : null,
            a.count !== 1 ? el('small', { class: 'count-mark', text: ' ' + S.formatCount(a.count) }) : null,
            el('small', { text: ' Lv' + a.level }),
          ]);
        }));
        const td = el('td', {}, ul);
        td.appendChild(el('div', { class: 'cell-count' },
          S.formatCount(cell.assignedCount) + ' / ' + S.formatCount(cell.required) + ' カウント'));
        if (cell.unfilled.length) {
          td.appendChild(el('div', {}, el('span', { class: 'shortage', text: '役割 ' + cell.unfilled.length + '人不足' })));
        }
        if (cell.shortCount > 0) {
          td.appendChild(el('div', {}, el('span', { class: 'shortage', text: S.formatCount(cell.shortCount) + 'カウント不足' })));
        }
        if (cell.noLeader) {
          td.appendChild(el('div', {}, el('span', { class: 'shortage', text: 'リーダー不在' })));
        }
        if (cell.noCloser) {
          td.appendChild(el('div', {}, el('span', { class: 'shortage', text: '締め作業の担当なし' })));
        }
        if (cell.noOpener) {
          td.appendChild(el('div', {}, el('span', { class: 'shortage', text: '開店準備の担当なし' })));
        }
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
  }

  function renderStaffResult(result) {
    const table = $('#result-staff');
    const slots = result.slots;
    const roles = result.roles || [];
    const head = ['スタッフ', 'レベル']
      .concat(roles.map(function (r) { return r.name; }),
        ['勤務時間', '締め', '基準', '目標', '実績', '過不足', '公休'],
        slots.map(function (s) { return s.name; }), ['最大連勤']);
    table.appendChild(el('thead', {}, el('tr', {}, head.map(function (h, i) {
      return el('th', { class: i >= 1 ? 'num' : null, text: h });
    }))));

    const body = el('tbody');
    result.staffSummary.forEach(function (row) {
      body.appendChild(el('tr', {}, [
        el('td', { text: row.name }),
        el('td', { class: 'num', text: row.level }),
      ].concat(
        roles.map(function (r) {
          return el('td', { class: 'num', text: row.roles.indexOf(r.id) >= 0 ? '○' : '—' });
        }),
        [
          el('td', { text: (row.startLimit || row.endLimit)
            ? (row.startLimit || '') + '〜' + (row.endLimit || '') + (row.fixedStart && row.startLimit ? '(固定)' : '')
            : '—' }),
          el('td', { class: 'num', text: row.canClose ? '○' : '—' }),
          el('td', { text: row.dayCountMode === 'holiday' ? '公休' : '出勤' }),
          el('td', { class: 'num', text: row.targetDays }),
          el('td', { class: 'num', text: row.assignedDays }),
          el('td', { class: 'num' + (row.diff < 0 ? ' diff-minus' : ''), text: row.diff === 0 ? '±0' : (row.diff > 0 ? '+' : '') + row.diff }),
          el('td', { class: 'num' + (row.dayCountMode === 'holiday' && row.restDays !== row.holidayTarget ? ' diff-minus' : ''), text: row.restDays }),
        ],
        slots.map(function (s) { return el('td', { class: 'num', text: row.bySlot[s.id] || 0 }); }),
        [el('td', { class: 'num', text: row.maxConsecutive })]
      )));
    });
    table.appendChild(body);
  }

  // ---------------- 書き出し ----------------

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function csvName(kind) {
    const s = (data.store.periodStart || '').replace(/-/g, '');
    return 'shift-' + kind + (s ? '-' + s : '') + '.csv';
  }

  // ---------------- 起動 ----------------

  function renderAll() {
    renderTrialBanner();
    renderBackupNotice();
    renderStoreForm();
    renderRoles();
    renderLevelLabels();
    renderSlots();
    renderStaffCheckboxes();
    renderStaffTable();
    renderCounts();
    fillOptionForm();
  }

  function init() {
    initTabs();
    renderPresetOptions();

    $('#form-staff').addEventListener('submit', onStaffSubmit);
    $('#btn-staff-cancel').addEventListener('click', resetStaffForm);
    $('#form-staff').elements.dayCountMode.addEventListener('change', syncDayCountFields);
    $('#form-staff').elements.holidayDays.addEventListener('input', syncDayCountFields);
    $('#btn-add-dayoff').addEventListener('click', function () {
      const input = $('#staff-dayoff-date');
      const value = input.value;
      if (!value) return;
      if (editingDaysOff.indexOf(value) < 0) editingDaysOff.push(value);
      input.value = '';
      renderDaysOffChips();
    });

    function onStoreFieldChange(e) {
      const name = e.target.name;
      if (!name) return;
      if (e.target.type === 'checkbox') {
        data.store[name] = e.target.checked;
      } else if (name === 'dayMinCount' || name === 'dayMinCountWeekend') {
        data.store[name] = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0);
      } else {
        data.store[name] = e.target.value;
      }
      save();
      if (name === 'dayCountMode' || name === 'periodStart' || name === 'periodEnd') {
        syncDayCountFields();
        renderStaffTable();
      }
      if (name === 'useHolidays' || name === 'periodStart' || name === 'periodEnd') {
        renderHolidayPreview();
      }
      if (name === 'periodStart' || name === 'periodEnd') {
        renderClosedPreview();
      }
    }
    $('#form-store').addEventListener('input', onStoreFieldChange);
    $('#form-store').addEventListener('change', onStoreFieldChange);
    function setPeriod(offset) {
      const range = monthRange(offset);
      data.store.periodStart = range.start;
      data.store.periodEnd = range.end;
      save();
      renderStoreForm();
      syncDayCountFields();
      setStatus('#data-status', '');
    }
    $('#btn-period-this').addEventListener('click', function () { setPeriod(0); });
    $('#btn-period-next').addEventListener('click', function () { setPeriod(1); });

    $('#btn-add-closed-date').addEventListener('click', function () {
      const input = $('#store-closed-date');
      const value = input.value;
      if (!value) return;
      data.store.closedDates = data.store.closedDates || [];
      if (data.store.closedDates.indexOf(value) < 0) data.store.closedDates.push(value);
      input.value = '';
      save();
      renderClosedDates();
      renderClosedPreview();
    });
    $('#btn-add-role').addEventListener('click', function () {
      const id = nextId('role', data.store.roles);
      data.store.roles.push({ id: id, name: '役割' + (data.store.roles.length + 1) });
      // 既存スタッフは新しい役割もできる扱いにする
      data.staff.forEach(function (p) {
        if (Array.isArray(p.roles)) p.roles.push(id);
      });
      save(); renderRoles(); renderSlots(); renderStaffCheckboxes(); renderStaffTable();
    });
    $('#btn-apply-preset').addEventListener('click', function () {
      const key = $('#preset-select').value;
      if (!window.confirm('「' + S.PRESETS[key].label + '」のひな形で、役割・レベルの呼び方・時間帯を差し替えます。よろしいですか?')) return;
      applyPreset(key);
      setStatus('#data-status', '');
    });
    $('#btn-add-busy-date').addEventListener('click', function () {
      const input = $('#store-busy-date');
      const value = input.value;
      if (!value) return;
      data.store.busyDates = data.store.busyDates || [];
      if (data.store.busyDates.indexOf(value) < 0) data.store.busyDates.push(value);
      input.value = '';
      save();
      renderBusyDates();
    });
    $('#btn-add-slot').addEventListener('click', function () {
      const id = nextId('slot', data.store.slots);
      data.store.slots.push({
        id: id, name: '時間帯' + (data.store.slots.length + 1), start: '', end: '',
        required: 2, requiredWeekend: null, requiredByRole: {}, leaderLevel: 0,
        requiresOpen: false, requiresClose: false,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      });
      // 既存スタッフは新しい時間帯にも対応できる扱いにする
      data.staff.forEach(function (p) {
        if (Array.isArray(p.availableSlots)) p.availableSlots.push(id);
      });
      save();
      renderSlots();
      renderStaffTable();
    });

    $('#form-generate').addEventListener('submit', onGenerate);
    $('#btn-csv-grid').addEventListener('click', function () {
      if (lastResult && lastResult.ok) download(csvName('grid'), '\ufeff' + S.toCsvMatrix(lastResult), 'text/csv;charset=utf-8');
    });
    $('#btn-csv-date').addEventListener('click', function () {
      if (lastResult && lastResult.ok) download(csvName('by-date'), '﻿' + S.toCsvByDate(lastResult), 'text/csv;charset=utf-8');
    });
    $('#btn-csv-staff').addEventListener('click', function () {
      if (lastResult && lastResult.ok) download(csvName('by-staff'), '﻿' + S.toCsvByStaff(lastResult), 'text/csv;charset=utf-8');
    });
    $('#btn-print').addEventListener('click', function () { window.print(); });

    $('#btn-sample').addEventListener('click', function () {
      if (data.staff.length && !window.confirm('いまの内容をサンプルで置き換えますか?')) return;
      const sample = S.sampleData($('#sample-select').value);
      data.store = sample.store;
      data.staff = sample.staff;
      save();
      renderAll();
      setStatus('#data-status', 'サンプルを読み込みました');
    });
    $('#btn-export').addEventListener('click', exportJson);
    $('#btn-import').addEventListener('click', function () { $('#import-file').click(); });
    $('#import-file').addEventListener('change', function (e) {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (!parsed || typeof parsed !== 'object' || !parsed.store) throw new Error('形式が違います');
          data = {
            store: Object.assign(defaultData().store, parsed.store),
            staff: Array.isArray(parsed.staff) ? parsed.staff : [],
            options: Object.assign(Object.assign({}, S.DEFAULT_OPTIONS), parsed.options || {}),
          };
          save();
          renderAll();
          setStatus('#data-status', '読み込みました');
        } catch (err) {
          setStatus('#data-status', '読み込めませんでした(JSON の形式を確認してください)');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#btn-clear').addEventListener('click', function () {
      if (!window.confirm('登録したスタッフ・店舗設定をすべて消します。よろしいですか?')) return;
      data = defaultData();
      save();
      renderAll();
      lastResult = null;
      $('#result').hidden = true;
      setStatus('#data-status', 'すべて消しました');
    });

    renderAll();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
