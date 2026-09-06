// 実行: node --test "shift/test/*.test.js"
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scheduler.js');

const proj = (id, name, extra) => Object.assign({
  id, name, address: '東京都新宿区西新宿1-1', requiredStaff: 2, requiredAvgLevel: 0,
  minLevel: 1, leaderLevel: 0, openWeekdays: [0, 1, 2, 3, 4, 5, 6], startDate: '', endDate: '',
}, extra);

const emp = (id, name, extra) => Object.assign({
  id, name, address: '東京都新宿区北新宿1-1', level: 3, maxDaysPerWeek: 5,
  availableWeekdays: [0, 1, 2, 3, 4, 5, 6], unavailableDates: [], ngProjectIds: [], preferredProjectIds: [],
}, extra);

const filledOf = (r) => Object.values(r.projectStats).reduce((a, p) => a + p.filled, 0);
const requiredOf = (r) => Object.values(r.projectStats).reduce((a, p) => a + p.required, 0);

// ---------------- 住所・距離・日付 ----------------

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
  const d = S.estimateDistance({ lat: 35.6812, lng: 139.7671 }, { lat: 35.4658, lng: 139.6223 });
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

// ---------------- 案件の期間 ----------------

test('案件は指定した期間だけ稼働する', () => {
  const projects = [
    proj('p1', '4日間の案件', { startDate: '2026-09-08', endDate: '2026-09-11', requiredStaff: 1 }),
    proj('p2', '常設(期間なし)', { requiredStaff: 1 }),
  ];
  const employees = [emp('e1', 'A', { maxDaysPerWeek: 7 }), emp('e2', 'B', { maxDaysPerWeek: 7 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-13' });

  const p1Days = r.days.filter((d) => d.projects.some((x) => x.projectId === 'p1')).map((d) => d.date);
  assert.deepEqual(p1Days, ['2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']);
  assert.equal(r.projectStats.p1.activeDays, 4);

  const p2Days = r.days.filter((d) => d.projects.some((x) => x.projectId === 'p2')).map((d) => d.date);
  assert.equal(p2Days.length, 7, '期間なしの案件は生成期間すべてが稼働日');
});

test('案件の期間が生成期間の外なら稼働日ゼロで警告が出る', () => {
  const projects = [proj('p1', '来月の案件', { startDate: '2026-10-01', endDate: '2026-10-05' })];
  const r = S.generate({ employees: [emp('e1', 'A')], projects, startDate: '2026-09-07', endDate: '2026-09-13' });
  assert.equal(r.projectStats.p1.activeDays, 0);
  assert.equal(r.days.every((d) => d.projects.length === 0), true);
  assert.ok(r.warnings.some((w) => /稼働日がありません/.test(w.message)));
});

test('案件の稼働曜日と期間は両方が効く', () => {
  const projects = [proj('p1', '平日のみの案件', { startDate: '2026-09-07', endDate: '2026-09-13', openWeekdays: [1, 2, 3, 4, 5], requiredStaff: 1 })];
  const r = S.generate({ employees: [emp('e1', 'A', { maxDaysPerWeek: 7 })], projects, startDate: '2026-09-07', endDate: '2026-09-13' });
  const days = r.days.filter((d) => d.projects.length).map((d) => d.weekday);
  assert.deepEqual(days, [1, 2, 3, 4, 5]);
});

test('複数の案件を期間指定で並行して登録できる', () => {
  const projects = [
    proj('p1', '案件1', { startDate: '2026-09-07', endDate: '2026-09-10', requiredStaff: 2 }),
    proj('p2', '案件2', { startDate: '2026-09-09', endDate: '2026-09-13', requiredStaff: 2 }),
  ];
  const employees = ['e1', 'e2', 'e3', 'e4'].map((id) => emp(id, id, { maxDaysPerWeek: 7 }));
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-13' });
  assert.equal(filledOf(r), requiredOf(r), '全枠が埋まる');
  // 重なる 9-10 日は両案件が動く
  const overlap = r.days.find((d) => d.date === '2026-09-09');
  assert.equal(overlap.projects.length, 2);
  // 同じ人が同じ日に 2 案件へ入っていない
  r.days.forEach((d) => {
    const ids = d.projects.flatMap((p) => p.assigned.map((a) => a.employeeId));
    assert.equal(new Set(ids).size, ids.length, `${d.date}: 同じ人が 2 案件に入っている`);
  });
});

// ---------------- 平均必要レベル ----------------

test('平均必要レベル: 割り当てたスタッフの平均が必要値以上になる', () => {
  const projects = [proj('p1', '高難度案件', { startDate: '2026-09-07', endDate: '2026-09-10', requiredStaff: 2, requiredAvgLevel: 4 })];
  const employees = [
    emp('e1', 'Lv1', { level: 1 }), emp('e2', 'Lv2', { level: 2 }), emp('e3', 'Lv3', { level: 3 }),
    emp('e4', 'Lv4', { level: 4 }), emp('e5', 'Lv5', { level: 5 }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-10' });
  r.days.forEach((d) => d.projects.forEach((p) => {
    assert.equal(p.assigned.length, 2);
    assert.ok(p.avgLevel >= 4, `${d.date}: 平均 ${p.avgLevel} が必要値 4 を下回る`);
    assert.equal(p.avgShort, false);
  }));
  assert.equal(r.warnings.filter((w) => /平均レベル/.test(w.message)).length, 0);
});

test('平均必要レベルは小数でも指定できる(4.5 なら Lv4+Lv5 の組み合わせだけ)', () => {
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-08', requiredStaff: 2, requiredAvgLevel: 4.5 })];
  const employees = [emp('e1', 'A', { level: 3 }), emp('e2', 'B', { level: 4 }), emp('e3', 'C', { level: 5 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-08' });
  r.days.forEach((d) => d.projects.forEach((p) => {
    assert.ok(p.avgLevel >= 4.5, `平均 ${p.avgLevel}`);
    assert.deepEqual(p.assigned.map((a) => a.level).sort(), [4, 5]);
  }));
  // 3.5 は Lv3+Lv4 でも満たせる(境界がちょうど一致するケース)
  const r2 = S.generate({ employees, projects: [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-07', requiredStaff: 2, requiredAvgLevel: 3.5 })], startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.ok(r2.days[0].projects[0].avgLevel >= 3.5);
  assert.equal(r2.days[0].projects[0].avgShort, false);
});

test('平均必要レベルを満たせないときは埋めたうえで警告を出す', () => {
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-07', requiredStaff: 2, requiredAvgLevel: 5 })];
  const employees = [emp('e1', 'A', { level: 2 }), emp('e2', 'B', { level: 3 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  const slot = r.days[0].projects[0];
  assert.equal(slot.assigned.length, 2, '人は埋める');
  assert.equal(slot.avgShort, true);
  assert.ok(r.warnings.some((w) => w.level === 'error' && /平均レベルが 2\.5\(必要 5\)/.test(w.message)));
});

test('必要人数 1 名なら平均必要レベルはその人のレベルで判定される', () => {
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-08', requiredStaff: 1, requiredAvgLevel: 4 })];
  const employees = [emp('e1', 'Lv3', { level: 3 }), emp('e2', 'Lv4', { level: 4 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-08' });
  r.days.forEach((d) => assert.equal(d.projects[0].assigned[0].employeeId, 'e2'));
});

test('平均必要レベル 0 は不問(誰でも入れる)', () => {
  const projects = [proj('p1', '案件', { requiredStaff: 2, requiredAvgLevel: 0, startDate: '2026-09-07', endDate: '2026-09-07' })];
  const employees = [emp('e1', 'A', { level: 1 }), emp('e2', 'B', { level: 1 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.equal(r.days[0].projects[0].avgShort, false);
  assert.equal(r.warnings.filter((w) => w.level === 'error').length, 0);
});

// ---------------- 継続性(顔ぶれの固定) ----------------

test('継続性: 同じ案件には同じ顔ぶれが入り続ける', () => {
  const projects = [proj('p1', '5日間の案件', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 })];
  // 候補は多いが、選ばれた 2 名が期間中ずっと入るはず
  const employees = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id) => emp(id, id));
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  assert.equal(r.projectStats.p1.distinctStaff, 2, '2 名だけで回る');
  assert.equal(r.projectStats.p1.continuity, 1);
  const first = r.days[0].projects[0].assigned.map((a) => a.employeeId).sort().join(',');
  r.days.forEach((d) => {
    assert.equal(d.projects[0].assigned.map((a) => a.employeeId).sort().join(','), first, `${d.date}: 顔ぶれが変わった`);
  });
});

test('継続性: 期間を通して入れる人をコアに選ぶ(交代が減る)', () => {
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 })];
  // e2 は現場に近いが期間中に希望休がある。e3 は少し遠いが期間を通して入れる。
  const employees = [
    emp('e1', 'A', { address: '東京都新宿区北新宿1-1' }),
    emp('e2', '近いが休みあり', { address: '東京都新宿区北新宿1-1', unavailableDates: ['2026-09-09'] }),
    emp('e3', '遠いが通しで入れる', { address: '東京都渋谷区道玄坂1-1' }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  const coreIds = r.projectStats.p1.coreMembers.map((m) => m.employeeId).sort();
  assert.deepEqual(coreIds, ['e1', 'e3'], '通しで入れる人がコアになる');
  assert.equal(r.projectStats.p1.distinctStaff, 2);
  assert.equal(r.projectStats.p1.continuity, 1);
});

test('継続性: 通しで入れる人が足りなければ交代でつなぎ、翌日は元の担当に戻る', () => {
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 })];
  // 通しで入れるのは e1 だけ。e2 は 09-09 が希望休、e3 は水曜しか入れない。
  const employees = [
    emp('e1', 'コア1', { address: '東京都新宿区北新宿1-1' }),
    emp('e2', 'コア2', { address: '東京都新宿区北新宿1-1', unavailableDates: ['2026-09-09'] }),
    emp('e3', '水曜だけの交代要員', { address: '東京都新宿区北新宿1-1', availableWeekdays: [3] }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  assert.deepEqual(r.projectStats.p1.coreMembers.map((m) => m.employeeId).sort(), ['e1', 'e2']);
  const on = (date) => r.days.find((d) => d.date === date).projects[0].assigned.map((a) => a.employeeId).sort();
  assert.deepEqual(on('2026-09-08'), ['e1', 'e2']);
  assert.deepEqual(on('2026-09-09'), ['e1', 'e3'], '希望休の日だけ交代が入る');
  assert.deepEqual(on('2026-09-10'), ['e1', 'e2'], '翌日は元の顔ぶれに戻る');
  assert.equal(r.projectStats.p1.distinctStaff, 3);
  // 交代要員はフラグで見分けられる
  const sub = r.days.find((d) => d.date === '2026-09-09').projects[0].assigned.find((a) => a.employeeId === 'e3');
  assert.equal(sub.core, false);
});

test('継続性: 期間が重なる案件のコアメンバーは重複しない', () => {
  const projects = [
    proj('p1', '案件1', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 }),
    proj('p2', '案件2', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 }),
  ];
  const employees = ['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => emp(id, id));
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  const c1 = r.projectStats.p1.coreMembers.map((m) => m.employeeId);
  const c2 = r.projectStats.p2.coreMembers.map((m) => m.employeeId);
  assert.equal(c1.length, 2);
  assert.equal(c2.length, 2);
  assert.equal(c1.filter((id) => c2.includes(id)).length, 0, 'コアが重複している');
});

test('継続性: 期間が重ならない案件なら同じ人がコアになれる', () => {
  const projects = [
    proj('p1', '前半', { startDate: '2026-09-07', endDate: '2026-09-08', requiredStaff: 1 }),
    proj('p2', '後半', { startDate: '2026-09-10', endDate: '2026-09-11', requiredStaff: 1 }),
  ];
  const employees = [emp('e1', 'A', { address: '東京都新宿区北新宿1-1' }), emp('e2', 'B', { address: '神奈川県横浜市西区' })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  assert.equal(r.projectStats.p1.coreMembers[0].employeeId, 'e1');
  assert.equal(r.projectStats.p2.coreMembers[0].employeeId, 'e1', '近い人が両方のコアになれる');
});

// ---------------- ハード制約 ----------------

test('NG案件には絶対にアサインされない', () => {
  const projects = [proj('p1', '案件', { requiredStaff: 2, startDate: '2026-09-07', endDate: '2026-09-11' })];
  const employees = [
    emp('e1', 'A', { ngProjectIds: ['p1'] }),
    emp('e2', 'B', { ngProjectIds: ['p1'] }),
    emp('e3', 'C'),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  r.days.forEach((d) => {
    const ids = d.projects[0].assigned.map((a) => a.employeeId);
    assert.deepEqual(ids, ['e3']);
    assert.equal(d.projects[0].shortage, 1);
  });
  assert.ok(r.warnings.some((w) => w.level === 'error' && /不足/.test(w.message)));
});

test('旧フィールド名(ngStoreIds / stores)も読み込める', () => {
  const r = S.generate({
    employees: [{ id: 'e1', name: 'A', address: '東京都新宿区', level: 3, ngStoreIds: ['s1'] }],
    stores: [{ id: 's1', name: '旧店舗', address: '東京都新宿区', requiredStaff: 1 }],
    startDate: '2026-09-07', endDate: '2026-09-07',
  });
  assert.equal(r.days[0].projects[0].shortage, 1, 'NG が旧名でも効く');
});

test('必要レベル未満のスタッフはアサインされない', () => {
  const projects = [proj('p1', '案件', { minLevel: 2, requiredStaff: 1, startDate: '2026-09-07', endDate: '2026-09-07' })];
  const employees = [emp('e1', '新人', { level: 1 }), emp('e2', '中堅', { level: 2 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.deepEqual(r.days[0].projects[0].assigned.map((a) => a.employeeId), ['e2']);
});

test('リーダー要件: レベル以上の人を 1 名入れる', () => {
  const projects = [proj('p1', '案件', { requiredStaff: 2, leaderLevel: 4, startDate: '2026-09-07', endDate: '2026-09-07' })];
  const employees = [
    emp('e1', '新人1', { level: 1 }), emp('e2', '新人2', { level: 1 }),
    emp('e3', 'リーダー', { level: 4, address: '神奈川県横浜市西区' }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  const ids = r.days[0].projects[0].assigned.map((a) => a.employeeId);
  assert.ok(ids.includes('e3'));
  assert.equal(r.days[0].projects[0].leaderMissing, false);
});

test('週の上限日数・希望休・勤務可能曜日を守る', () => {
  const projects = [proj('p1', '案件', { requiredStaff: 4, startDate: '2026-09-07', endDate: '2026-09-13' })];
  const employees = [
    emp('e1', '週3', { maxDaysPerWeek: 3 }),
    emp('e2', '平日のみ', { availableWeekdays: [1, 2, 3, 4, 5] }),
    emp('e3', '休み希望あり', { unavailableDates: ['2026-09-08'] }),
    emp('e4', 'フル'),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-13', options: { maxConsecutiveDays: 0 } });
  assert.equal(r.employeeStats.e1.days, 3);
  assert.ok(r.employeeStats.e2.dates.every((x) => S.weekdayOf(x.date) >= 1 && S.weekdayOf(x.date) <= 5));
  assert.ok(!r.employeeStats.e3.dates.some((x) => x.date === '2026-09-08'));
  assert.equal(r.employeeStats.e4.days, 5); // 既定の週上限 5
});

test('連勤上限を守る', () => {
  const projects = [proj('p1', '案件', { requiredStaff: 1 })];
  const employees = [emp('e1', 'A', { maxDaysPerWeek: 7 })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-20', options: { maxConsecutiveDays: 3 } });
  let streak = 0, maxStreak = 0, prev = null;
  r.employeeStats.e1.dates.forEach((x) => {
    streak = prev && S.addDays(prev, 1) === x.date ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
    prev = x.date;
  });
  assert.equal(maxStreak, 3);
});

test('距離が近いスタッフが優先される(座標)', () => {
  const projects = [{ id: 'p1', name: '東京の現場', lat: 35.6812, lng: 139.7671, requiredStaff: 1 }];
  const employees = [
    emp('far', '遠い', { lat: 35.4658, lng: 139.6223 }),
    emp('near', '近い', { lat: 35.69, lng: 139.77 }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  assert.equal(r.days[0].projects[0].assigned[0].employeeId, 'near');
  assert.equal(r.days[0].projects[0].assigned[0].method, 'coords');
});

test('希望案件には加点される', () => {
  const projects = [
    proj('p1', '案件1', { requiredStaff: 1, startDate: '2026-09-07', endDate: '2026-09-07' }),
    proj('p2', '案件2', { requiredStaff: 1, startDate: '2026-09-07', endDate: '2026-09-07' }),
  ];
  const employees = [emp('e1', 'A', { preferredProjectIds: ['p2'] }), emp('e2', 'B', { preferredProjectIds: ['p1'] })];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  const byProject = Object.fromEntries(r.days[0].projects.map((p) => [p.projectId, p.assigned[0].employeeId]));
  assert.deepEqual(byProject, { p1: 'e2', p2: 'e1' });
});

test('公平性: 案件をまたいで仕事が偏らないようコアを振り分ける', () => {
  // 期間が重ならない 2 案件。同条件なら、2 件目は 1 件目に入っていない人が選ばれる。
  const projects = [
    proj('p1', '第1週の案件', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 1 }),
    proj('p2', '第2週の案件', { startDate: '2026-09-14', endDate: '2026-09-18', requiredStaff: 1 }),
  ];
  const employees = [emp('e1', 'A'), emp('e2', 'B')];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-20' });
  const c1 = r.projectStats.p1.coreMembers[0].employeeId;
  const c2 = r.projectStats.p2.coreMembers[0].employeeId;
  assert.notEqual(c1, c2, '同条件なら別の人に振り分ける');
  assert.equal(r.employeeStats.e1.days, 5);
  assert.equal(r.employeeStats.e2.days, 5);
});

test('継続性を優先するため、1 つの案件の中では日数を分け合わない', () => {
  // 顔ぶれを固定する要件のため、候補が余っていてもコアが入り続ける(公平性より継続性を優先)。
  const projects = [proj('p1', '案件', { startDate: '2026-09-07', endDate: '2026-09-11', requiredStaff: 2 })];
  const employees = ['e1', 'e2', 'e3', 'e4'].map((id) => emp(id, id));
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-11' });
  const counts = Object.values(r.employeeStats).map((x) => x.days).sort((a, b) => b - a);
  assert.deepEqual(counts, [5, 5, 0, 0], '2 名が通しで担当する');
  assert.equal(r.projectStats.p1.continuity, 1);
});

// ---------------- 修復パス ----------------

test('修復パス: 週上限で埋まらなかった枠を、別日の肩代わりで埋める', () => {
  // 週上限 2 日・稼働曜日が月〜水に限られ、NG案件も多い厳しい条件。
  // 1 日ずつ埋めると「週上限を使い切った人しか候補がいない」枠が残るため、
  // その人の別の日を他の人に肩代わりしてもらう連鎖で追加の枠が埋まる。
  const projects = [
    proj('p0', '案件0', { requiredStaff: 2, minLevel: 2, leaderLevel: 3, endDate: '2026-09-19' }),
    proj('p1', '案件1', { requiredStaff: 2, minLevel: 3, leaderLevel: 3, startDate: '2026-09-13', endDate: '2026-09-17' }),
  ];
  const levels = [3, 3, 5, 4, 1, 4, 3, 5, 1];
  const ng = [['p0', 'p1'], ['p1'], [], ['p0'], [], [], ['p0'], ['p1'], ['p1']];
  const employees = levels.map((level, i) => emp('e' + i, '社員' + i, {
    level, maxDaysPerWeek: 2, availableWeekdays: [1, 2, 3], ngProjectIds: ng[i],
  }));
  const args = { employees, projects, startDate: '2026-09-07', endDate: '2026-09-20' };
  const without = S.generate(Object.assign({}, args, { options: { repair: false } }));
  const with_ = S.generate(Object.assign({}, args, { options: { repair: true } }));
  assert.ok(filledOf(with_) > filledOf(without),
    `修復パスで充足が増えるはず: ${filledOf(without)} → ${filledOf(with_)}`);
  assert.equal(filledOf(with_), 18);
});

// ---------------- 不変条件 ----------------

function checkInvariants(r, employees, projects, label, maxConsec) {
  const byId = Object.fromEntries(employees.map((e) => [e.id, S.normalizeEmployee(e, S.DEFAULT_OPTIONS)]));
  const pById = Object.fromEntries(projects.map((p) => [p.id, S.normalizeProject(p)]));
  r.days.forEach((d) => {
    const seen = new Set();
    d.projects.forEach((slot) => {
      const p = pById[slot.projectId];
      assert.ok(slot.assigned.length <= p.requiredStaff, `${label} ${d.date} ${p.name}: 必要人数を超えている`);
      if (p.startDate) assert.ok(d.date >= p.startDate, `${label} ${d.date}: 案件の期間より前`);
      if (p.endDate) assert.ok(d.date <= p.endDate, `${label} ${d.date}: 案件の期間より後`);
      assert.ok(p.openWeekdays.includes(d.weekday), `${label} ${d.date}: 稼働曜日外`);
      slot.assigned.forEach((a) => {
        const e = byId[a.employeeId];
        assert.ok(!seen.has(e.id), `${label} ${d.date}: ${e.name} が同じ日に 2 案件`);
        seen.add(e.id);
        assert.ok(!e.ngProjectIds.includes(p.id), `${label}: ${e.name} が NG案件 ${p.name}`);
        assert.ok(e.level >= p.minLevel, `${label}: ${e.name} がレベル不足`);
        assert.ok(e.availableWeekdays.includes(d.weekday), `${label}: ${e.name} が勤務不可の曜日`);
        assert.ok(!e.unavailableDates.includes(d.date), `${label}: ${e.name} が希望休`);
        assert.ok(S.estimateDistance(e, p).km <= 60, `${label}: ${e.name} が距離上限超過`);
      });
    });
  });
  Object.entries(r.employeeStats).forEach(([id, st]) => {
    const e = byId[id];
    const byWeek = {};
    st.dates.forEach((x) => { byWeek[S.weekKey(x.date)] = (byWeek[S.weekKey(x.date)] || 0) + 1; });
    Object.entries(byWeek).forEach(([wk, n]) => assert.ok(n <= e.maxDaysPerWeek, `${label}: ${e.name} 週 ${wk} が上限超過 (${n})`));
    let streak = 0, prev = null;
    st.dates.forEach((x) => {
      streak = prev && S.addDays(prev, 1) === x.date ? streak + 1 : 1;
      prev = x.date;
      assert.ok(streak <= maxConsec, `${label}: ${e.name} 連勤上限超過`);
    });
    const km = st.dates.reduce((a, x) => a + S.estimateDistance(e, pById[x.projectId]).km, 0);
    assert.ok(Math.abs(km - st.km) < 0.15, `${label}: ${e.name} 距離の集計が明細と合わない ${st.km} vs ${km}`);
    assert.equal(st.days, st.dates.length, `${label}: ${e.name} 日数と明細が合わない`);
  });
}

test('ハード制約は破らない(2 週間・複数案件)', () => {
  const projects = [
    proj('p1', '新宿案件', { address: '東京都新宿区', requiredStaff: 2, minLevel: 2, leaderLevel: 4, requiredAvgLevel: 3, startDate: '2026-09-07', endDate: '2026-09-14' }),
    proj('p2', '横浜案件', { address: '神奈川県横浜市西区', requiredStaff: 2, startDate: '2026-09-10', endDate: '2026-09-20' }),
    proj('p3', '大宮案件', { address: '埼玉県さいたま市大宮区', requiredStaff: 1, minLevel: 3, openWeekdays: [1, 2, 3, 4, 5] }),
  ];
  const employees = [
    emp('e1', 'A', { level: 5, availableWeekdays: [1, 2, 3, 4, 5, 6] }),
    emp('e2', 'B', { level: 4, ngProjectIds: ['p3'] }),
    emp('e3', 'C', { level: 3, address: '神奈川県横浜市西区', unavailableDates: ['2026-09-09'] }),
    emp('e4', 'D', { level: 2, availableWeekdays: [1, 2, 3, 4, 5] }),
    emp('e5', 'E', { level: 1, address: '神奈川県横浜市西区', ngProjectIds: ['p1'] }),
    emp('e6', 'F', { level: 3, maxDaysPerWeek: 4 }),
    emp('e7', 'G', { level: 2, availableWeekdays: [0, 6] }),
  ];
  const r = S.generate({ employees, projects, startDate: '2026-09-07', endDate: '2026-09-20', options: { maxConsecutiveDays: 4 } });
  checkInvariants(r, employees, projects, '複数案件', 4);
});

test('ランダムな条件でも不変条件を満たし、修復パスは充足を減らさない', () => {
  let seed = 20260906;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 60; t++) {
    const projects = [];
    for (let i = 0; i < 2 + rnd(3); i++) {
      const s = 7 + rnd(8);
      const len = 3 + rnd(6);
      projects.push({
        id: 'p' + i, name: '案件' + i, address: '東京都新宿区',
        startDate: rnd(3) ? `2026-09-${String(s).padStart(2, '0')}` : '',
        endDate: rnd(3) ? `2026-09-${String(Math.min(30, s + len)).padStart(2, '0')}` : '',
        requiredStaff: 1 + rnd(3), minLevel: 1 + rnd(3), requiredAvgLevel: rnd(2) ? 0 : 1 + rnd(4),
        leaderLevel: rnd(2) ? 0 : 3 + rnd(2),
        openWeekdays: [0, 1, 2, 3, 4, 5, 6].filter(() => rnd(4) > 0),
      });
    }
    const employees = [];
    for (let i = 0; i < 3 + rnd(8); i++) {
      const wd = [0, 1, 2, 3, 4, 5, 6].filter(() => rnd(4) > 0);
      employees.push({
        id: 'e' + i, name: '社員' + i, address: '東京都新宿区', level: 1 + rnd(5),
        maxDaysPerWeek: 2 + rnd(4), availableWeekdays: wd.length ? wd : [1, 2, 3],
        unavailableDates: [], ngProjectIds: projects.filter(() => rnd(5) === 0).map((p) => p.id), preferredProjectIds: [],
      });
    }
    const args = { employees, projects, startDate: '2026-09-07', endDate: '2026-09-20' };
    const r = S.generate(args);
    const plain = S.generate(Object.assign({}, args, { options: { repair: false } }));
    assert.ok(filledOf(r) >= filledOf(plain), `t=${t}: 修復パスで充足が減った`);
    checkInvariants(r, employees, projects, `t=${t}`, S.DEFAULT_OPTIONS.maxConsecutiveDays);
  }
});

// ---------------- 出力 ----------------

test('CSV 出力', () => {
  const projects = [proj('p1', '案件A', { requiredStaff: 2, startDate: '2026-09-07', endDate: '2026-09-07' })];
  const r = S.generate({ employees: [emp('e1', '山田, 太郎')], projects, startDate: '2026-09-07', endDate: '2026-09-07' });
  const csv = S.toCSV(r);
  assert.ok(csv.startsWith('﻿日付,曜日,案件,スタッフ'));
  assert.ok(csv.includes('"山田, 太郎"'));
  assert.ok(csv.includes('(不足)'));
  const m = S.toMatrixCSV(r);
  assert.ok(m.includes('案件,2026-09-07(月)'));
  assert.ok(m.includes('案件A,"山田, 太郎 / (1名不足)"'));
});

test('案件の期間から生成期間を提案できる', () => {
  const projects = [
    { id: 'p1', startDate: '2026-09-10', endDate: '2026-09-14' },
    { id: 'p2', startDate: '2026-09-07', endDate: '2026-09-09' },
    { id: 'p3', startDate: '', endDate: '' },
  ];
  assert.deepEqual(S.suggestPeriod(projects), { startDate: '2026-09-07', endDate: '2026-09-14' });
  assert.equal(S.suggestPeriod([]), null);
});

test('入力が空でもクラッシュしない', () => {
  const r = S.generate({ employees: [], projects: [], startDate: '', endDate: '' });
  assert.deepEqual(r.days, []);
  assert.ok(r.warnings.length >= 3);
});
