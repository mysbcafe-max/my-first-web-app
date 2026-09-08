'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

// 通常スタッフ 1 カウント / 時短スタッフ 0.5 カウント
function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-07',
    closedWeekdays: [],
    closedDates: [],
    roles: [],
    slots: [
      { id: 'c', name: 'C(早番)', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

function full(id, over) {
  return Object.assign({ id: id, name: id, level: 3, targetDays: 7 }, over || {});
}

function short(id, over) {
  return Object.assign({ id: id, name: id, level: 3, targetDays: 7, endLimit: '16:00' }, over || {});
}

function run(store, staff, options) {
  return S.generate({ store: store, staff: staff, options: Object.assign({ maxConsecutiveDays: 0 }, options || {}) });
}

function eachCell(r, fn) {
  r.days.forEach((day) => day.cells.forEach((cell) => fn(cell, day)));
}

// ---------------- カウントの数え方 ----------------

test('通常スタッフは1カウント、時短スタッフは0.5カウント', () => {
  const r = run(makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 1.5, requiredByRole: {}, leaderLevel: 0 },
  ] }), [full('a'), short('s')]);
  eachCell(r, (cell, day) => {
    const a = cell.assigned.find((x) => x.id === 'a');
    const s = cell.assigned.find((x) => x.id === 's');
    if (a) assert.strictEqual(a.count, 1, day.date);
    if (s) assert.strictEqual(s.count, 0.5, day.date);
  });
});

test('カウント合計が必要量に届くまで人を足す', () => {
  // 必要 4.5。通常4人(4.0)では足りず、5人目が入る
  const store = makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 4.5, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const staff = [full('a'), full('b'), full('c'), full('d'), full('e')];
  const r = run(store, staff);
  eachCell(r, (cell, day) => {
    assert.ok(cell.assignedCount >= 4.5, day.date + ': ' + cell.assignedCount);
    assert.strictEqual(cell.assigned.length, 5, day.date);
    assert.strictEqual(cell.shortCount, 0);
  });
});

test('端数は時短スタッフでちょうど埋める(余分に人を使わない)', () => {
  // 必要 4.5。通常4人 + 時短1人 = 4.5 ちょうど
  const store = makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 4.5, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const staff = [full('a'), full('b'), full('c'), full('d'), short('s'), full('e')];
  const r = run(store, staff);
  eachCell(r, (cell, day) => {
    assert.strictEqual(cell.assignedCount, 4.5, day.date + ' の合計が ' + cell.assignedCount);
    assert.strictEqual(cell.assigned.length, 5, day.date);
    assert.ok(cell.assigned.some((x) => x.count === 0.5), day.date + ' に時短が入っていない');
  });
});

test('人数カウントを手で指定できる', () => {
  const store = makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
  ] });
  // 時短でもカウント1として扱う / 通常でも0.5として扱う
  const r = run(store, [short('s', { headcount: 1 }), full('a', { headcount: 0.5 })]);
  eachCell(r, (cell) => {
    const s = cell.assigned.find((x) => x.id === 's');
    const a = cell.assigned.find((x) => x.id === 'a');
    if (s) assert.strictEqual(s.count, 1);
    if (a) assert.strictEqual(a.count, 0.5);
  });
});

test('カウントが足りないときは不足として警告する(自動調整オフ)', () => {
  const store = makeStore({ autoRelax: false, slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 4.5, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const r = run(store, [full('a'), short('s')]);
  eachCell(r, (cell) => {
    assert.strictEqual(cell.assignedCount, 1.5);
    assert.strictEqual(cell.shortCount, 3);
  });
  const w = r.warnings.filter((x) => x.type === 'shortage');
  assert.strictEqual(w.length, 7);
  assert.ok(/3カウント不足/.test(w[0].message), w[0].message);
  assert.ok(/1\.5\/4\.5カウント/.test(w[0].message), w[0].message);
});

// ---------------- 1日の合計カウント ----------------

function twoSlotStore(over) {
  return Object.assign(makeStore(), {
    dayMinCount: 4.5,
    dayMinCountWeekend: 5,
    slots: [
      { id: 'c', name: 'C(早番)', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

test('1日の合計カウントは平日4.5・土日5を満たす', () => {
  const staff = [];
  for (let i = 0; i < 6; i += 1) staff.push(full('f' + i));
  staff.push(short('s1'));
  staff.push(short('s2'));
  const r = run(twoSlotStore(), staff);
  r.days.forEach((day) => {
    const expected = (day.weekday === 0 || day.weekday === 6) ? 5 : 4.5;
    assert.strictEqual(day.dayRequired, expected, day.date);
    assert.ok(day.assignedCount >= expected, day.date + ': ' + day.assignedCount + ' < ' + expected);
    assert.strictEqual(day.dayShort, 0, day.date);
  });
});

test('1日の合計は枠ごとの必要人数を満たしたうえで足りるまで足す', () => {
  const staff = [];
  for (let i = 0; i < 6; i += 1) staff.push(full('f' + i));
  const r = run(twoSlotStore(), staff);
  r.days.forEach((day) => {
    // 枠ごとに最低2人ずつ入る
    day.cells.forEach((cell) => assert.ok(cell.assigned.length >= 2, day.date + ' ' + cell.slot.name));
    assert.ok(day.assignedCount >= day.dayRequired, day.date);
  });
});

test('1日の合計が足りなければ日単位の警告を出す', () => {
  const r = run(twoSlotStore(), [full('a'), full('b'), full('c'), full('d')]);
  const w = r.warnings.filter((x) => x.type === 'dayShortage');
  assert.ok(w.length > 0);
  assert.ok(/1日の合計が/.test(w[0].message), w[0].message);
  assert.ok(/カウント/.test(w[0].message));
});

test('1日の下限を設定しなければ枠ごとの必要量だけで組む', () => {
  const store = twoSlotStore({ dayMinCount: null, dayMinCountWeekend: null });
  const staff = [];
  for (let i = 0; i < 6; i += 1) staff.push(full('f' + i));
  const r = run(store, staff);
  r.days.forEach((day) => {
    assert.strictEqual(day.dayRequired, 0, day.date);
    assert.strictEqual(day.dayShort, 0, day.date);
    assert.strictEqual(day.assignedCount, 4, day.date); // 2 + 2
  });
});

test('祝日は土日と同じ1日の下限になる', () => {
  const store = twoSlotStore({ periodStart: '2026-09-21', periodEnd: '2026-09-23' });
  const staff = [];
  for (let i = 0; i < 8; i += 1) staff.push(full('f' + i));
  const r = run(store, staff);
  r.days.forEach((day) => {
    assert.strictEqual(day.dayRequired, 5, day.date + ' ' + day.holidayName);
    assert.ok(day.holidayName, day.date);
  });
});

// ---------------- 集計・出力 ----------------

test('集計はカウントと実人数の両方を持つ', () => {
  const store = makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 1.5, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const r = run(store, [full('a'), short('s')]);
  assert.strictEqual(r.stats.requiredTotal, 10.5);   // 1.5 × 7日
  assert.strictEqual(r.stats.assignedTotal, 10.5);
  assert.strictEqual(r.stats.assignedPeople, 14);    // 2人 × 7日
  assert.strictEqual(r.stats.shortage, 0);
});

test('CSV にカウントが出る', () => {
  const store = makeStore({ slots: [
    { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 1.5, requiredByRole: {}, leaderLevel: 0 },
  ] });
  const r = run(store, [full('a'), short('s')]);
  const csv = S.toCsvByDate(r);
  assert.ok(csv.indexOf('0.5カウント') >= 0, 'CSV に 0.5 カウントが出ていない');
  assert.ok(csv.indexOf('1カウント') >= 0);
});

test('カウントの表示は整数なら小数点を出さない', () => {
  assert.strictEqual(S.formatCount(3), '3');
  assert.strictEqual(S.formatCount(4.5), '4.5');
  assert.strictEqual(S.formatCount(0.5), '0.5');
  assert.strictEqual(S.formatCount(5.0), '5');
});

test('au ショップのサンプルは平日4・土日祝5で組まれる', () => {
  const d = S.sampleData('aushop', '2026-10-05');
  assert.strictEqual(d.store.dayMinCount, 4);
  assert.strictEqual(d.store.dayMinCountWeekend, 5);
  const r = S.generate({ store: d.store, staff: d.staff });
  const met = r.days.filter((day) => day.assignedCount >= day.dayRequired).length;
  assert.ok(met >= r.days.length - 1, '満たせなかった日が多すぎる: ' + (r.days.length - met));
  // 時短スタッフが 0.5 として数えられている
  const hasHalf = r.days.some((day) => day.cells.some((c) => c.assigned.some((a) => a.count === 0.5)));
  assert.ok(hasHalf, '時短スタッフが 0.5 カウントになっていない');
});

test('au ショップのひな形は平日4・土日祝5の下限になる', () => {
  const parts = S.presetToStore('aushop');
  assert.strictEqual(parts.dayMinCount, 4);
  assert.strictEqual(parts.dayMinCountWeekend, 5);
  const d = S.sampleData('aushop', '2026-10-05');
  const r = S.generate({ store: Object.assign({}, d.store, { autoRelax: false }), staff: d.staff });
  r.days.filter((day) => !day.closed).forEach((day) => {
    assert.strictEqual(day.dayRequired, day.busy ? 5 : 4, day.date);
  });
});

// ---------------- 人手が足りないときの自動調整 ----------------

function relaxStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    closedWeekdays: [],
    closedDates: [],
    roles: [],
    dayMinCount: 4.5,
    dayMinCountWeekend: 5,
    slots: [
      { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: 'B', start: '10:30', end: '19:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

// 少し人手が足りない状態(公休9日の社員5人 = 110日ぶん、必要は約140)
function tightStaff() {
  const out = [];
  for (let i = 0; i < 5; i += 1) {
    out.push({ id: 'e' + i, name: 'E' + i, level: 3, dayCountMode: 'holiday', holidayDays: 9 });
  }
  return out;
}

test('足りない日が出るなら平日の下限を自動で下げる', () => {
  const r = run(relaxStore(), tightStaff());
  assert.strictEqual(r.relaxed.applied, true, '自動調整が働いていない');
  assert.ok(r.relaxed.shed > 0);
  // 平日の下限が下がっていること
  const weekdayMins = r.days.filter((d) => !d.busy).map((d) => d.dayRequired);
  assert.ok(Math.min.apply(null, weekdayMins) < 4.5, '平日の下限が下がっていない');
  assert.ok(r.warnings.some((w) => w.type === 'relaxed'));
});

test('土日祝の下限は下げない', () => {
  const r = run(relaxStore(), tightStaff());
  r.days.filter((d) => d.busy).forEach((d) => {
    assert.strictEqual(d.dayRequired, 5, d.date + ' の土日祝が下がっている');
  });
});

test('自動調整をオフにすると設定どおりのまま(不足はそのまま出る)', () => {
  const r = run(relaxStore({ autoRelax: false }), tightStaff());
  assert.strictEqual(r.relaxed.applied, false);
  r.days.forEach((d) => {
    assert.strictEqual(d.dayRequired, d.busy ? 5 : 4.5, d.date);
  });
  assert.ok(r.warnings.some((w) => w.type === 'dayShortage'), '不足が出ていない');
});

test('自動調整の結果、足りない日が減る', () => {
  const staff = tightStaff();
  const withRelax = run(relaxStore(), staff);
  const without = run(relaxStore({ autoRelax: false }), staff);
  const countShort = (r) => r.days.filter((d) => d.dayShort > 0).length;
  assert.ok(countShort(withRelax) < countShort(without),
    '調整しても足りない日が減っていない: ' + countShort(withRelax) + ' vs ' + countShort(without));
});

test('必要量を満たしたあと、残っている出勤日数は使い切る', () => {
  const r = run(relaxStore(), tightStaff());
  r.staffSummary.forEach((row) => {
    assert.strictEqual(row.assignedDays, row.targetDays,
      row.name + ' の出勤日数が ' + row.assignedDays + '/' + row.targetDays);
  });
});

test('余りを配っても、設定どおりの必要量は超えない', () => {
  // 人が余っている状態(必要 2+2 に対して 10 人が毎日入れる)
  const store = relaxStore({ dayMinCount: null, dayMinCountWeekend: null });
  const staff = [];
  for (let i = 0; i < 10; i += 1) staff.push({ id: 's' + i, name: 'S' + i, level: 3, targetDays: 31 });
  const r = run(store, staff);
  r.days.forEach((day) => {
    assert.strictEqual(day.assignedCount, 4, day.date + ': ' + day.assignedCount);
  });
});

test('au ショップのサンプルは足りない日なしで組める', () => {
  ['2026-09-05', '2026-10-05', '2026-11-05'].forEach((ref) => {
    const d = S.sampleData('aushop', ref);
    const r = S.generate({ store: d.store, staff: d.staff });
    const shortDays = r.days.filter((day) => day.dayShort > 0 || day.cells.some((c) => c.shortCount > 0));
    assert.strictEqual(shortDays.length, 0, ref + ' に足りない日がある: ' + shortDays.map((x) => x.date).join(','));
    // 出勤日数もほぼ使い切れている(設定どおりの必要量に収まらない分だけは残る)
    const lost = r.staffSummary.reduce((n, row) => n + Math.max(0, row.targetDays - row.assignedDays), 0);
    assert.ok(lost <= 1, ref + ' で使い切れなかった出勤日数が ' + lost + '日');
  });
});
