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
    dayMinCount: null,
    dayMinCountWeekend: null,
    slots: [
      { id: 'c', name: 'C', start: '09:30', end: '18:30', required: 2, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

test('必要カウントは期間の営業日ぶんを合計する', () => {
  const b = S.estimateBalance(makeStore(), []);
  assert.strictEqual(b.periodDays, 31);
  assert.strictEqual(b.openDays, 31);
  assert.strictEqual(b.requiredCount, 62); // 2 × 31日
});

test('定休日は必要カウントに含めない', () => {
  // 第1水曜(10/07)を定休日に
  const b = S.estimateBalance(makeStore({ closedRules: [{ weekday: 3, week: 1 }] }), []);
  assert.strictEqual(b.openDays, 30);
  assert.strictEqual(b.requiredCount, 60);
});

test('1日の合計カウントの下限があればそちらを使う', () => {
  const b = S.estimateBalance(makeStore({ dayMinCount: 4.5, dayMinCountWeekend: 5 }), []);
  // 2026年10月は土日9日 + スポーツの日(10/12・月)= 多めに配置する日が10日、平日が21日
  assert.strictEqual(b.requiredCount, (4.5 * 21) + (5 * 10));
  assert.strictEqual(b.requiredCount, 144.5);
});

test('登録した勤務日数を出勤日数に直して合計する', () => {
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 20 },
    { id: 'b', name: 'B', level: 3, dayCountMode: 'holiday', holidayDays: 9 },
  ];
  const b = S.estimateBalance(makeStore(), staff);
  assert.strictEqual(b.rows[0].workDays, 20);
  assert.strictEqual(b.rows[1].workDays, 22); // 31 - 9
  assert.strictEqual(b.supplyDays, 42);
  assert.strictEqual(b.supplyCount, 42);
});

test('店舗の既定が公休日数ならそれに従う', () => {
  const store = makeStore({ dayCountMode: 'holiday' });
  const b = S.estimateBalance(store, [{ id: 'a', name: 'A', level: 3, holidayDays: 10 }]);
  assert.strictEqual(b.rows[0].mode, 'holiday');
  assert.strictEqual(b.rows[0].workDays, 21);
});

test('時短の人は 0.5 カウントとして見積もる', () => {
  const staff = [
    { id: 'f', name: 'フル', level: 3, targetDays: 20 },
    { id: 's', name: '時短', level: 3, targetDays: 20, endLimit: '16:00' },
  ];
  const b = S.estimateBalance(makeStore(), staff);
  assert.strictEqual(b.rows[0].headcount, 1);
  assert.strictEqual(b.rows[1].headcount, 0.5);
  assert.strictEqual(b.supplyDays, 40);
  assert.strictEqual(b.supplyCount, 30); // 20 + 20×0.5
});

test('人数カウントを手で指定していればそれを使う', () => {
  const staff = [{ id: 'a', name: 'A', level: 3, targetDays: 10, headcount: 0.5 }];
  const b = S.estimateBalance(makeStore(), staff);
  assert.strictEqual(b.rows[0].headcount, 0.5);
  assert.strictEqual(b.supplyCount, 5);
});

test('過不足がわかる', () => {
  const store = makeStore(); // 必要 62
  const few = S.estimateBalance(store, [{ id: 'a', name: 'A', level: 3, targetDays: 20 }]);
  assert.ok(few.diff < 0, '足りないのに diff が負でない');
  assert.strictEqual(few.diff, 20 - 62);

  const many = S.estimateBalance(store, [
    { id: 'a', name: 'A', level: 3, targetDays: 31 },
    { id: 'b', name: 'B', level: 3, targetDays: 31 },
    { id: 'c', name: 'C', level: 3, targetDays: 31 },
  ]);
  assert.ok(many.diff > 0, '多いのに diff が正でない');
});

test('見積もりと実際の生成結果が食い違わない', () => {
  const d = S.sampleData('aushop', '2026-10-05');
  const b = S.estimateBalance(d.store, d.staff);
  const r = S.generate({ store: d.store, staff: d.staff });
  // 自動調整で必要量が下がるので、見積もりは調整前の必要量と一致する
  // 平日4 × 21日 + 土日祝5 × 10日 = 134
  assert.strictEqual(b.requiredCount, 134);
  assert.ok(r.stats.requiredTotal <= b.requiredCount, '調整後の必要量が見積もりを超えている');
  // 登録した勤務日数の合計は生成結果の目標と一致する
  const targetTotal = r.staffSummary.reduce((n, x) => n + x.targetDays, 0);
  assert.strictEqual(b.supplyDays, targetTotal);
});

test('スタッフが空でも落ちない', () => {
  const b = S.estimateBalance(makeStore(), []);
  assert.strictEqual(b.supplyDays, 0);
  assert.strictEqual(b.supplyCount, 0);
  assert.deepStrictEqual(b.rows, []);
});
