/*
 * 一店舗用シフト生成ロジック(UI から独立した純粋な関数群)
 *
 * ブラウザでは window.SingleShiftScheduler として、Node では module.exports として使える。
 * 外部ライブラリ・外部 API には依存しない(費用ゼロ)。
 *
 * 入力
 *   store : 店舗設定(期間・定休日・時間帯(枠)ごとの必要人数)
 *   staff : スタッフ一覧(フロア可否・キッチン可否・レベル・出勤日数 など)
 * 出力
 *   日付 × 時間帯のアサイン表と、スタッフ別の集計・警告
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SingleShiftScheduler = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  // 枠の中の「担当」。フロア必須・キッチン必須の人数を満たしたあとの残りは any(どちらでも可)。
  const ROLE_LABELS = { floor: 'フロア', kitchen: 'キッチン', any: '—' };

  const LEVEL_LABELS = {
    1: '1(研修中)',
    2: '2(一人立ち)',
    3: '3(中堅)',
    4: '4(リーダー)',
    5: '5(店長代行)',
  };

  const DEFAULT_OPTIONS = {
    weightNeed: 100,        // 出勤日数の残りが多い人ほど優先する係数
    weightContinuity: 6,    // いつもと同じ時間帯に入ることへの加点
    weightLevel: 3,         // リーダー要件・ベテランの偏りに関する加減点
    weightConsecutive: 4,   // 連勤が続いている人への減点(1 日あたり)
    maxConsecutiveDays: 5,  // 連勤上限(0 で無制限)
    improve: true,          // 同じ日の枠どうしの入れ替えで人数不足を減らす
  };

  // ---------------- 日付ユーティリティ ----------------

  function parseDate(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(str, n) {
    const d = parseDate(str);
    d.setUTCDate(d.getUTCDate() + n);
    return formatDate(d);
  }

  function weekdayOf(str) {
    return parseDate(str).getUTCDay();
  }

  function isValidDate(str) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(str)) && !Number.isNaN(parseDate(str).getTime());
  }

  // start〜end の日付文字列の配列(最大 400 日で打ち切り)
  function eachDate(start, end) {
    const out = [];
    if (!isValidDate(start) || !isValidDate(end)) return out;
    let cur = start;
    while (cur <= end && out.length < 400) {
      out.push(cur);
      cur = addDays(cur, 1);
    }
    return out;
  }

  // ---------------- 小物 ----------------

  function toInt(v, def) {
    if (v === '' || v === null || v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n) : def;
  }

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function uniqSorted(arr) {
    return Array.from(new Set(arr)).sort();
  }

  function normalizeWeekdays(v, fallback) {
    if (!Array.isArray(v)) return fallback.slice();
    const out = v.map((x) => toInt(x, -1)).filter((x) => x >= 0 && x <= 6);
    return Array.from(new Set(out)).sort((a, b) => a - b);
  }

  function normalizeDates(v) {
    if (!Array.isArray(v)) return [];
    return uniqSorted(v.map((x) => String(x).trim()).filter(isValidDate));
  }

  // ---------------- 入力の正規化 ----------------

  function normalizeSlot(raw, i) {
    const src = raw || {};
    const required = Math.max(0, toInt(src.required, 0));
    const rw = src.requiredWeekend;
    return {
      id: String(src.id || 'slot' + (i + 1)),
      name: String(src.name || '枠' + (i + 1)),
      start: String(src.start || ''),
      end: String(src.end || ''),
      required: required,
      // 土日の必要人数(未入力なら平日と同じ)
      requiredWeekend: rw === '' || rw === null || rw === undefined ? null : Math.max(0, toInt(rw, required)),
      requiredFloor: Math.max(0, toInt(src.requiredFloor, 0)),
      requiredKitchen: Math.max(0, toInt(src.requiredKitchen, 0)),
      leaderLevel: clamp(toInt(src.leaderLevel, 0), 0, 5),
      weekdays: normalizeWeekdays(src.weekdays, [0, 1, 2, 3, 4, 5, 6]),
    };
  }

  function normalizeStore(raw) {
    const src = raw || {};
    const slots = (Array.isArray(src.slots) ? src.slots : []).map(normalizeSlot);
    return {
      name: String(src.name || '店舗'),
      periodStart: String(src.periodStart || ''),
      periodEnd: String(src.periodEnd || ''),
      closedWeekdays: normalizeWeekdays(src.closedWeekdays, []),
      closedDates: normalizeDates(src.closedDates),
      slots: slots,
    };
  }

  function normalizeStaff(raw, slotIds) {
    return (Array.isArray(raw) ? raw : []).map((src, i) => {
      const s = src || {};
      const availableSlots = Array.isArray(s.availableSlots)
        ? s.availableSlots.map(String).filter((id) => slotIds.indexOf(id) >= 0)
        : slotIds.slice();
      return {
        id: String(s.id || 'staff' + (i + 1)),
        name: String(s.name || '(名前なし)'),
        level: clamp(toInt(s.level, 1), 1, 5),
        floor: s.floor === undefined ? true : !!s.floor,      // フロアができるか
        kitchen: s.kitchen === undefined ? false : !!s.kitchen, // キッチンができるか
        targetDays: Math.max(0, toInt(s.targetDays, 0)),        // 期間内の出勤日数(目標かつ上限)
        availableWeekdays: normalizeWeekdays(s.availableWeekdays, [0, 1, 2, 3, 4, 5, 6]),
        availableSlots: availableSlots,
        daysOff: normalizeDates(s.daysOff),
        maxConsecutiveDays: Math.max(0, toInt(s.maxConsecutiveDays, 0)), // 0 なら全体設定を使う
        note: String(s.note || ''),
      };
    });
  }

  // ---------------- 判定ヘルパー ----------------

  function isWeekend(date) {
    const wd = weekdayOf(date);
    return wd === 0 || wd === 6;
  }

  function requiredOf(slot, date) {
    const base = isWeekend(date) && slot.requiredWeekend !== null ? slot.requiredWeekend : slot.required;
    return Math.max(base, slot.requiredFloor + slot.requiredKitchen);
  }

  function canServe(staff, role) {
    if (role === 'floor') return staff.floor;
    if (role === 'kitchen') return staff.kitchen;
    return staff.floor || staff.kitchen;
  }

  function csvEscape(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ---------------- 本体 ----------------

  function generate(input) {
    const opts = Object.assign({}, DEFAULT_OPTIONS, (input && input.options) || {});
    const store = normalizeStore(input && input.store);
    const slots = store.slots;
    const staff = normalizeStaff(input && input.staff, slots.map((s) => s.id));

    const errors = [];
    const setupWarnings = [];

    if (!isValidDate(store.periodStart) || !isValidDate(store.periodEnd)) {
      errors.push('期間(開始日・終了日)を入力してください。');
    } else if (store.periodEnd < store.periodStart) {
      errors.push('終了日は開始日より後にしてください。');
    }
    if (!slots.length) errors.push('時間帯(シフト枠)を 1 つ以上登録してください。');
    if (!staff.length) errors.push('スタッフを 1 人以上登録してください。');
    if (errors.length) {
      return { ok: false, errors: errors, store: store, days: [], staffSummary: [], warnings: [], stats: null };
    }

    // 設定の穴を先に知らせる
    slots.forEach((slot) => {
      if (slot.required < slot.requiredFloor + slot.requiredKitchen) {
        setupWarnings.push({
          type: 'setup',
          message: '「' + slot.name + '」は必要人数(' + slot.required + '人)がフロア必須+キッチン必須('
            + (slot.requiredFloor + slot.requiredKitchen) + '人)より少ないため、'
            + (slot.requiredFloor + slot.requiredKitchen) + '人として扱います。',
        });
      }
    });
    staff.forEach((s) => {
      if (!s.floor && !s.kitchen) {
        setupWarnings.push({ type: 'setup', message: s.name + ' はフロアもキッチンも「不可」のため、シフトに入れられません。' });
      }
      if (!s.availableSlots.length) {
        setupWarnings.push({ type: 'setup', message: s.name + ' は対応できる時間帯が 1 つも選ばれていません。' });
      }
      if (s.targetDays === 0) {
        setupWarnings.push({ type: 'setup', message: s.name + ' は出勤日数が 0 日のため、シフトに入りません。' });
      }
    });

    const staffById = {};
    staff.forEach((s) => { staffById[s.id] = s; });

    const allDates = eachDate(store.periodStart, store.periodEnd);

    // 日ごとの枠(cells)を作る
    const days = allDates.map((date) => {
      const wd = weekdayOf(date);
      const closed = store.closedWeekdays.indexOf(wd) >= 0 || store.closedDates.indexOf(date) >= 0;
      const cells = closed ? [] : slots
        .filter((slot) => slot.weekdays.indexOf(wd) >= 0)
        .map((slot) => ({
          slot: slot,
          required: requiredOf(slot, date),
          assigned: [],
          unfilled: [],
          noLeader: false,
        }))
        .filter((cell) => cell.required > 0);
      return { date: date, weekday: wd, weekdayLabel: WEEKDAY_LABELS[wd], closed: closed, cells: cells };
    });

    const openDays = days.filter((d) => !d.closed && d.cells.length);

    // スタッフごとの状態
    const state = {};
    staff.forEach((s) => {
      state[s.id] = {
        assigned: 0,
        dates: new Set(),
        slotCount: {},
        passed: 0,        // 「入れたのに入らなかった日」= 残り機会の目減り
        availableTotal: 0,
      };
    });

    // その日にそのスタッフが働ける枠があるか(人数上限などは見ない、素の可否)
    function couldWorkDay(s, day) {
      if (!s.floor && !s.kitchen) return false;
      if (s.availableWeekdays.indexOf(day.weekday) < 0) return false;
      if (s.daysOff.indexOf(day.date) >= 0) return false;
      return day.cells.some((cell) => s.availableSlots.indexOf(cell.slot.id) >= 0);
    }

    openDays.forEach((day) => {
      staff.forEach((s) => { if (couldWorkDay(s, day)) state[s.id].availableTotal += 1; });
    });

    // 連勤(date を足したときの連続日数)
    function runBefore(s, date) {
      const st = state[s.id];
      let n = 0;
      let cur = addDays(date, -1);
      while (st.dates.has(cur) && n < 40) { n += 1; cur = addDays(cur, -1); }
      return n;
    }

    function runAfter(s, date) {
      const st = state[s.id];
      let n = 0;
      let cur = addDays(date, 1);
      while (st.dates.has(cur) && n < 40) { n += 1; cur = addDays(cur, 1); }
      return n;
    }

    function maxConsecutiveOf(s) {
      return s.maxConsecutiveDays > 0 ? s.maxConsecutiveDays : opts.maxConsecutiveDays;
    }

    // 入れない理由(入れるなら null)
    function blockedReason(s, cell, date) {
      if (!s.floor && !s.kitchen) return 'role';
      if (s.availableWeekdays.indexOf(weekdayOf(date)) < 0) return 'weekday';
      if (s.daysOff.indexOf(date) >= 0) return 'dayoff';
      if (s.availableSlots.indexOf(cell.slot.id) < 0) return 'slot';
      const st = state[s.id];
      if (st.dates.has(date)) return 'sameday';
      if (st.assigned >= s.targetDays) return 'target';
      const maxc = maxConsecutiveOf(s);
      if (maxc > 0 && runBefore(s, date) + 1 + runAfter(s, date) > maxc) return 'consecutive';
      return null;
    }

    const REASON_LABELS = {
      role: 'フロアもキッチンも不可',
      weekday: '勤務できない曜日',
      dayoff: '希望休',
      slot: 'この時間帯に対応できない',
      sameday: '同じ日の別の枠に勤務',
      target: '出勤日数の上限に到達',
      consecutive: '連勤上限',
      capability: '担当(フロア/キッチン)が合わない',
    };

    function candidatesFor(cell, date, role, tally) {
      const out = [];
      staff.forEach((s) => {
        // すでにこの枠に入っている人は候補にも「入れなかった理由」にも数えない
        if (cell.assigned.some((a) => a.id === s.id)) return;
        const reason = blockedReason(s, cell, date);
        if (reason) {
          if (tally) tally[reason] = (tally[reason] || 0) + 1;
          return;
        }
        if (role && !canServe(s, role)) {
          if (tally) tally.capability = (tally.capability || 0) + 1;
          return;
        }
        out.push(s);
      });
      return out;
    }

    function scoreOf(s, cell, date) {
      const st = state[s.id];
      const need = s.targetDays - st.assigned;
      const opportunities = Math.max(1, st.availableTotal - st.assigned - st.passed);
      let sc = opts.weightNeed * Math.min(2, need / opportunities);

      // いつもと同じ時間帯に入りやすくする
      if (st.assigned > 0) {
        sc += opts.weightContinuity * ((st.slotCount[cell.slot.id] || 0) / st.assigned);
      }

      // リーダー要件: まだいなければレベルの高い人を優先、いれば偏らないよう少し避ける
      const lead = cell.slot.leaderLevel;
      if (lead > 0) {
        const hasLeader = cell.assigned.some((a) => a.level >= lead);
        if (!hasLeader) {
          if (s.level >= lead) sc += opts.weightLevel;
        } else {
          sc -= opts.weightLevel * Math.max(0, s.level - lead) * 0.5;
        }
      }

      sc -= opts.weightConsecutive * runBefore(s, date);
      return sc;
    }

    function pickBest(cands, cell, date) {
      let best = null;
      let bestScore = -Infinity;
      cands.forEach((s) => {
        const sc = scoreOf(s, cell, date);
        if (sc > bestScore || (sc === bestScore && best && s.id < best.id)) {
          best = s;
          bestScore = sc;
        }
      });
      return best;
    }

    function assign(s, cell, date, role, isLeader) {
      const st = state[s.id];
      cell.assigned.push({ id: s.id, name: s.name, level: s.level, role: role, isLeader: !!isLeader });
      st.assigned += 1;
      st.dates.add(date);
      st.slotCount[cell.slot.id] = (st.slotCount[cell.slot.id] || 0) + 1;
    }

    function unassign(s, cell) {
      const st = state[s.id];
      const idx = cell.assigned.findIndex((a) => a.id === s.id);
      if (idx < 0) return null;
      const removed = cell.assigned.splice(idx, 1)[0];
      st.slotCount[cell.slot.id] -= 1;
      return removed;
    }

    // 枠を埋める
    function fillCell(cell, date) {
      const slot = cell.slot;
      const demands = [];
      for (let i = 0; i < slot.requiredFloor; i += 1) demands.push('floor');
      for (let i = 0; i < slot.requiredKitchen; i += 1) demands.push('kitchen');
      while (demands.length < cell.required) demands.push('any');

      // 候補が少ない担当から埋める(あとから埋まらなくなるのを防ぐ)
      const scarcity = {};
      ['floor', 'kitchen', 'any'].forEach((role) => {
        scarcity[role] = candidatesFor(cell, date, role, null).length;
      });
      demands.sort((a, b) => (scarcity[a] - scarcity[b]) || (a < b ? -1 : a > b ? 1 : 0));

      // リーダー要件: 担当できる中で「いちばん候補が少ない担当」に入れる
      if (slot.leaderLevel > 0) {
        let placed = false;
        for (let i = 0; i < demands.length && !placed; i += 1) {
          const role = demands[i];
          const cands = candidatesFor(cell, date, role, null).filter((s) => s.level >= slot.leaderLevel);
          if (!cands.length) continue;
          const best = pickBest(cands, cell, date);
          assign(best, cell, date, role, true);
          demands.splice(i, 1);
          placed = true;
        }
        if (!placed) cell.noLeader = true;
      }

      demands.forEach((role) => {
        const tally = {};
        const cands = candidatesFor(cell, date, role, tally);
        if (!cands.length) {
          cell.unfilled.push({ role: role, reasons: tally });
          return;
        }
        const best = pickBest(cands, cell, date);
        assign(best, cell, date, role, false);
      });
    }

    // 同じ日の枠どうしで入れ替えて、人数不足を減らす
    // (足りない枠 A に入れる人 x を別の枠 B から移し、B の穴は当日空いている y で埋める)
    function tryFillBySwap(day, target, role) {
      for (let bi = 0; bi < day.cells.length; bi += 1) {
        const other = day.cells[bi];
        if (other === target) continue;
        for (let ai = 0; ai < other.assigned.length; ai += 1) {
          const a = other.assigned[ai];
          const x = staffById[a.id];
          if (!canServe(x, role)) continue;
          if (x.availableSlots.indexOf(target.slot.id) < 0) continue;
          // A 側のリーダー要件は「不足を埋める」ので壊れない。B 側が壊れないかを見る
          const leadB = other.slot.leaderLevel;
          const otherKeepsLeader = leadB <= 0
            || other.assigned.some((o) => o.id !== a.id && o.level >= leadB);
          const tally = {};
          const cands = candidatesFor(other, day.date, a.role, tally)
            .filter((y) => otherKeepsLeader || y.level >= leadB);
          if (!cands.length) continue;
          const y = pickBest(cands, other, day.date);
          const removed = unassign(x, other);
          if (!removed) continue;
          assign(x, target, day.date, role, false);
          assign(y, other, day.date, removed.role, leadB > 0 && !otherKeepsLeader);
          return true;
        }
      }
      return false;
    }

    function improveDay(day) {
      if (!opts.improve) return;
      for (let iter = 0; iter < 4; iter += 1) {
        let changed = false;
        day.cells.forEach((cell) => {
          for (let i = cell.unfilled.length - 1; i >= 0; i -= 1) {
            if (tryFillBySwap(day, cell, cell.unfilled[i].role)) {
              cell.unfilled.splice(i, 1);
              changed = true;
            }
          }
        });
        if (!changed) break;
      }
    }

    // 埋めにくい日から順に処理する(候補に対して必要人数が多い日 = 土日など)
    const order = openDays.slice().sort((a, b) => {
      const da = dayDifficulty(a);
      const db = dayDifficulty(b);
      if (da !== db) return db - da;
      return a.date < b.date ? -1 : 1;
    });

    function dayDifficulty(day) {
      const required = day.cells.reduce((n, c) => n + c.required, 0);
      const cands = staff.filter((s) => couldWorkDay(s, day) && s.targetDays > 0).length;
      return cands === 0 ? Infinity : required / cands;
    }

    order.forEach((day) => {
      // 候補が少ない枠から埋める
      const cells = day.cells.slice().sort((a, b) => {
        const ca = candidatesFor(a, day.date, null, null).length / Math.max(1, a.required);
        const cb = candidatesFor(b, day.date, null, null).length / Math.max(1, b.required);
        if (ca !== cb) return ca - cb;
        return a.slot.id < b.slot.id ? -1 : 1;
      });
      cells.forEach((cell) => fillCell(cell, day.date));
      improveDay(day);
      // この日に入れたのに入らなかった人は、残りの機会が 1 つ減ったとみなす
      staff.forEach((s) => {
        if (!state[s.id].dates.has(day.date) && couldWorkDay(s, day)) state[s.id].passed += 1;
      });
    });

    // ---------------- 集計 ----------------

    const warnings = setupWarnings.slice();

    days.forEach((day) => {
      day.cells.forEach((cell) => {
        if (cell.unfilled.length) {
          const byRole = {};
          const reasons = {};
          cell.unfilled.forEach((u) => {
            byRole[u.role] = (byRole[u.role] || 0) + 1;
            Object.keys(u.reasons).forEach((k) => { reasons[k] = Math.max(reasons[k] || 0, u.reasons[k]); });
          });
          const roleText = Object.keys(byRole)
            .map((r) => (r === 'any' ? '' : ROLE_LABELS[r]) + byRole[r] + '人')
            .join('、');
          const reasonText = Object.keys(reasons)
            .sort((a, b) => reasons[b] - reasons[a])
            .slice(0, 3)
            .map((k) => REASON_LABELS[k] + reasons[k] + '人')
            .join('、');
          warnings.push({
            type: 'shortage',
            date: day.date,
            slotName: cell.slot.name,
            count: cell.unfilled.length,
            message: day.date + '(' + day.weekdayLabel + ')' + cell.slot.name + ': ' + roleText + '不足'
              + (reasonText ? '(入れなかった理由: ' + reasonText + ')' : ''),
          });
        }
        if (cell.noLeader && cell.slot.leaderLevel > 0) {
          warnings.push({
            type: 'leader',
            date: day.date,
            slotName: cell.slot.name,
            message: day.date + '(' + day.weekdayLabel + ')' + cell.slot.name + ': レベル'
              + cell.slot.leaderLevel + '以上の担当者がいません。',
          });
        }
      });
    });

    const staffSummary = staff.map((s) => {
      const st = state[s.id];
      const dates = Array.from(st.dates).sort();
      let maxRun = 0;
      let run = 0;
      dates.forEach((d, i) => {
        run = i > 0 && addDays(dates[i - 1], 1) === d ? run + 1 : 1;
        if (run > maxRun) maxRun = run;
      });
      return {
        id: s.id,
        name: s.name,
        level: s.level,
        floor: s.floor,
        kitchen: s.kitchen,
        targetDays: s.targetDays,
        assignedDays: st.assigned,
        diff: st.assigned - s.targetDays,
        bySlot: Object.assign({}, st.slotCount),
        maxConsecutive: maxRun,
        dates: dates,
      };
    });

    staffSummary.forEach((row) => {
      if (row.diff < 0) {
        warnings.push({
          type: 'unmet',
          message: row.name + ': 出勤日数が ' + row.assignedDays + '日 / 目標 ' + row.targetDays + '日('
            + row.diff + '日)',
        });
      }
    });

    const requiredTotal = days.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.required, 0), 0);
    const assignedTotal = days.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.assigned.length, 0), 0);

    return {
      ok: true,
      errors: [],
      store: store,
      slots: slots,
      days: days,
      staffSummary: staffSummary,
      warnings: warnings,
      stats: {
        openDays: openDays.length,
        closedDays: days.length - openDays.length,
        requiredTotal: requiredTotal,
        assignedTotal: assignedTotal,
        shortage: requiredTotal - assignedTotal,
        fillRate: requiredTotal ? assignedTotal / requiredTotal : 1,
        targetTotal: staff.reduce((n, s) => n + s.targetDays, 0),
      },
    };
  }

  // ---------------- CSV ----------------

  function toCsvByDate(result) {
    const rows = [['日付', '曜日', '時間帯', '開始', '終了', '担当', 'スタッフ', 'レベル']];
    result.days.forEach((day) => {
      if (day.closed) {
        rows.push([day.date, day.weekdayLabel, '定休日', '', '', '', '', '']);
        return;
      }
      day.cells.forEach((cell) => {
        cell.assigned.forEach((a) => {
          rows.push([day.date, day.weekdayLabel, cell.slot.name, cell.slot.start, cell.slot.end,
            ROLE_LABELS[a.role] || '', a.name + (a.isLeader ? '(リーダー)' : ''), a.level]);
        });
        cell.unfilled.forEach((u) => {
          rows.push([day.date, day.weekdayLabel, cell.slot.name, cell.slot.start, cell.slot.end,
            ROLE_LABELS[u.role] || '', '(不足)', '']);
        });
      });
    });
    return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  function toCsvByStaff(result) {
    const slots = result.slots || [];
    const header = ['スタッフ', 'レベル', 'フロア', 'キッチン', '目標出勤日数', '実績', '過不足']
      .concat(slots.map((s) => s.name), ['出勤日']);
    const rows = [header];
    result.staffSummary.forEach((row) => {
      rows.push([
        row.name, row.level, row.floor ? '可' : '不可', row.kitchen ? '可' : '不可',
        row.targetDays, row.assignedDays, row.diff,
      ].concat(slots.map((s) => row.bySlot[s.id] || 0), [row.dates.join(' ')]));
    });
    return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  // 日付 × 時間帯の表(画面・印刷用)
  function toMatrix(result) {
    return result.days.map((day) => ({
      date: day.date,
      weekdayLabel: day.weekdayLabel,
      weekday: day.weekday,
      closed: day.closed,
      cells: (result.slots || []).map((slot) => {
        const cell = day.cells.find((c) => c.slot.id === slot.id);
        return cell || null;
      }),
    }));
  }

  // ---------------- サンプルデータ ----------------

  function sampleData(refDate) {
    const base = isValidDate(refDate) ? refDate : formatDate(new Date());
    const first = base.slice(0, 8) + '01';
    const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
    const store = {
      name: 'カフェ 本店',
      periodStart: first,
      periodEnd: last,
      closedWeekdays: [2],
      closedDates: [],
      slots: [
        { id: 'early', name: '早番', start: '08:00', end: '15:00', required: 3, requiredWeekend: 4, requiredFloor: 2, requiredKitchen: 1, leaderLevel: 3, weekdays: [0, 1, 2, 3, 4, 5, 6] },
        { id: 'late', name: '遅番', start: '14:00', end: '21:00', required: 3, requiredWeekend: 4, requiredFloor: 2, requiredKitchen: 1, leaderLevel: 3, weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ],
    };
    const staff = [
      { id: 'p1', name: '佐藤 店長', level: 5, floor: true, kitchen: true, targetDays: 20, availableSlots: ['early', 'late'] },
      { id: 'p2', name: '鈴木 主任', level: 4, floor: true, kitchen: true, targetDays: 20, availableSlots: ['early', 'late'] },
      { id: 'p3', name: '高橋 (ホール)', level: 3, floor: true, kitchen: false, targetDays: 18, availableSlots: ['early', 'late'] },
      { id: 'p4', name: '田中 (ホール)', level: 2, floor: true, kitchen: false, targetDays: 16, availableSlots: ['late'] },
      { id: 'p5', name: '伊藤 (キッチン)', level: 4, floor: false, kitchen: true, targetDays: 20, availableSlots: ['early', 'late'] },
      { id: 'p6', name: '渡辺 (キッチン)', level: 3, floor: false, kitchen: true, targetDays: 18, availableSlots: ['early', 'late'] },
      { id: 'p7', name: '山本 (学生)', level: 2, floor: true, kitchen: false, targetDays: 8, availableWeekdays: [0, 5, 6], availableSlots: ['late'] },
      { id: 'p8', name: '中村 (学生)', level: 1, floor: true, kitchen: false, targetDays: 8, availableWeekdays: [0, 6], availableSlots: ['early', 'late'] },
      { id: 'p9', name: '小林 (主婦)', level: 3, floor: true, kitchen: true, targetDays: 12, availableWeekdays: [1, 2, 3, 4, 5], availableSlots: ['early'] },
      { id: 'p10', name: '加藤 (新人)', level: 1, floor: true, kitchen: true, targetDays: 14, availableSlots: ['early', 'late'] },
    ];
    return { store: store, staff: staff };
  }

  return {
    WEEKDAY_LABELS: WEEKDAY_LABELS,
    ROLE_LABELS: ROLE_LABELS,
    LEVEL_LABELS: LEVEL_LABELS,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    generate: generate,
    toCsvByDate: toCsvByDate,
    toCsvByStaff: toCsvByStaff,
    toMatrix: toMatrix,
    sampleData: sampleData,
    eachDate: eachDate,
    addDays: addDays,
    weekdayOf: weekdayOf,
    isValidDate: isValidDate,
  };
});
