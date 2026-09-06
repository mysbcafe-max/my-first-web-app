'use strict';

const test = require('node:test');
const assert = require('node:assert');
const H = require('../holidays.js');
const S = require('../scheduler.js');

// ---------------- 祝日の判定 ----------------

test('2026年の祝日をすべて判定できる', () => {
  const expected = {
    '2026-01-01': '元日',
    '2026-01-12': '成人の日',
    '2026-02-11': '建国記念の日',
    '2026-02-23': '天皇誕生日',
    '2026-03-20': '春分の日',
    '2026-04-29': '昭和の日',
    '2026-05-03': '憲法記念日',
    '2026-05-04': 'みどりの日',
    '2026-05-05': 'こどもの日',
    '2026-05-06': '振替休日',
    '2026-07-20': '海の日',
    '2026-08-11': '山の日',
    '2026-09-21': '敬老の日',
    '2026-09-22': '国民の休日',
    '2026-09-23': '秋分の日',
    '2026-10-12': 'スポーツの日',
    '2026-11-03': '文化の日',
    '2026-11-23': '勤労感謝の日',
  };
  Object.keys(expected).forEach((d) => {
    assert.strictEqual(H.nameOf(d), expected[d], d);
  });
});

test('祝日でない日は空文字を返す', () => {
  ['2026-09-06', '2026-10-15', '2026-01-02', '2026-12-25', '2026-05-07'].forEach((d) => {
    assert.strictEqual(H.nameOf(d), '', d);
  });
});

test('日曜が祝日なら翌日以降が振替休日になる', () => {
  // 2026-05-03(日) 憲法記念日 → 5/4・5/5 も祝日なので 5/6 が振替
  assert.strictEqual(H.nameOf('2026-05-06'), '振替休日');
  // 2027-01-01(金) は日曜ではないので振替なし
  assert.strictEqual(H.nameOf('2027-01-02'), '');
});

test('祝日にはさまれた平日は国民の休日になる', () => {
  assert.strictEqual(H.nameOf('2026-09-22'), '国民の休日');
  assert.strictEqual(H.baseName('2026-09-22'), '', '国民の休日は「国民の祝日」そのものではない');
});

test('ハッピーマンデーは年ごとに動く', () => {
  assert.strictEqual(H.nameOf('2027-01-11'), '成人の日'); // 2027年1月第2月曜
  assert.strictEqual(H.nameOf('2027-07-19'), '海の日');   // 2027年7月第3月曜
  assert.strictEqual(H.nameOf('2027-10-11'), 'スポーツの日');
});

test('春分・秋分は年ごとに動く', () => {
  assert.strictEqual(H.nameOf('2027-03-21'), '春分の日');
  assert.strictEqual(H.nameOf('2028-03-20'), '春分の日');
  assert.strictEqual(H.nameOf('2027-09-23'), '秋分の日');
});

test('不正な日付は空文字を返す', () => {
  ['', 'あした', '2026/01/01', '2026-13-01', null, undefined].forEach((d) => {
    assert.strictEqual(H.nameOf(d), '');
  });
});

// ---------------- 生成への反映 ----------------

function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-30',
    closedWeekdays: [],
    closedDates: [],
    roles: [],
    slots: [
      { id: 'a', name: '早番', start: '09:30', end: '18:30', required: 2, requiredWeekend: 4, requiredByRole: {}, leaderLevel: 0 },
    ],
  }, over || {});
}

function staffPool(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ id: 's' + i, name: 'S' + i, level: 3, targetDays: 30 });
  return out;
}

function run(store, staff) {
  return S.generate({ store: store, staff: staff || staffPool(6), options: { maxConsecutiveDays: 0 } });
}

test('祝日は土日と同じ必要人数になる', () => {
  const r = run(makeStore());
  const byDate = {};
  r.days.forEach((d) => { byDate[d.date] = d; });

  assert.strictEqual(byDate['2026-09-21'].holidayName, '敬老の日');
  assert.strictEqual(byDate['2026-09-21'].cells[0].required, 4);
  assert.strictEqual(byDate['2026-09-22'].cells[0].required, 4, '国民の休日');
  assert.strictEqual(byDate['2026-09-23'].cells[0].required, 4, '秋分の日');
  assert.strictEqual(byDate['2026-09-05'].cells[0].required, 4, '土曜');
  assert.strictEqual(byDate['2026-09-07'].cells[0].required, 2, '平日(月)');
});

test('祝日の扱いをやめると平日と同じ人数になる', () => {
  const r = run(makeStore({ useHolidays: false }));
  const byDate = {};
  r.days.forEach((d) => { byDate[d.date] = d; });
  assert.strictEqual(byDate['2026-09-21'].cells[0].required, 2);
  assert.strictEqual(byDate['2026-09-21'].holidayName, '');
  assert.strictEqual(byDate['2026-09-05'].cells[0].required, 4, '土曜は変わらない');
});

test('繁忙日を指定するとその日も多めになる', () => {
  const r = run(makeStore({ busyDates: ['2026-09-08'] }));
  const byDate = {};
  r.days.forEach((d) => { byDate[d.date] = d; });
  assert.strictEqual(byDate['2026-09-08'].cells[0].required, 4);
  assert.strictEqual(byDate['2026-09-08'].busy, true);
  assert.strictEqual(byDate['2026-09-09'].cells[0].required, 2);
});

test('土日祝の人数を設定していなければ平日と同じ', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', start: '09:30', end: '18:30', required: 3, requiredByRole: {}, leaderLevel: 0 }],
  });
  const r = run(store);
  r.days.forEach((d) => assert.strictEqual(d.cells[0].required, 3, d.date));
});

test('祝日でも定休日なら休みのまま', () => {
  // 2026-09-21 は月曜。月曜定休にすると祝日でも枠は作らない
  const r = run(makeStore({ closedWeekdays: [1] }));
  const day = r.days.find((d) => d.date === '2026-09-21');
  assert.strictEqual(day.closed, true);
  assert.strictEqual(day.cells.length, 0);
  assert.strictEqual(day.holidayName, '敬老の日');
});

test('CSV と表示用マトリクスに祝日名が出る', () => {
  const r = run(makeStore());
  const csv = S.toCsvByDate(r);
  assert.ok(csv.split('\n')[0].indexOf('祝日') >= 0);
  assert.ok(csv.indexOf('敬老の日') >= 0);

  const matrix = S.toMatrix(r);
  const row = matrix.find((x) => x.date === '2026-09-23');
  assert.strictEqual(row.holidayName, '秋分の日');
  assert.strictEqual(row.busy, true);
});

test('シルバーウィークのように祝日が続いても正しく多めになる', () => {
  const r = run(makeStore({ periodStart: '2026-09-19', periodEnd: '2026-09-23' }));
  // 9/19(土) 9/20(日) 9/21(月・敬老) 9/22(火・国民) 9/23(水・秋分) すべて 4 人
  r.days.forEach((d) => {
    assert.strictEqual(d.cells[0].required, 4, d.date + ' ' + d.weekdayLabel);
    assert.strictEqual(d.busy, true, d.date);
  });
});
