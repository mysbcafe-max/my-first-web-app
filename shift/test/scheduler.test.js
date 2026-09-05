// 実行: node --test "shift/test/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scheduler.js');

const storeA = { id: 's1', name: '新宿店', address: '東京都新宿区西新宿1-1', requiredStaff: 2, minLevel: 1, leaderLevel: 0 };
const storeB = { id: 's2', name: '横浜店', address: '神奈川県横浜市西区みなとみらい1-1', requiredStaff: 1, minLevel: 2, leaderLevel: 0 };

const emp = (id, name, extra) => Object.assign({
  id, name, address: '東京都新宿区北新宿1-1', level: 3, maxDaysPerWeek: 5,
  availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngStoreIds: [], preferredStoreIds: [],
}, extra);

test('住所の分解: 都道府県・市区町村・区', () => {
  assert.deepEqual(S.parseAddress('東京都千代田区丸の内1-1'), { pref: '東京都', city: '千代田区', ward: '' });
  assert.deepEqual(S.parseAddress('神奈川県横浜市西区みなとみらい'), { pref: '神奈川県', city: '横浜市', ward: '西区' });
  assert.deepEqual(S.parseAddress('埼玉県北足立郡伊奈町小室'), { pref: '埼玉県', city: '北足立郡伊奈町', ward: '' });
  assert.deepEqual(S.parseAddress('千葉県市川市八幡'), { pref: '千葉県', city: '市川市', ward: '' });
  assert.deepEqual(S.parseAddress('岐阜県郡上市八幡町'), { pref: '岐阜県', city: '郡上市', ward: '' });
  assert.deepEqual(S.parseAddress('北海道札幌市中央区北1条'), { pref: '北海道', city: '札幌市', ward: '中央区' });
  assert.deepEqual(S.parseAddress('よくわからない住所'), { pref: '', city: '', ward: '' });
});

test('距離: 座標があれば実距離、なければ住所から推定', () => {
  const tokyo = { lat: 35.6812, lng: 139.7671 };
  const yokohama = { lat: 35.4658, lng: 139.6223 };
  const d = S.estimateDistance(tokyo, yokohama);
  assert.equal(d.method, 'coords');
  assert.ok(d.km > 25 && d.km < 30, `東京駅-横浜駅は約 27km のはず: ${d.km}`);

  assert.deepEqual(S.estimateDistance({ address: '東京都新宿区A' }, { address: '東京都新宿区B' }), { km: S.ESTIMATE_KM.sameCity, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '東京都新宿区A' }, { address: '東京都渋谷区B' }), { km: S.ESTIMATE_KM.tokyoWards, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '神奈川県横浜市西区' }, { address: '神奈川県横浜市西区' }), { km: S.ESTIMATE_KM.sameWard, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '神奈川県横浜市西区' }, { address: '神奈川県横浜市港北区' }), { km: S.ESTIMATE_KM.sameCityOtherWard, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '神奈川県横浜市西区' }, { address: '神奈川県川崎市川崎区' }), { km: S.ESTIMATE_KM.samePref, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '東京都新宿区' }, { address: '神奈川県横浜市' }), { km: S.ESTIMATE_KM.otherPref, method: 'estimate' });
  assert.deepEqual(S.estimateDistance({ address: '' }, { address: '東京都新宿区' }), { km: S.ESTIMATE_KM.unknown, method: 'unknown' });
});

test('日付ユーティリティ', () => {
  assert.deepEqual(S.eachDate('2026-09-07', '2026-09-09'), ['2026-09-07', '2026-09-08', '2026-09-09']);
  assert.deepEqual(S.eachDate('2026-09-09', '2026-09-07'), []);
  assert.equal(S.weekdayOf('2026-09-07'), 1); // 月曜
  assert.equal(S.weekKey('2026-09-13'), '2026-09-07'); // 日曜は前の月曜の週
  assert.equal(S.weekKey('2026-09-07'), '2026-09-07');
});

test('NG店舗には絶対にアサインされない', () => {
  const employees = [
    emp('e1', 'A', { ngStoreIds: ['s1'] }),
    emp('e2', 'B', { ngStoreIds: ['s1'] }),
    emp('e3', 'C'),
  ];
  const r = S.generate({ employees, stores: [storeA], startDate: '2026-09-07', endDate: '2026-09-11' });
  r.days.forEach((d) => {
    const ids = d.stores[0].assigned.map((a) => a.employeeId);
    assert.ok(!ids.includes('e1') && !ids.includes('e2'), `${d.date}: NG社員が入っている`);
    assert.deepEqual(ids, ['e3']);
    assert.equal(d.stores[0].shortage, 1);
  });
  assert.ok(r.warnings.some((w) => w.level === 'error' && /不足/.test(w.message)));
});

test('必要レベル未満の社員はアサインされない', () => {
  const employees = [emp('e1', '新人', { level: 1 }), emp('e2', '中堅', { level: 2 })];
  const r = S.generate({ employees, stores: [storeB], startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.deepEqual(r.days[0].stores[0].assigned.map((a) => a.employeeId), ['e2']);
});

test('リーダー要件: レベル以上の人を優先して 1 名入れる', () => {
  const store = Object.assign({}, storeA, { requiredStaff: 2, leaderLevel: 4 });
  const employees = [
    emp('e1', '新人1', { level: 1 }),
    emp('e2', '新人2', { level: 1 }),
    emp('e3', 'リーダー', { level: 4, address: '神奈川県横浜市西区' }), // 遠いがリーダー
  ];
  const r = S.generate({ employees, stores: [store], startDate: '2026-09-07', endDate: '2026-09-07' });
  const ids = r.days[0].stores[0].assigned.map((a) => a.employeeId);
  assert.ok(ids.includes('e3'));
  assert.equal(r.days[0].stores[0].leaderMissing, false);
});

test('週の上限日数・希望休・勤務可能曜日を守る', () => {
  const employees = [
    emp('e1', '週3', { maxDaysPerWeek: 3 }),
    emp('e2', '平日のみ', { availableWeekdays: [1, 2, 3, 4, 5] }),
    emp('e3', '休み希望あり', { unavailableDates: ['2026-09-08'] }),
    emp('e4', 'フル'),
  ];
  const store = Object.assign({}, storeA, { requiredStaff: 4 });
  const r = S.generate({ employees, stores: [store], startDate: '2026-09-07', endDate: '2026-09-13', options: { maxConsecutiveDays: 0 } });
  assert.equal(r.employeeStats.e1.days, 3);
  const e2Days = r.employeeStats.e2.dates.map((x) => S.weekdayOf(x.date));
  assert.ok(e2Days.every((wd) => wd >= 1 && wd <= 5));
  assert.ok(!r.employeeStats.e3.dates.some((x) => x.date === '2026-09-08'));
  assert.equal(r.employeeStats.e4.days, 5); // 既定の週上限 5
});

test('連勤上限を守る', () => {
  const employees = [emp('e1', 'A', { maxDaysPerWeek: 7 })];
  const r = S.generate({ employees, stores: [storeA], startDate: '2026-09-07', endDate: '2026-09-20', options: { maxConsecutiveDays: 3 } });
  let streak = 0, maxStreak = 0, prev = null;
  r.employeeStats.e1.dates.forEach((x) => {
    streak = prev && S.addDays(prev, 1) === x.date ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
    prev = x.date;
  });
  assert.equal(maxStreak, 3);
});

test('店舗の定休日にはアサインしない', () => {
  const store = Object.assign({}, storeA, { openWeekdays: [1, 2, 3, 4, 5] });
  const r = S.generate({ employees: [emp('e1', 'A')], stores: [store], startDate: '2026-09-12', endDate: '2026-09-13' }); // 土日
  r.days.forEach((d) => assert.equal(d.stores.length, 0));
});

test('距離が近い社員が優先される(座標)', () => {
  const store = { id: 's1', name: '東京店', lat: 35.6812, lng: 139.7671, requiredStaff: 1 };
  const employees = [
    emp('far', '遠い', { lat: 35.4658, lng: 139.6223 }),
    emp('near', '近い', { lat: 35.69, lng: 139.77 }),
  ];
  const r = S.generate({ employees, stores: [store], startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.equal(r.days[0].stores[0].assigned[0].employeeId, 'near');
  assert.equal(r.days[0].stores[0].assigned[0].method, 'coords');
});

test('希望店舗には加点される', () => {
  const stores = [
    { id: 's1', name: '店1', address: '東京都新宿区', requiredStaff: 1 },
    { id: 's2', name: '店2', address: '東京都新宿区', requiredStaff: 1 },
  ];
  const employees = [emp('e1', 'A', { preferredStoreIds: ['s2'] }), emp('e2', 'B', { preferredStoreIds: ['s1'] })];
  const r = S.generate({ employees, stores, startDate: '2026-09-07', endDate: '2026-09-07' });
  const byStore = Object.fromEntries(r.days[0].stores.map((s) => [s.storeId, s.assigned[0].employeeId]));
  assert.deepEqual(byStore, { s1: 'e2', s2: 'e1' });
});

test('公平性: 同条件なら日数が均等に近づく', () => {
  const employees = ['e1', 'e2', 'e3', 'e4'].map((id) => emp(id, id, { maxDaysPerWeek: 7 }));
  const store = Object.assign({}, storeA, { requiredStaff: 2 });
  const r = S.generate({ employees, stores: [store], startDate: '2026-09-07', endDate: '2026-09-20', options: { maxConsecutiveDays: 0 } });
  const counts = Object.values(r.employeeStats).map((x) => x.days);
  assert.equal(Math.max(...counts) - Math.min(...counts) <= 1, true, JSON.stringify(counts));
  assert.equal(counts.reduce((a, b) => a + b, 0), 28);
});

test('入れ替え改善で合計距離が下がる', () => {
  // 店1は候補が少ない(レベル3必須)ので先に埋まる。改善なしだと遠い人が入る可能性がある。
  const stores = [
    { id: 's1', name: '新宿店', address: '東京都新宿区', requiredStaff: 1, minLevel: 1 },
    { id: 's2', name: '横浜店', address: '神奈川県横浜市西区', requiredStaff: 1, minLevel: 1 },
  ];
  const employees = [
    emp('tokyo', '東京住まい', { address: '東京都新宿区' }),
    emp('yokohama', '横浜住まい', { address: '神奈川県横浜市西区' }),
  ];
  const r = S.generate({ employees, stores, startDate: '2026-09-07', endDate: '2026-09-07' });
  const byStore = Object.fromEntries(r.days[0].stores.map((s) => [s.storeId, s.assigned[0].employeeId]));
  assert.deepEqual(byStore, { s1: 'tokyo', s2: 'yokohama' });
});

test('CSV 出力', () => {
  const r = S.generate({ employees: [emp('e1', '山田, 太郎')], stores: [storeA], startDate: '2026-09-07', endDate: '2026-09-07' });
  const csv = S.toCSV(r);
  assert.ok(csv.startsWith('﻿日付,曜日,店舗,社員'));
  assert.ok(csv.includes('"山田, 太郎"'));
  assert.ok(csv.includes('(不足)'));
  const m = S.toMatrixCSV(r);
  assert.ok(m.includes('店舗,2026-09-07(月)'));
  assert.ok(m.includes('新宿店,"山田, 太郎 / (1名不足)"'));
});

test('入力が空でもクラッシュしない', () => {
  const r = S.generate({ employees: [], stores: [], startDate: '', endDate: '' });
  assert.deepEqual(r.days, []);
  assert.ok(r.warnings.length >= 3);
});

test('候補の少ない土日を先に埋めるので、週上限を平日で使い切らない', () => {
  // 土日に出られるのは e1 だけ。日付順に埋めると e1 が月〜金で 5 日使い切り、土日が不足する。
  const employees = [
    emp('e1', '土日OK', { maxDaysPerWeek: 5 }),
    emp('e2', '平日のみ1', { availableWeekdays: [1, 2, 3, 4, 5] }),
    emp('e3', '平日のみ2', { availableWeekdays: [1, 2, 3, 4, 5] }),
  ];
  const store = Object.assign({}, storeA, { requiredStaff: 1 });
  const r = S.generate({ employees, stores: [store], startDate: '2026-09-07', endDate: '2026-09-13' });
  assert.deepEqual(r.days.map((d) => d.date), S.eachDate('2026-09-07', '2026-09-13'), '出力は日付順');
  r.days.forEach((d) => assert.equal(d.stores[0].shortage, 0, `${d.date} が不足`));
  const e1Weekdays = r.employeeStats.e1.dates.map((x) => S.weekdayOf(x.date));
  assert.ok(e1Weekdays.includes(6) && e1Weekdays.includes(0));
});
