'use strict';

const test = require('node:test');
const assert = require('node:assert');
const T = require('../trial.js');

function cfg(over) {
  return Object.assign({ storeName: 'テスト店', startDate: '2026-09-15', months: 3, contact: 'test@example.com' }, over || {});
}

test('開始日が未設定なら案内を出さない', () => {
  assert.strictEqual(T.status({}).enabled, false);
  assert.strictEqual(T.status({ startDate: '' }, '2026-09-20').enabled, false);
  assert.strictEqual(T.status({ startDate: 'あした' }, '2026-09-20').enabled, false);
});

test('終了日は「開始日 + 3か月 の前日」になる', () => {
  assert.strictEqual(T.endOf(cfg()), '2026-12-14');
  assert.strictEqual(T.endOf(cfg({ months: 1 })), '2026-10-14');
  assert.strictEqual(T.endOf(cfg({ months: 6 })), '2027-03-14');
});

test('endDate を直接書けばそちらが優先される', () => {
  assert.strictEqual(T.endOf(cfg({ endDate: '2026-11-30' })), '2026-11-30');
});

test('月末をまたいでも日付が繰り上がらない', () => {
  assert.strictEqual(T.addMonths('2026-11-30', 3), '2027-02-28');
  assert.strictEqual(T.addMonths('2026-01-31', 1), '2026-02-28');
  assert.strictEqual(T.addMonths('2027-11-30', 3), '2028-02-29'); // 2028 はうるう年
  assert.strictEqual(T.addMonths('2026-10-15', 3), '2027-01-15'); // 年をまたぐ
});

test('日付によって開始前・試用中・まもなく終了・終了に分かれる', () => {
  const cases = [
    ['2026-09-10', 'before'],
    ['2026-09-15', 'active'],
    ['2026-11-29', 'active'],
    ['2026-11-30', 'ending'],  // 残り14日
    ['2026-12-14', 'ending'],  // 最終日
    ['2026-12-15', 'ended'],
  ];
  cases.forEach(([today, phase]) => {
    assert.strictEqual(T.status(cfg(), today).phase, phase, today);
  });
});

test('残り日数は最終日で 0、翌日で -1 になる', () => {
  assert.strictEqual(T.status(cfg(), '2026-12-14').daysLeft, 0);
  assert.strictEqual(T.status(cfg(), '2026-12-15').daysLeft, -1);
  assert.strictEqual(T.status(cfg(), '2026-09-15').daysLeft, 90); // 3か月ぶんの日数
});

test('「まもなく終了」を出し始める日数を変えられる', () => {
  assert.strictEqual(T.status(cfg({ noticeDays: 30 }), '2026-11-20').phase, 'ending');
  assert.strictEqual(T.status(cfg({ noticeDays: 0 }), '2026-12-13').phase, 'active');
  assert.strictEqual(T.status(cfg({ noticeDays: 0 }), '2026-12-14').phase, 'ending');
});

test('案内文に店舗名・期間・連絡先が入る', () => {
  const st = T.status(cfg(), '2026-10-01');
  assert.strictEqual(st.storeName, 'テスト店');
  assert.strictEqual(st.contact, 'test@example.com');
  assert.ok(st.message.indexOf('2026/09/15 〜 2026/12/14') >= 0, st.message);
  assert.ok(st.message.indexOf('残り') >= 0);

  const ended = T.status(cfg(), '2027-01-01');
  assert.ok(ended.message.indexOf('終了しました') >= 0, ended.message);
});

test('既定の設定は空(誤って試用案内が出ない)', () => {
  assert.strictEqual(T.CONFIG.startDate, '');
  assert.strictEqual(T.CONFIG.months, 3);
  assert.strictEqual(T.status(T.CONFIG, '2026-10-01').enabled, false);
});
