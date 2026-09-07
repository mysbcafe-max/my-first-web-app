'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

const ROLES = [{ id: 'r1', name: 'フロア' }, { id: 'r2', name: 'カウンター' }];

// 営業 10:00〜19:00 を想定し、B(10:30〜19:30) は締め作業あり、C(09:30〜18:30) は開店準備あり
function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-07',
    closedWeekdays: [],
    closedDates: [],
    roles: ROLES,
    slots: [
      { id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresClose: true },
    ],
  }, over || {});
}

function makeStaff(over) {
  return Object.assign({
    id: 'x', name: 'X', level: 3, roles: ['r1', 'r2'], targetDays: 7,
  }, over || {});
}

function run(store, staff, options) {
  return S.generate({ store: store, staff: staff, options: Object.assign({ maxConsecutiveDays: 0 }, options || {}) });
}

function eachCell(result, fn) {
  result.days.forEach((day) => day.cells.forEach((cell) => fn(cell, day)));
}

// ---------------- 勤務時間(時短) ----------------

test('時短の人は実際の勤務終了時刻で記録される', () => {
  const staff = [
    makeStaff({ id: 'full', name: 'フル' }),
    makeStaff({ id: 'short', name: '時短', endLimit: '16:00' }),
  ];
  const r = run(makeStore(), staff);
  eachCell(r, (cell) => {
    const short = cell.assigned.find((a) => a.id === 'short');
    const full = cell.assigned.find((a) => a.id === 'full');
    if (short) {
      assert.strictEqual(short.start, '10:30');
      assert.strictEqual(short.end, '16:00');
      assert.strictEqual(short.shortened, true);
      assert.strictEqual(short.coversClose, false);
    }
    if (full) {
      assert.strictEqual(full.end, '19:30');
      assert.strictEqual(full.shortened, false);
      assert.strictEqual(full.coversClose, true);
    }
  });
});

test('遅く出勤する人は開店準備の時間に間に合わない扱いになる', () => {
  const store = makeStore({
    slots: [{ id: 'c', name: 'C(早番)', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresOpen: true }],
  });
  const staff = [
    makeStaff({ id: 'early', name: '早く来られる' }),
    makeStaff({ id: 'late', name: '遅出', startLimit: '11:00' }),
  ];
  const r = run(store, staff);
  eachCell(r, (cell) => {
    const late = cell.assigned.find((a) => a.id === 'late');
    if (late) {
      assert.strictEqual(late.start, '11:00');
      assert.strictEqual(late.coversOpen, false);
    }
    // 開店準備を担当できる人が必ずいる
    assert.ok(cell.assigned.some((a) => a.canOpen && a.coversOpen), '開店担当がいない');
  });
});

test('枠と勤務時間がまったく重ならない人はその枠に入らない', () => {
  const store = makeStore({
    slots: [{ id: 'b', name: 'B', start: '15:00', end: '19:30', required: 1, requiredByRole: {}, leaderLevel: 0 }],
  });
  const staff = [
    makeStaff({ id: 'morning', name: '午前のみ', endLimit: '12:00' }),
    makeStaff({ id: 'ok', name: '通常' }),
  ];
  const r = run(store, staff);
  eachCell(r, (cell) => {
    assert.ok(!cell.assigned.some((a) => a.id === 'morning'), '時間が合わない人が入っている');
  });
  const morning = r.staffSummary.find((x) => x.id === 'morning');
  assert.strictEqual(morning.assignedDays, 0);
});

// ---------------- 締め作業の担保(今回の主目的) ----------------

test('時短スタッフを入れる日は、別の締め作業ができる人を必ず入れる', () => {
  const staff = [
    makeStaff({ id: 's1', name: '時短1', endLimit: '16:00', canClose: false }),
    makeStaff({ id: 's2', name: '時短2', endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'c1', name: '締め可1' }),
    makeStaff({ id: 'c2', name: '締め可2' }),
  ];
  const r = run(makeStore({ slots: [
    { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 3, requiredByRole: {}, leaderLevel: 0, requiresClose: true },
  ] }), staff);

  eachCell(r, (cell, day) => {
    const closers = cell.assigned.filter((a) => a.canClose && a.coversClose);
    assert.ok(closers.length >= 1, day.date + ' に締め作業ができる人がいない');
    assert.strictEqual(cell.noCloser, false);
  });
  assert.strictEqual(r.warnings.filter((w) => w.type === 'close').length, 0);
});

test('締め作業ができる人が枠にいなければ警告を出す', () => {
  const staff = [
    makeStaff({ id: 's1', name: '時短1', endLimit: '16:00' }),
    makeStaff({ id: 's2', name: '締め不可', canClose: false }),
  ];
  const r = run(makeStore(), staff);
  const closeWarn = r.warnings.filter((w) => w.type === 'close');
  assert.strictEqual(closeWarn.length, 7, '7日ぶんの警告が出るはず');
  assert.ok(/締め作業/.test(closeWarn[0].message));
  // 枠自体は埋まる(人は入れる)
  eachCell(r, (cell) => assert.strictEqual(cell.assigned.length, 2));
});

test('締め作業ができる人がそもそも登録されていなければ設定の警告を出す', () => {
  const staff = [makeStaff({ id: 'a', name: 'A', canClose: false })];
  const r = run(makeStore(), staff);
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /締め作業ができるスタッフが登録されていません/.test(w.message)));
});

test('締め作業なしの枠では締めの制約を課さない', () => {
  const store = makeStore({
    slots: [{ id: 'b', name: 'B', start: '10:30', end: '19:30', required: 1, requiredByRole: {}, leaderLevel: 0, requiresClose: false }],
  });
  const staff = [makeStaff({ id: 's', name: '時短', endLimit: '16:00', canClose: false })];
  const r = run(store, staff);
  assert.strictEqual(r.warnings.filter((w) => w.type === 'close').length, 0);
  eachCell(r, (cell) => assert.strictEqual(cell.assigned.length, 1));
});

test('締め担当は役割の必須人数とも両立する', () => {
  const store = makeStore({
    slots: [{ id: 'b', name: 'B', start: '10:30', end: '19:30', required: 2, requiredByRole: { r1: 1, r2: 1 }, leaderLevel: 0, requiresClose: true }],
  });
  const staff = [
    makeStaff({ id: 'f', name: 'フロア専任(時短)', roles: ['r1'], endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'c', name: 'カウンター専任', roles: ['r2'] }),
  ];
  const r = run(store, staff);
  eachCell(r, (cell, day) => {
    assert.strictEqual(cell.unfilled.length, 0, day.date + ' に不足');
    assert.strictEqual(cell.assigned.filter((a) => a.role === 'r1').length, 1);
    assert.strictEqual(cell.assigned.filter((a) => a.role === 'r2').length, 1);
    assert.ok(cell.assigned.some((a) => a.canClose && a.coversClose), day.date + ' に締め担当がいない');
  });
});

// ---------------- 公休日数 ----------------

test('公休日数で設定すると「期間の全日数 − 公休日数」が出勤日数になる', () => {
  // 2026-10-01 〜 2026-10-31 = 31日
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-31' });
  const staff = [makeStaff({ id: 'a', name: 'A', dayCountMode: 'holiday', holidayDays: 9 })];
  const r = run(store, staff);
  const row = r.staffSummary[0];
  assert.strictEqual(row.dayCountMode, 'holiday');
  assert.strictEqual(row.targetDays, 22); // 31 - 9
  assert.strictEqual(row.inputDays, 9);
  assert.strictEqual(row.assignedDays, 22);
  assert.strictEqual(row.restDays, 9);
});

test('定休日があっても公休は期間の全日数から引く', () => {
  // 10月は火曜が4回。定休日にしても公休の計算は全日数(31日)基準
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-31', closedWeekdays: [2] });
  const staff = [makeStaff({ id: 'a', name: 'A', dayCountMode: 'holiday', holidayDays: 9 })];
  const r = run(store, staff);
  assert.strictEqual(r.staffSummary[0].targetDays, 22);
  // 営業日は27日なので22日は入れる
  assert.strictEqual(r.staffSummary[0].assignedDays, 22);
});

test('出勤日数と公休日数をスタッフごとに使い分けられる', () => {
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-31', slots: [
    { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 3, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const staff = [
    makeStaff({ id: 'emp', name: '社員', dayCountMode: 'holiday', holidayDays: 9 }),
    makeStaff({ id: 'part', name: 'アルバイト', dayCountMode: 'work', targetDays: 8 }),
    makeStaff({ id: 'def', name: '既定にまかせる', targetDays: 15 }),
  ];
  const r = run(store, staff);
  const by = {};
  r.staffSummary.forEach((x) => { by[x.id] = x; });
  assert.strictEqual(by.emp.targetDays, 22);
  assert.strictEqual(by.part.targetDays, 8);
  assert.strictEqual(by.def.targetDays, 15);       // 店舗既定は出勤日数
  assert.strictEqual(by.def.dayCountMode, 'work');
});

test('店舗の既定を公休日数にすると、未指定のスタッフもそれに従う', () => {
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-31', dayCountMode: 'holiday' });
  const staff = [makeStaff({ id: 'a', name: 'A', holidayDays: 10 })];
  const r = run(store, staff);
  assert.strictEqual(r.staffSummary[0].dayCountMode, 'holiday');
  assert.strictEqual(r.staffSummary[0].targetDays, 21);
});

test('公休が足りない人の警告は公休の言い方で出る', () => {
  // 必要人数が少ないので全員は入れず、公休が増える
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-31', slots: [
    { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 1, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const staff = [
    makeStaff({ id: 'a', name: 'A', dayCountMode: 'holiday', holidayDays: 9 }),
    makeStaff({ id: 'b', name: 'B', dayCountMode: 'holiday', holidayDays: 9 }),
  ];
  const r = run(store, staff);
  const unmet = r.warnings.filter((w) => w.type === 'unmet');
  assert.ok(unmet.length > 0);
  assert.ok(/公休が/.test(unmet[0].message), unmet[0].message);
});

test('公休日数が期間の全日数以上なら設定の警告を出す', () => {
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-10-07' });
  const staff = [makeStaff({ id: 'a', name: 'A', dayCountMode: 'holiday', holidayDays: 10 })];
  const r = run(store, staff);
  assert.strictEqual(r.staffSummary[0].targetDays, 0);
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /公休日数が期間の全日数以上/.test(w.message)));
});

// ---------------- サンプル ----------------

test('au ショップのサンプルは締め作業を必ず満たす', () => {
  const d = S.sampleData('aushop', '2026-10-05');
  const r = S.generate({ store: d.store, staff: d.staff });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.warnings.filter((w) => w.type === 'close').length, 0, '締め作業の警告が出ている');
  r.days.forEach((day) => day.cells.forEach((cell) => {
    if (!cell.slot.requiresClose) return;
    assert.ok(cell.assigned.some((a) => a.canClose && a.coversClose), day.date + ' ' + cell.slot.name);
  }));
  // 時短スタッフが実際に使われていること
  const shortStaff = r.staffSummary.find((x) => x.endLimit === '16:00');
  assert.ok(shortStaff && shortStaff.assignedDays > 0, '時短スタッフが1日も入っていない');
});

test('CSV に勤務時間と締め・時短の備考が出る', () => {
  const staff = [
    makeStaff({ id: 'c', name: '締め可' }),
    makeStaff({ id: 's', name: '時短', endLimit: '16:00', canClose: false }),
  ];
  const r = run(makeStore(), staff);
  const csv = S.toCsvByDate(r);
  assert.ok(csv.split('\n')[0].indexOf('勤務開始') >= 0);
  assert.ok(csv.indexOf(',10:30,16:00,') >= 0, '時短の時刻が出ていない');
  assert.ok(csv.indexOf('時短') >= 0);
  assert.ok(csv.indexOf('締め') >= 0);

  const csv2 = S.toCsvByStaff(r);
  const head = csv2.split('\n')[0];
  ['勤務時間', '締め作業', '基準', '公休'].forEach((h) => assert.ok(head.indexOf(h) >= 0, h + ' が無い'));
});

// ---------------- 出勤時刻の固定(時短スタッフ) ----------------

function makeTwoSlotStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-07',
    closedWeekdays: [],
    closedDates: [],
    roles: ROLES,
    slots: [
      { id: 'c', name: 'C(早番)', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresOpen: true },
      { id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresClose: true },
    ],
  }, over || {});
}

test('出勤時刻を固定すると、その時刻に始まる枠にしか入らない', () => {
  const staff = [
    makeStaff({ id: 'short', name: '時短', startLimit: '09:30', fixedStart: true, endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'a', name: 'A' }),
    makeStaff({ id: 'b', name: 'B' }),
    makeStaff({ id: 'c', name: 'C' }),
  ];
  const r = run(makeTwoSlotStore(), staff);
  eachCell(r, (cell, day) => {
    const short = cell.assigned.find((a) => a.id === 'short');
    if (!short) return;
    assert.strictEqual(cell.slot.id, 'c', day.date + ': 時短が B(遅番) に入っている');
    assert.strictEqual(short.start, '09:30');
    assert.strictEqual(short.end, '16:00');
  });
  const row = r.staffSummary.find((x) => x.id === 'short');
  assert.ok(row.assignedDays > 0, '時短が1日も入っていない');
  assert.strictEqual(row.bySlot.b, undefined, 'B(遅番) に入っている');
});

test('固定していなければ、時短でも遅番に入れる(締めは別の人が担当)', () => {
  // 遅番だけの店舗にすると、固定していない時短は遅番に入る
  const store = makeTwoSlotStore({
    slots: [{ id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresClose: true }],
  });
  const staff = [
    makeStaff({ id: 'short', name: '時短', endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'closer', name: '締め可' }),
  ];
  const r = run(store, staff);
  const row = r.staffSummary.find((x) => x.id === 'short');
  assert.strictEqual(row.bySlot.b, 7, '固定していないのに遅番へ入らない');
  eachCell(r, (cell) => {
    const short = cell.assigned.find((a) => a.id === 'short');
    assert.strictEqual(short.start, '10:30');
    assert.strictEqual(short.end, '16:00');
    assert.ok(cell.assigned.some((a) => a.canClose && a.coversClose));
  });
});

test('固定していると、その時刻に始まらない枠には入れない', () => {
  const store = makeTwoSlotStore({
    slots: [{ id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0, requiresClose: true }],
  });
  const staff = [
    makeStaff({ id: 'short', name: '時短', startLimit: '09:30', fixedStart: true, endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'closer', name: '締め可' }),
  ];
  const r = run(store, staff);
  assert.strictEqual(r.staffSummary.find((x) => x.id === 'short').assignedDays, 0);
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /出勤時刻を 09:30 で固定/.test(w.message)));
});

test('固定した時刻に始まる枠がなければ設定の警告を出す', () => {
  const staff = [
    makeStaff({ id: 'short', name: '時短', startLimit: '10:00', fixedStart: true, endLimit: '16:00' }),
    makeStaff({ id: 'a', name: 'A' }),
  ];
  const r = run(makeTwoSlotStore(), staff);
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /出勤時刻を 10:00 で固定/.test(w.message)), '警告が出ていない');
  assert.strictEqual(r.staffSummary.find((x) => x.id === 'short').assignedDays, 0);
});

test('時刻を空欄のまま固定にしても影響しない', () => {
  const staff = [
    makeStaff({ id: 'a', name: 'A', fixedStart: true }),
    makeStaff({ id: 'b', name: 'B' }),
  ];
  const r = run(makeTwoSlotStore(), staff);
  assert.ok(r.staffSummary.find((x) => x.id === 'a').assignedDays > 0);
  assert.ok(!r.warnings.some((w) => w.type === 'setup' && /固定/.test(w.message)));
});

test('時短が早番に固定されても、遅番の締め作業は担保される', () => {
  const staff = [
    makeStaff({ id: 's1', name: '時短1', startLimit: '09:30', fixedStart: true, endLimit: '16:00', canClose: false }),
    makeStaff({ id: 's2', name: '時短2', startLimit: '09:30', fixedStart: true, endLimit: '16:00', canClose: false }),
    makeStaff({ id: 'f1', name: 'フル1' }),
    makeStaff({ id: 'f2', name: 'フル2' }),
    makeStaff({ id: 'f3', name: 'フル3' }),
  ];
  const r = run(makeTwoSlotStore(), staff);
  eachCell(r, (cell, day) => {
    if (!cell.slot.requiresClose) return;
    assert.ok(cell.assigned.some((a) => a.canClose && a.coversClose), day.date + ' に締め担当がいない');
    assert.ok(!cell.assigned.some((a) => a.id.slice(0, 1) === 's'), day.date + ' の遅番に時短が入っている');
  });
});

test('au ショップのサンプルでは時短スタッフが早番のみに入る', () => {
  const d = S.sampleData('aushop', '2026-10-05');
  const r = S.generate({ store: d.store, staff: d.staff });
  const short = r.staffSummary.find((x) => x.fixedStart);
  assert.ok(short, '固定設定のサンプルがない');
  assert.strictEqual(short.startLimit, '09:30');
  assert.ok(short.assignedDays > 0);
  const lateSlot = r.slots.find((x) => x.requiresClose);
  assert.strictEqual(short.bySlot[lateSlot.id], undefined, '時短が締めのある枠に入っている');
});

// ---------------- リーダーの確保 ----------------

test('リーダーは全日ぶん先に確保する(人手が限られていても不在にしない)', () => {
  // リーダー(Lv4以上)は2人しかいないが、毎日2枠ぶん必要
  const store = makeStore({
    periodStart: '2026-10-01',
    periodEnd: '2026-10-14',
    slots: [
      { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 4 },
      { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 4 },
    ],
  });
  const staff = [
    makeStaff({ id: 'L1', name: 'リーダー1', level: 5, targetDays: 14 }),
    makeStaff({ id: 'L2', name: 'リーダー2', level: 4, targetDays: 14 }),
  ];
  for (let i = 0; i < 4; i += 1) staff.push(makeStaff({ id: 'n' + i, name: 'N' + i, level: 2, targetDays: 14 }));

  const r = run(store, staff, { maxConsecutiveDays: 0 });
  eachCell(r, (cell, day) => {
    assert.ok(cell.assigned.some((a) => a.level >= 4), day.date + ' ' + cell.slot.name + ' にリーダーがいない');
    assert.strictEqual(cell.noLeader, false);
  });
  assert.strictEqual(r.warnings.filter((w) => w.type === 'leader').length, 0);
});

test('リーダーは候補の少ない役割に入れる(役割の穴を作らない)', () => {
  // リーダー2人はどちらの役割もできる。カウンター専任は1人しかいない
  const store = makeStore({
    slots: [{ id: 'c', name: 'C', start: '09:30', end: '18:30', required: 3, requiredByRole: { r1: 1, r2: 1 }, leaderLevel: 4 }],
  });
  const staff = [
    makeStaff({ id: 'L1', name: 'リーダー', level: 5, roles: ['r1', 'r2'] }),
    makeStaff({ id: 'f1', name: 'フロア1', level: 2, roles: ['r1'] }),
    makeStaff({ id: 'f2', name: 'フロア2', level: 2, roles: ['r1'] }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  eachCell(r, (cell, day) => {
    assert.strictEqual(cell.unfilled.length, 0, day.date + ' に役割の不足がある');
    // リーダーは候補が少ないカウンター側に入る
    const leader = cell.assigned.find((a) => a.id === 'L1');
    assert.strictEqual(leader.role, 'r2', day.date + ': リーダーが ' + leader.role + ' に入っている');
  });
});

test('リーダーがいない枠は同じ日の入れ替えでも直す', () => {
  const store = makeStore({
    periodStart: '2026-10-01',
    periodEnd: '2026-10-03',
    slots: [
      { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 1, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 1, requiredByRole: {}, leaderLevel: 4 },
    ],
  });
  const staff = [
    makeStaff({ id: 'L', name: 'リーダー', level: 5, targetDays: 3 }),
    makeStaff({ id: 'n', name: '一般', level: 2, targetDays: 3 }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  r.days.forEach((day) => {
    const b = day.cells.find((c) => c.slot.id === 'b');
    assert.ok(b.assigned.some((a) => a.level >= 4), day.date + ' の B にリーダーがいない');
  });
});

test('リーダーになれる人が1人もいなければ警告を出す', () => {
  const store = makeStore({
    slots: [{ id: 'c', name: 'C', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 5 }],
  });
  const staff = [makeStaff({ id: 'a', name: 'A', level: 2 }), makeStaff({ id: 'b', name: 'B', level: 3 })];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  assert.ok(r.warnings.filter((w) => w.type === 'leader').length > 0);
  // 枠自体は埋まる
  eachCell(r, (cell) => assert.strictEqual(cell.assigned.length, 2));
});

test('au ショップのサンプルはリーダー不在の日が出ない', () => {
  ['2026-09-05', '2026-10-05', '2026-11-05', '2026-12-05', '2027-01-05'].forEach((ref) => {
    const d = S.sampleData('aushop', ref);
    const r = S.generate({ store: d.store, staff: d.staff });
    const gaps = [];
    r.days.forEach((day) => day.cells.forEach((cell) => {
      if (cell.slot.leaderLevel > 0 && !cell.assigned.some((a) => a.level >= cell.slot.leaderLevel)) {
        gaps.push(day.date + ' ' + cell.slot.name);
      }
    }));
    assert.strictEqual(gaps.length, 0, ref + ' にリーダー不在: ' + gaps.join(', '));
  });
});
