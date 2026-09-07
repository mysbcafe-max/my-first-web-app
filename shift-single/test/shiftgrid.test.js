'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-07',
    closedWeekdays: [],
    closedRules: [],
    closedDates: [],
    roles: [],
    slots: [
      { id: 'c', name: 'C(早番)', start: '09:30', end: '18:30', required: 1, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 1, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

function run(store, staff, options) {
  return S.generate({ store: store, staff: staff, options: Object.assign({ maxConsecutiveDays: 0 }, options || {}) });
}

test('シフト表は 縦=スタッフ / 横=日付 になる', () => {
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 7 },
    { id: 'b', name: 'B', level: 3, targetDays: 7 },
  ];
  const r = run(makeStore(), staff);
  const m = S.toStaffMatrix(r);

  assert.strictEqual(m.days.length, 7, '日付の数');
  assert.strictEqual(m.rows.length, 2, 'スタッフの数');
  assert.deepStrictEqual(m.days.map((d) => d.day), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepStrictEqual(m.rows.map((x) => x.name), ['A', 'B']);
  m.rows.forEach((row) => assert.strictEqual(row.cells.length, 7, row.name + ' のマス数'));
});

test('マスにはその日入る時間帯の略称が入る', () => {
  const staff = [{ id: 'a', name: 'A', level: 3, targetDays: 7, availableSlots: ['c'] }];
  const r = run(makeStore(), staff);
  const m = S.toStaffMatrix(r);
  m.rows[0].cells.forEach((c, i) => {
    assert.ok(c, m.days[i].date + ' が空');
    assert.strictEqual(c.short, 'C');
    assert.strictEqual(c.slotName, 'C(早番)');
    assert.strictEqual(c.start, '09:30');
    assert.strictEqual(c.end, '18:30');
  });
});

test('休みの日は空(null)になる', () => {
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 3 },
    { id: 'b', name: 'B', level: 3, targetDays: 7 },
    { id: 'c', name: 'C', level: 3, targetDays: 7 },
  ];
  const r = run(makeStore(), staff);
  const m = S.toStaffMatrix(r);
  const row = m.rows.find((x) => x.id === 'a');
  const worked = row.cells.filter(Boolean).length;
  assert.strictEqual(worked, row.assignedDays, 'マスの数と出勤日数が合わない');
  assert.ok(worked <= 3, '出勤日数の上限を超えている');
  assert.strictEqual(row.cells.length - worked, row.restDays, '残りは休み');
});

test('定休日の列は closed になり、マスも空になる', () => {
  const staff = [{ id: 'a', name: 'A', level: 3, targetDays: 7 }];
  // 2026-10-07 は水曜。第1水曜を定休日にする
  const r = run(makeStore({ closedRules: [{ weekday: 3, week: 1 }] }), staff);
  const m = S.toStaffMatrix(r);
  const idx = m.days.findIndex((d) => d.date === '2026-10-07');
  assert.strictEqual(m.days[idx].closed, true);
  assert.strictEqual(m.rows[0].cells[idx], null);
});

test('時短の人はマスに実際の勤務時間が入る', () => {
  const staff = [{ id: 's', name: '時短', level: 3, targetDays: 7, endLimit: '16:00', availableSlots: ['c'] }];
  const r = run(makeStore(), staff);
  const m = S.toStaffMatrix(r);
  const cell = m.rows[0].cells.find(Boolean);
  assert.strictEqual(cell.shortened, true);
  assert.strictEqual(cell.end, '16:00');
  assert.strictEqual(cell.count, 0.5);
});

test('行に出勤日数と休みの日数が入る', () => {
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 5 },
    { id: 'b', name: 'B', level: 3, targetDays: 7 },
    { id: 'c', name: 'C', level: 3, targetDays: 7 },
  ];
  const r = run(makeStore(), staff);
  const m = S.toStaffMatrix(r);
  const row = m.rows.find((x) => x.id === 'a');
  assert.ok(row.assignedDays <= 5, '出勤日数の上限を超えている');
  assert.strictEqual(row.assignedDays + row.restDays, m.days.length, '出勤 + 休み = 期間の日数');
  assert.strictEqual(row.cells.filter(Boolean).length, row.assignedDays);
});

test('日付の列に曜日・祝日・土日の情報が入る', () => {
  const staff = [{ id: 'a', name: 'A', level: 3, targetDays: 7 }];
  const r = run(makeStore({ periodStart: '2026-10-10', periodEnd: '2026-10-13' }), staff);
  const m = S.toStaffMatrix(r);
  const byDate = {};
  m.days.forEach((d) => { byDate[d.date] = d; });
  assert.strictEqual(byDate['2026-10-10'].weekdayLabel, '土');
  assert.strictEqual(byDate['2026-10-10'].busy, true);
  assert.strictEqual(byDate['2026-10-12'].holidayName, 'スポーツの日');
  assert.strictEqual(byDate['2026-10-12'].busy, true);
  assert.strictEqual(byDate['2026-10-13'].busy, false);
});

test('略称は「C(早番)」→「C」のように短くする', () => {
  assert.strictEqual(S.slotShortName({ name: 'C(早番)' }), 'C');
  assert.strictEqual(S.slotShortName({ name: 'B(遅番)' }), 'B');
  assert.strictEqual(S.slotShortName({ name: '早番' }), '早番');
  assert.strictEqual(S.slotShortName({ name: 'とても長い名前の時間帯' }), 'とても長', '長い名前は4文字に切る');
});

test('CSV はそのまま貼れる表の形になる', () => {
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 7, availableSlots: ['c'] },
    { id: 'b', name: 'B', level: 3, targetDays: 7, availableSlots: ['b'] },
  ];
  const r = run(makeStore({ closedRules: [{ weekday: 3, week: 1 }] }), staff);
  const lines = S.toCsvMatrix(r).split('\n');

  assert.ok(lines[0].startsWith('スタッフ,1(木),2(金)'), lines[0]);
  assert.ok(lines[0].endsWith('出勤,休み'), lines[0]);
  assert.strictEqual(lines.length, 4, 'ヘッダ + スタッフ2行 + 合計行');
  assert.ok(lines[1].startsWith('A,'), lines[1]);
  assert.ok(lines[1].indexOf('休') >= 0, '定休日が 休 になっていない');
  assert.ok(lines[3].startsWith('合計カウント,'), lines[3]);
});

test('時短の人は CSV に勤務時間も出る', () => {
  const staff = [{ id: 's', name: '時短', level: 3, targetDays: 7, endLimit: '16:00', availableSlots: ['c'] }];
  const r = run(makeStore(), staff);
  const csv = S.toCsvMatrix(r);
  assert.ok(csv.indexOf('C(09:30〜16:00)') >= 0, csv.split('\n')[1]);
});

test('au ショップのサンプルで1か月ぶんの表ができる', () => {
  const d = S.sampleData('aushop', '2026-10-05');
  const r = S.generate({ store: d.store, staff: d.staff });
  const m = S.toStaffMatrix(r);
  assert.strictEqual(m.days.length, 31);
  assert.strictEqual(m.rows.length, d.staff.length);
  m.rows.forEach((row) => {
    const worked = row.cells.filter(Boolean).length;
    assert.strictEqual(worked, row.assignedDays, row.name + ': マスの数と出勤日数が合わない');
  });
});
