'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../scheduler.js');

// ---------------- テスト用の入力 ----------------

// 2026-09-01(火)〜2026-09-07(月)の 7 日間
// 役割は「フロア(r1)」「キッチン(r2)」の 2 つを既定にする
const ROLES = [{ id: 'r1', name: 'フロア' }, { id: 'r2', name: 'キッチン' }];

function makeStore(over) {
  return Object.assign({
    name: 'テスト店',
    periodStart: '2026-09-01',
    periodEnd: '2026-09-07',
    closedWeekdays: [],
    closedDates: [],
    roles: ROLES,
    slots: [
      { id: 'a', name: '早番', start: '09:00', end: '15:00', required: 2, requiredByRole: { r1: 1, r2: 1 }, leaderLevel: 0 },
    ],
  }, over || {});
}

function makeStaff(over) {
  return Object.assign({
    id: 'x', name: 'X', level: 3, roles: ['r1', 'r2'], targetDays: 7,
  }, over || {});
}

function run(store, staff, options) {
  return S.generate({ store: store, staff: staff, options: options });
}

function allAssignments(result) {
  const out = [];
  result.days.forEach((day) => {
    day.cells.forEach((cell) => {
      cell.assigned.forEach((a) => {
        out.push({ date: day.date, weekday: day.weekday, slotId: cell.slot.id, role: a.role, id: a.id, level: a.level, isLeader: a.isLeader });
      });
    });
  });
  return out;
}

// ---------------- 入力チェック ----------------

test('期間・枠・スタッフが足りないときはエラーを返す', () => {
  const r1 = run(makeStore({ periodStart: '', periodEnd: '' }), [makeStaff()]);
  assert.strictEqual(r1.ok, false);
  assert.ok(r1.errors.length > 0);

  const r2 = run(makeStore({ slots: [] }), [makeStaff()]);
  assert.strictEqual(r2.ok, false);

  const r3 = run(makeStore(), []);
  assert.strictEqual(r3.ok, false);

  const r4 = run(makeStore({ periodStart: '2026-09-07', periodEnd: '2026-09-01' }), [makeStaff()]);
  assert.strictEqual(r4.ok, false);
});

// ---------------- 出勤日数 ----------------

test('出勤日数(各スタッフの設定)を超えて割り当てない', () => {
  const staff = [
    makeStaff({ id: 'a', name: 'A', targetDays: 3 }),
    makeStaff({ id: 'b', name: 'B', targetDays: 2 }),
    makeStaff({ id: 'c', name: 'C', targetDays: 7 }),
  ];
  const r = run(makeStore(), staff);
  assert.strictEqual(r.ok, true);
  r.staffSummary.forEach((row) => {
    assert.ok(row.assignedDays <= row.targetDays, row.name + ' が出勤日数を超えている');
  });
  const byId = {};
  r.staffSummary.forEach((row) => { byId[row.id] = row; });
  assert.strictEqual(byId.a.assignedDays, 3);
  assert.strictEqual(byId.b.assignedDays, 2);
});

test('出勤日数 0 のスタッフはシフトに入らない', () => {
  const staff = [
    makeStaff({ id: 'a', name: 'A', targetDays: 0 }),
    makeStaff({ id: 'b', name: 'B', targetDays: 7 }),
  ];
  const r = run(makeStore(), staff);
  assert.ok(!allAssignments(r).some((x) => x.id === 'a'));
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /出勤日数が 0 日/.test(w.message)));
});

test('出勤日数が目標に届かないときは警告を出す', () => {
  // 1 日 2 人 × 7 日 = 14 枠に対して、目標の合計は 20 日
  const staff = [
    makeStaff({ id: 'a', name: 'A', targetDays: 7 }),
    makeStaff({ id: 'b', name: 'B', targetDays: 7 }),
    makeStaff({ id: 'c', name: 'C', targetDays: 6 }),
  ];
  const r = run(makeStore(), staff);
  const unmet = r.warnings.filter((w) => w.type === 'unmet');
  assert.ok(unmet.length > 0);
  const total = r.staffSummary.reduce((n, x) => n + x.assignedDays, 0);
  assert.strictEqual(total, 14);
});

// ---------------- フロア / キッチン ----------------

test('その役割ができないスタッフはその担当にならない', () => {
  const staff = [
    makeStaff({ id: 'k1', name: 'キッチン専任', roles: ['r2'] }),
    makeStaff({ id: 'k2', name: 'キッチン専任2', roles: ['r2'] }),
    makeStaff({ id: 'f1', name: 'フロア専任', roles: ['r1'] }),
  ];
  const r = run(makeStore(), staff);
  allAssignments(r).forEach((x) => {
    if (x.role === 'r1') assert.notStrictEqual(x.id.slice(0, 1), 'k');
    if (x.role === 'r2') assert.notStrictEqual(x.id.slice(0, 1), 'f');
  });
});

test('役割ごとの必須人数を満たす', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 4, requiredByRole: { r1: 2, r2: 1 }, leaderLevel: 0 }],
  });
  const staff = [];
  for (let i = 0; i < 4; i += 1) staff.push(makeStaff({ id: 'f' + i, name: 'F' + i, roles: ['r1'] }));
  for (let i = 0; i < 3; i += 1) staff.push(makeStaff({ id: 'k' + i, name: 'K' + i, roles: ['r2'] }));
  const r = run(store, staff);
  r.days.forEach((day) => {
    day.cells.forEach((cell) => {
      assert.strictEqual(cell.unfilled.length, 0, day.date + ' に不足が出ている');
      const floors = cell.assigned.filter((a) => a.role === 'r1').length;
      const kitchens = cell.assigned.filter((a) => a.role === 'r2').length;
      assert.ok(floors >= 2, day.date + ' のフロアが ' + floors + '人');
      assert.ok(kitchens >= 1, day.date + ' のキッチンが ' + kitchens + '人');
      assert.strictEqual(cell.assigned.length, 4);
    });
  });
});

test('できる役割が 1 つもないスタッフは使わず、設定の警告を出す', () => {
  const staff = [
    makeStaff({ id: 'n', name: 'なし', roles: [] }),
    makeStaff({ id: 'a', name: 'A' }),
    makeStaff({ id: 'b', name: 'B' }),
  ];
  const r = run(makeStore(), staff);
  assert.ok(!allAssignments(r).some((x) => x.id === 'n'));
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /できる役割/.test(w.message)));
});

test('役割ごとの必須人数は実人数なので、必要カウントより多く入ることがある', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 1, requiredByRole: { r1: 1, r2: 1 }, leaderLevel: 0 }],
  });
  const staff = [
    makeStaff({ id: 'f', name: 'F', roles: ['r1'] }),
    makeStaff({ id: 'k', name: 'K', roles: ['r2'] }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  assert.ok(r.warnings.some((w) => w.type === 'setup' && /実人数/.test(w.message)));
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.strictEqual(cell.required, 1, '必要カウントは設定どおり');
    assert.strictEqual(cell.assigned.length, 2, '役割の必須人数は満たす');
    assert.strictEqual(cell.assignedCount, 2);
    assert.strictEqual(cell.shortCount, 0);
  }));
});

// ---------------- レベル・リーダー要件 ----------------

test('リーダー要件があるとレベルを満たす人を 1 人入れる', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 2, requiredByRole: {}, leaderLevel: 4 }],
  });
  const staff = [
    makeStaff({ id: 'v1', name: 'ベテラン1', level: 5 }),
    makeStaff({ id: 'v2', name: 'ベテラン2', level: 4 }),
    makeStaff({ id: 'n1', name: '新人1', level: 1 }),
    makeStaff({ id: 'n2', name: '新人2', level: 2 }),
  ];
  const r = run(store, staff);
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.ok(cell.assigned.some((a) => a.level >= 4), day.date + ' にリーダーがいない');
    assert.ok(cell.assigned.some((a) => a.isLeader));
    assert.strictEqual(cell.noLeader, false);
  }));
});

test('リーダー要件を満たす人がいなければ警告を出す(枠は埋める)', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 2, requiredByRole: {}, leaderLevel: 5 }],
  });
  const staff = [
    makeStaff({ id: 'n1', name: '新人1', level: 1 }),
    makeStaff({ id: 'n2', name: '新人2', level: 2 }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  assert.ok(r.warnings.some((w) => w.type === 'leader'));
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.strictEqual(cell.assigned.length, 2);
  }));
});

// ---------------- 休み・曜日・時間帯・連勤 ----------------

test('定休日と臨時休業日には枠を作らない', () => {
  const store = makeStore({ closedWeekdays: [2], closedDates: ['2026-09-03'] });
  const staff = [makeStaff({ id: 'a', name: 'A' }), makeStaff({ id: 'b', name: 'B' })];
  const r = run(store, staff);
  const closed = r.days.filter((d) => d.closed).map((d) => d.date);
  assert.deepStrictEqual(closed, ['2026-09-01', '2026-09-03']); // 09-01 は火曜
  r.days.forEach((day) => {
    if (day.closed) assert.strictEqual(day.cells.length, 0);
  });
  assert.ok(!allAssignments(r).some((x) => x.date === '2026-09-03'));
});

test('希望休の日には入れない', () => {
  const staff = [
    makeStaff({ id: 'a', name: 'A', daysOff: ['2026-09-02', '2026-09-04'] }),
    makeStaff({ id: 'b', name: 'B' }),
    makeStaff({ id: 'c', name: 'C' }),
  ];
  const r = run(makeStore(), staff);
  allAssignments(r).forEach((x) => {
    if (x.id === 'a') assert.ok(x.date !== '2026-09-02' && x.date !== '2026-09-04');
  });
});

test('勤務できない曜日には入れない', () => {
  const staff = [
    makeStaff({ id: 'a', name: 'A', availableWeekdays: [0, 6] }),
    makeStaff({ id: 'b', name: 'B' }),
    makeStaff({ id: 'c', name: 'C' }),
  ];
  const r = run(makeStore(), staff);
  allAssignments(r).forEach((x) => {
    if (x.id === 'a') assert.ok(x.weekday === 0 || x.weekday === 6);
  });
});

test('対応できない時間帯には入れない・同じ日に 2 つの枠へは入れない', () => {
  const store = makeStore({
    slots: [
      { id: 'a', name: '早番', required: 1, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: '遅番', required: 1, requiredByRole: {}, leaderLevel: 0 },
    ],
  });
  const staff = [
    makeStaff({ id: 'early', name: '早番だけ', availableSlots: ['a'] }),
    makeStaff({ id: 'any', name: 'どちらも', availableSlots: ['a', 'b'] }),
  ];
  const r = run(store, staff);
  const list = allAssignments(r);
  list.forEach((x) => {
    if (x.id === 'early') assert.strictEqual(x.slotId, 'a');
  });
  r.days.forEach((day) => {
    const ids = [];
    day.cells.forEach((cell) => cell.assigned.forEach((a) => ids.push(a.id)));
    assert.strictEqual(new Set(ids).size, ids.length, day.date + ' に同じ人が 2 回入っている');
  });
});

test('連勤上限を超えない', () => {
  const store = makeStore({ periodStart: '2026-09-01', periodEnd: '2026-09-14' });
  const staff = [];
  for (let i = 0; i < 4; i += 1) staff.push(makeStaff({ id: 's' + i, name: 'S' + i, targetDays: 14 }));
  const r = run(store, staff, { maxConsecutiveDays: 3 });
  r.staffSummary.forEach((row) => {
    assert.ok(row.maxConsecutive <= 3, row.name + ' の連勤が ' + row.maxConsecutive + '日');
  });
});

test('スタッフ個別の連勤上限が全体設定より優先される', () => {
  const store = makeStore({ periodStart: '2026-09-01', periodEnd: '2026-09-14' });
  const staff = [
    makeStaff({ id: 'a', name: 'A', targetDays: 14, maxConsecutiveDays: 2 }),
    makeStaff({ id: 'b', name: 'B', targetDays: 14 }),
    makeStaff({ id: 'c', name: 'C', targetDays: 14 }),
    makeStaff({ id: 'd', name: 'D', targetDays: 14 }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 6 });
  const a = r.staffSummary.find((x) => x.id === 'a');
  assert.ok(a.maxConsecutive <= 2, 'A の連勤が ' + a.maxConsecutive + '日');
});

// ---------------- 曜日別の必要人数 ----------------

test('土日の必要人数を平日と別に設定できる', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 1, requiredWeekend: 3, requiredByRole: {}, leaderLevel: 0 }],
  });
  const staff = [];
  for (let i = 0; i < 4; i += 1) staff.push(makeStaff({ id: 's' + i, name: 'S' + i, targetDays: 7 }));
  const r = run(store, staff);
  r.days.forEach((day) => {
    const expected = (day.weekday === 0 || day.weekday === 6) ? 3 : 1;
    assert.strictEqual(day.cells[0].required, expected, day.date);
  });
});

test('枠を設ける曜日を絞れる', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '土日だけ', required: 1, requiredByRole: {}, leaderLevel: 0, weekdays: [0, 6] }],
  });
  const staff = [makeStaff({ id: 'a', name: 'A' })];
  const r = run(store, staff);
  r.days.forEach((day) => {
    if (day.weekday === 0 || day.weekday === 6) assert.strictEqual(day.cells.length, 1, day.date);
    else assert.strictEqual(day.cells.length, 0, day.date);
  });
});

// ---------------- 不足の警告 ----------------

test('人数が足りないときは不足として警告に出す(自動調整オフ)', () => {
  const store = makeStore({
    autoRelax: false,
    slots: [{ id: 'a', name: '早番', required: 3, requiredByRole: {}, leaderLevel: 0 }],
  });
  const staff = [makeStaff({ id: 'a', name: 'A' })];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  const shortage = r.warnings.filter((w) => w.type === 'shortage');
  assert.strictEqual(shortage.length, 7);
  assert.strictEqual(r.stats.requiredTotal, 21);
  assert.strictEqual(r.stats.assignedTotal, 7);
  assert.strictEqual(r.stats.shortage, 14);
});

// ---------------- 入れ替えによる改善 ----------------

test('同じ日の枠の入れ替えで埋められる不足は埋める', () => {
  // 早番はフロア 1、遅番はキッチン 1。
  // 「早番しか入れないフロア専任」と「どちらも入れるキッチン可」を用意すると、
  // 素直に埋めると早番にキッチン可の人が入って遅番が埋まらなくなる可能性がある。
  const store = makeStore({
    periodStart: '2026-09-01',
    periodEnd: '2026-09-01',
    slots: [
      { id: 'a', name: '早番', required: 1, requiredByRole: { r1: 1 }, leaderLevel: 0 },
      { id: 'b', name: '遅番', required: 1, requiredByRole: { r2: 1 }, leaderLevel: 0 },
    ],
  });
  const staff = [
    makeStaff({ id: 'both', name: '両方できる', roles: ['r1', 'r2'], availableSlots: ['a', 'b'] }),
    makeStaff({ id: 'floorOnly', name: 'フロア専任', roles: ['r1'], availableSlots: ['a'] }),
  ];
  const r = run(store, staff);
  const cells = r.days[0].cells;
  assert.strictEqual(cells[0].unfilled.length, 0, '早番が埋まっていない');
  assert.strictEqual(cells[1].unfilled.length, 0, '遅番が埋まっていない');
  assert.strictEqual(cells[0].assigned[0].id, 'floorOnly');
  assert.strictEqual(cells[1].assigned[0].id, 'both');
});

// ---------------- 出力・その他 ----------------

test('同じ入力からは同じ結果になる(再現性)', () => {
  const d = S.sampleData('aushop', '2026-09-05');
  const a = S.generate({ store: d.store, staff: d.staff });
  const b = S.generate({ store: d.store, staff: d.staff });
  assert.deepStrictEqual(allAssignments(a), allAssignments(b));
});

test('どの業態プリセットでもサンプルを生成できる', () => {
  Object.keys(S.PRESETS).forEach((key) => {
    const d = S.sampleData(key, '2026-09-05');
    const r = S.generate({ store: d.store, staff: d.staff });
    assert.strictEqual(r.ok, true, key + ' が生成できない');
    assert.ok(r.stats.assignedTotal > 0, key + ' の割り当てが 0');
    assert.ok(r.stats.fillRate >= 0.8, key + ' の充足率が低すぎる: ' + r.stats.fillRate);
    r.staffSummary.forEach((row) => assert.ok(row.assignedDays <= row.targetDays));
  });
});

test('CSV に日付別・スタッフ別の内容が出る', () => {
  const store = makeStore({
    closedWeekdays: [2],
    slots: [{ id: 'a', name: '早番', start: '09:00', end: '15:00', required: 2, requiredByRole: { r1: 1 }, leaderLevel: 0 }],
  });
  const staff = [makeStaff({ id: 'a', name: '山田 太郎', targetDays: 6 })];
  const r = run(store, staff);

  const csv1 = S.toCsvByDate(r);
  assert.ok(csv1.split('\n')[0].startsWith('日付,曜日,祝日,時間帯'));
  assert.ok(csv1.indexOf('山田 太郎') >= 0);
  assert.ok(csv1.indexOf('定休日') >= 0);
  assert.ok(csv1.indexOf('(不足)') >= 0);

  const csv2 = S.toCsvByStaff(r);
  assert.ok(csv2.split('\n')[0].indexOf('目標出勤日数') >= 0);
  assert.ok(csv2.split('\n')[0].indexOf('フロア') >= 0);
  assert.ok(csv2.indexOf('山田 太郎') >= 0);
});

test('カンマや引用符を含む名前を CSV でエスケープする', () => {
  const staff = [makeStaff({ id: 'a', name: 'A,B"C', targetDays: 7 })];
  const r = run(makeStore(), staff);
  const csv = S.toCsvByStaff(r);
  assert.ok(csv.indexOf('"A,B""C"') >= 0);
});

test('表示用マトリクスは全日 × 全枠の形になる', () => {
  const store = makeStore({
    closedWeekdays: [2],
    slots: [
      { id: 'a', name: '早番', required: 1, requiredByRole: {}, leaderLevel: 0 },
      { id: 'b', name: '遅番', required: 1, requiredByRole: {}, leaderLevel: 0, weekdays: [0, 6] },
    ],
  });
  const r = run(store, [makeStaff({ id: 'a', name: 'A' })]);
  const matrix = S.toMatrix(r);
  assert.strictEqual(matrix.length, 7);
  matrix.forEach((row) => {
    assert.strictEqual(row.cells.length, 2);
    if (row.closed) assert.deepStrictEqual(row.cells, [null, null]);
    else if (row.weekday !== 0 && row.weekday !== 6) assert.strictEqual(row.cells[1], null);
  });
});

// ---------------- 業態ごとのカスタマイズ ----------------

test('役割は店舗ごとに自由に定義できる(au ショップの例)', () => {
  const roles = [{ id: 'floor', name: 'フロア' }, { id: 'counter', name: 'カウンター' }, { id: 'office', name: '事務' }];
  const store = makeStore({
    roles: roles,
    slots: [{ id: 'a', name: '早番', required: 3, requiredByRole: { floor: 1, counter: 1, office: 1 }, leaderLevel: 0 }],
  });
  const staff = [
    makeStaff({ id: 'f', name: 'フロア担当', roles: ['floor'] }),
    makeStaff({ id: 'c', name: 'カウンター担当', roles: ['counter'] }),
    makeStaff({ id: 'o', name: '事務担当', roles: ['office'] }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  assert.deepStrictEqual(r.roles.map((x) => x.name), ['フロア', 'カウンター', '事務']);
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.strictEqual(cell.unfilled.length, 0, day.date + ' に不足');
    assert.deepStrictEqual(
      cell.assigned.map((a) => a.id).sort(),
      ['c', 'f', 'o']
    );
    // 担当名が結果に入る
    const byId = {};
    cell.assigned.forEach((a) => { byId[a.id] = a.roleLabel; });
    assert.strictEqual(byId.f, 'フロア');
    assert.strictEqual(byId.c, 'カウンター');
    assert.strictEqual(byId.o, '事務');
  }));
});

test('役割を 1 つも定義しなければ、誰でもどの枠にも入れる', () => {
  const store = makeStore({
    roles: [],
    slots: [{ id: 'a', name: '早番', required: 2, requiredByRole: {}, leaderLevel: 0 }],
  });
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 7 },
    { id: 'b', name: 'B', level: 2, targetDays: 7 },
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  assert.strictEqual(r.roles.length, 0);
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.strictEqual(cell.assigned.length, 2, day.date);
    cell.assigned.forEach((a) => assert.strictEqual(a.role, S.ANY_ROLE));
  }));
  assert.ok(!r.warnings.some((w) => w.type === 'setup'));
});

test('スタッフの roles を省略すると全役割ができる扱いになる', () => {
  const store = makeStore({
    slots: [{ id: 'a', name: '早番', required: 2, requiredByRole: { r1: 1, r2: 1 }, leaderLevel: 0 }],
  });
  const staff = [
    { id: 'a', name: 'A', level: 3, targetDays: 7 },
    { id: 'b', name: 'B', level: 3, targetDays: 7 },
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  r.days.forEach((day) => day.cells.forEach((cell) => {
    assert.strictEqual(cell.unfilled.length, 0, day.date);
  }));
});

test('存在しない役割 id はスタッフから取り除かれる', () => {
  const store = makeStore();
  const staff = [makeStaff({ id: 'a', name: 'A', roles: ['r1', 'unknown'] })];
  const r = run(store, staff);
  assert.deepStrictEqual(r.staffSummary[0].roles, ['r1']);
  assert.deepStrictEqual(r.staffSummary[0].roleNames, ['フロア']);
});

test('プリセットは役割・レベルの呼び方・時間帯を返す', () => {
  Object.keys(S.PRESETS).forEach((key) => {
    const parts = S.presetToStore(key);
    assert.strictEqual(parts.roles.length, S.PRESETS[key].roles.length, key);
    assert.strictEqual(parts.levelLabels.length, 5, key);
    assert.ok(parts.slots.length > 0, key);
    parts.slots.forEach((slot) => {
      // 役割ごとの必須人数のキーは、その店舗の役割 id とそろっている
      assert.deepStrictEqual(Object.keys(slot.requiredByRole).sort(), parts.roles.map((r) => r.id).sort(), key);
    });
  });
  assert.deepStrictEqual(S.presetToStore('aushop').roles.map((r) => r.name), ['フロア', 'カウンター', '事務']);
  assert.deepStrictEqual(S.presetToStore('simple').roles, []);
});

test('レベルの呼び方は店舗ごとに変えられる(5 つに満たなければ既定で埋める)', () => {
  const r = run(makeStore({ levelLabels: ['見習い', '', '一人前'] }), [makeStaff({ id: 'a', name: 'A' })]);
  assert.strictEqual(r.store.levelLabels[0], '見習い');
  assert.strictEqual(r.store.levelLabels[1], S.DEFAULT_LEVEL_LABELS[1]);
  assert.strictEqual(r.store.levelLabels[2], '一人前');
  assert.strictEqual(r.store.levelLabels.length, 5);
});

test('役割名は CSV の担当欄にそのまま出る', () => {
  const store = makeStore({
    roles: [{ id: 'floor', name: 'フロア' }, { id: 'counter', name: 'カウンター' }],
    slots: [{ id: 'a', name: '早番', required: 2, requiredByRole: { floor: 1, counter: 1 }, leaderLevel: 0 }],
  });
  const staff = [
    makeStaff({ id: 'f', name: 'F', roles: ['floor'] }),
    makeStaff({ id: 'c', name: 'C', roles: ['counter'] }),
  ];
  const r = run(store, staff, { maxConsecutiveDays: 0 });
  const csv = S.toCsvByDate(r);
  assert.ok(csv.indexOf(',カウンター,C,') >= 0, csv.split('\n')[1]);
  assert.ok(csv.indexOf(',フロア,F,') >= 0);
});
