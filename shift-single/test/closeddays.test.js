'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    closedWeekdays: [],
    closedRules: [],
    closedDates: [],
    roles: [],
    slots: [{ id: 'a', name: 'A', start: '09:00', end: '18:00', required: 1, requiredByRole: {}, leaderLevel: 0 }],
  }, over || {});
}

function closedDatesOf(store) {
  const r = S.generate({
    store: store,
    staff: [{ id: 'a', name: 'A', level: 3, targetDays: 31 }],
    options: { maxConsecutiveDays: 0 },
  });
  return r.days.filter((d) => d.closed).map((d) => d.date);
}

// ---------------- 第○曜日 ----------------

test('第1水曜のみを定休日にできる', () => {
  // 2026年10月の水曜: 7, 14, 21, 28
  const closed = closedDatesOf(makeStore({ closedRules: [{ weekday: 3, week: 1 }] }));
  assert.deepStrictEqual(closed, ['2026-10-07']);
});

test('第2・第4火曜を定休日にできる', () => {
  // 2026年10月の火曜: 6, 13, 20, 27
  const closed = closedDatesOf(makeStore({ closedRules: [{ weekday: 2, week: 2 }, { weekday: 2, week: 4 }] }));
  assert.deepStrictEqual(closed, ['2026-10-13', '2026-10-27']);
});

test('最終○曜日を定休日にできる', () => {
  const closed = closedDatesOf(makeStore({ closedRules: [{ weekday: 1, week: 'last' }] }));
  assert.deepStrictEqual(closed, ['2026-10-26']); // 10月の最終月曜
});

test('第5週がない月では第5指定は休みにならない', () => {
  // 2026年11月の水曜: 4, 11, 18, 25(第5水曜はない)
  const store = makeStore({ periodStart: '2026-11-01', periodEnd: '2026-11-30', closedRules: [{ weekday: 3, week: 5 }] });
  assert.deepStrictEqual(closedDatesOf(store), []);
  // 2026年12月の水曜: 2, 9, 16, 23, 30(第5水曜は30日)
  const store2 = makeStore({ periodStart: '2026-12-01', periodEnd: '2026-12-31', closedRules: [{ weekday: 3, week: 5 }] });
  assert.deepStrictEqual(closedDatesOf(store2), ['2026-12-30']);
});

test('第4と最終が同じ日になる月もある', () => {
  // 2026年11月の月曜: 2, 9, 16, 23, 30 → 第4は23、最終は30
  const store = makeStore({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
  assert.deepStrictEqual(closedDatesOf(Object.assign({}, store, { closedRules: [{ weekday: 1, week: 4 }] })), ['2026-11-23']);
  assert.deepStrictEqual(closedDatesOf(Object.assign({}, store, { closedRules: [{ weekday: 1, week: 'last' }] })), ['2026-11-30']);
  // 2026年10月の月曜: 5, 12, 19, 26 → 第4も最終も26
  const oct = makeStore({ closedRules: [{ weekday: 1, week: 4 }, { weekday: 1, week: 'last' }] });
  assert.deepStrictEqual(closedDatesOf(oct), ['2026-10-26']);
});

test('月をまたいでも第○曜日は月ごとに数える', () => {
  const store = makeStore({ periodStart: '2026-10-01', periodEnd: '2026-12-31', closedRules: [{ weekday: 3, week: 1 }] });
  assert.deepStrictEqual(closedDatesOf(store), ['2026-10-07', '2026-11-04', '2026-12-02']);
});

// ---------------- これまでの指定との組み合わせ ----------------

test('毎週の定休日と第○曜日を併用できる', () => {
  const store = makeStore({ closedWeekdays: [0], closedRules: [{ weekday: 3, week: 1 }] });
  const closed = closedDatesOf(store);
  assert.ok(closed.indexOf('2026-10-07') >= 0, '第1水曜が休みでない');
  // 10月の日曜: 4, 11, 18, 25
  ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25'].forEach((d) => {
    assert.ok(closed.indexOf(d) >= 0, d + ' が休みでない');
  });
  assert.strictEqual(closed.length, 5);
});

test('臨時休業日も従来どおり効く', () => {
  const store = makeStore({ closedRules: [{ weekday: 3, week: 1 }], closedDates: ['2026-10-20'] });
  assert.deepStrictEqual(closedDatesOf(store), ['2026-10-07', '2026-10-20']);
});

test('定休日を何も指定しなければ休みなし', () => {
  assert.deepStrictEqual(closedDatesOf(makeStore()), []);
});

test('不正なルールは無視する', () => {
  const store = makeStore({ closedRules: [
    { weekday: 9, week: 1 },      // 曜日が範囲外
    { weekday: 3, week: 0 },      // 週が範囲外
    { weekday: 3, week: 6 },      // 週が範囲外
    { weekday: 3, week: 1 },      // 有効
    { weekday: 3, week: 1 },      // 重複
  ] });
  assert.deepStrictEqual(closedDatesOf(store), ['2026-10-07']);
});

// ---------------- 判定関数 ----------------

test('isClosedDate を単体でも使える', () => {
  const store = { closedWeekdays: [], closedRules: [{ weekday: 3, week: 1 }], closedDates: [] };
  assert.strictEqual(S.isClosedDate(store, '2026-10-07'), true);
  assert.strictEqual(S.isClosedDate(store, '2026-10-14'), false);
});

test('その月の何回目の曜日かを数えられる', () => {
  assert.strictEqual(S.weekdayOccurrence('2026-10-07'), 1);
  assert.strictEqual(S.weekdayOccurrence('2026-10-14'), 2);
  assert.strictEqual(S.weekdayOccurrence('2026-10-28'), 4);
  assert.strictEqual(S.isLastWeekdayOfMonth('2026-10-28'), true);
  assert.strictEqual(S.isLastWeekdayOfMonth('2026-10-21'), false);
});

test('定休日の日はシフトが作られない', () => {
  const r = S.generate({
    store: makeStore({ closedRules: [{ weekday: 3, week: 1 }] }),
    staff: [{ id: 'a', name: 'A', level: 3, targetDays: 31 }],
    options: { maxConsecutiveDays: 0 },
  });
  const day = r.days.find((d) => d.date === '2026-10-07');
  assert.strictEqual(day.closed, true);
  assert.strictEqual(day.cells.length, 0);
  assert.strictEqual(r.stats.closedDays, 1);
  assert.strictEqual(r.stats.openDays, 30);
});
