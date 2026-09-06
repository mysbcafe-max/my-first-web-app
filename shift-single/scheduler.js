/*
 * 一店舗用シフト生成ロジック(UI から独立した純粋な関数群)
 *
 * ブラウザでは window.SingleShiftScheduler として、Node では module.exports として使える。
 * 外部ライブラリ・外部 API には依存しない(費用ゼロ)。
 *
 * 「役割(担当)」は店舗ごとに自由に定義する。
 *   例) au ショップ: フロア / カウンター / 事務
 *       飲食店     : ホール / キッチン
 *       小売       : レジ / 売場
 *
 * 入力
 *   store : 店舗設定(期間・定休日・役割・時間帯(枠)ごとの必要人数)
 *   staff : スタッフ一覧(できる役割・レベル・出勤日数 など)
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

  // 役割を指定しない枠(誰でもよい)の表示
  const ANY_ROLE = 'any';
  const ANY_ROLE_LABEL = '—';

  const DEFAULT_LEVEL_LABELS = ['研修中', '一人立ち', '中堅', 'リーダー', '店長代行'];

  // 業態別のひな形。店舗設定に流し込んで使う
  const PRESETS = {
    aushop: {
      // 営業 10:00〜19:00。前後30分が開店準備・締め作業の時間
      label: 'au ショップ / 携帯ショップ',
      roles: ['フロア', 'カウンター', '事務'],
      levelLabels: ['研修中', '一人立ち', '一通り対応可', 'リーダー', '店長代行'],
      slots: [
        { name: 'C(早番)', start: '09:30', end: '18:30', required: 3, requiredWeekend: 4, byRole: [1, 2, 0], leaderLevel: 4, requiresOpen: true },
        { name: 'B(遅番)', start: '10:30', end: '19:30', required: 3, requiredWeekend: 4, byRole: [1, 2, 0], leaderLevel: 3, requiresClose: true },
      ],
    },
    restaurant: {
      label: '飲食店・カフェ',
      roles: ['ホール', 'キッチン'],
      levelLabels: ['研修中', '一人立ち', '中堅', 'リーダー', '店長代行'],
      slots: [
        { name: '早番', start: '08:00', end: '15:00', required: 3, requiredWeekend: 4, byRole: [2, 1], leaderLevel: 3, requiresOpen: true },
        { name: '遅番', start: '14:00', end: '21:00', required: 3, requiredWeekend: 4, byRole: [2, 1], leaderLevel: 3, requiresClose: true },
      ],
    },
    retail: {
      label: '小売・アパレル',
      roles: ['レジ', '売場'],
      levelLabels: ['研修中', '一人立ち', '中堅', 'リーダー', '店長代行'],
      slots: [
        { name: '早番', start: '09:00', end: '15:00', required: 2, requiredWeekend: 3, byRole: [1, 1], leaderLevel: 3 },
        { name: '遅番', start: '14:00', end: '20:00', required: 2, requiredWeekend: 3, byRole: [1, 1], leaderLevel: 2 },
      ],
    },
    simple: {
      label: '役割を分けない',
      roles: [],
      levelLabels: DEFAULT_LEVEL_LABELS.slice(),
      slots: [
        { name: '早番', start: '09:00', end: '15:00', required: 2, requiredWeekend: 2, byRole: [], leaderLevel: 3 },
        { name: '遅番', start: '15:00', end: '21:00', required: 2, requiredWeekend: 2, byRole: [], leaderLevel: 2 },
      ],
    },
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

  // ---------------- 時刻 ----------------

  function isValidTime(str) {
    return /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(str || ''));
  }

  // 'HH:MM' → 0時からの分数。不正なら null
  function toMinutes(str) {
    if (!isValidTime(str)) return null;
    const [h, m] = String(str).split(':').map(Number);
    return (h * 60) + m;
  }

  function fromMinutes(min) {
    const m = ((min % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  // 枠の時間帯を分に直す(終了が開始以前なら翌日にまたぐものとして扱う)
  function slotSpan(slot) {
    const start = toMinutes(slot.start);
    let end = toMinutes(slot.end);
    if (start === null || end === null) return null;
    if (end <= start) end += 1440;
    return { start: start, end: end };
  }

  // スタッフの勤務可能時間を、その枠の時間軸に合わせて分に直す
  function staffSpan(staff, span) {
    const rawStart = toMinutes(staff.startLimit);
    const rawEnd = toMinutes(staff.endLimit);
    const start = rawStart === null ? span.start : rawStart;
    let end = rawEnd === null ? span.end : rawEnd;
    // 深夜にまたぐ枠のときだけ、終了時刻を翌日側として扱う
    // (通常の枠では「枠より前に上がる人」はそのまま重なりなしと判定させる)
    if (span.end > 1440 && end < start) end += 1440;
    return { start: start, end: end };
  }

  /*
   * その枠にそのスタッフが入ったときの実際の勤務時間。
   * 重なりがなければ null(その枠には入れない)。
   */
  function effectiveSpan(staff, slot) {
    const span = slotSpan(slot);
    if (!span) return { start: null, end: null, coversOpen: true, coversClose: true, shortened: false };
    const own = staffSpan(staff, span);
    const start = Math.max(span.start, own.start);
    const end = Math.min(span.end, own.end);
    if (end <= start) return null;
    return {
      start: start,
      end: end,
      startLabel: fromMinutes(start),
      endLabel: fromMinutes(end),
      coversOpen: start <= span.start,   // 開店準備の時間から入れるか
      coversClose: end >= span.end,      // 締め作業の時間まで残れるか
      shortened: start > span.start || end < span.end,
    };
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

  function normalizeRoles(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = {};
    const out = [];
    raw.forEach((r, i) => {
      const src = typeof r === 'string' ? { id: 'role' + (i + 1), name: r } : (r || {});
      const id = String(src.id || 'role' + (i + 1));
      if (seen[id]) return;
      seen[id] = true;
      out.push({ id: id, name: String(src.name || '役割' + (i + 1)) });
    });
    return out;
  }

  function normalizeLevelLabels(raw) {
    const out = DEFAULT_LEVEL_LABELS.slice();
    if (Array.isArray(raw)) {
      raw.slice(0, 5).forEach((label, i) => {
        const s = String(label || '').trim();
        if (s) out[i] = s;
      });
    }
    return out;
  }

  function normalizeSlot(raw, i, roles) {
    const src = raw || {};
    const required = Math.max(0, toInt(src.required, 0));
    const rw = src.requiredWeekend;
    const requiredByRole = {};
    roles.forEach((role) => {
      requiredByRole[role.id] = Math.max(0, toInt((src.requiredByRole || {})[role.id], 0));
    });
    return {
      id: String(src.id || 'slot' + (i + 1)),
      name: String(src.name || '枠' + (i + 1)),
      start: String(src.start || ''),
      end: String(src.end || ''),
      required: required,
      // 土日の必要人数(未入力なら平日と同じ)
      requiredWeekend: rw === '' || rw === null || rw === undefined ? null : Math.max(0, toInt(rw, required)),
      requiredByRole: requiredByRole,
      leaderLevel: clamp(toInt(src.leaderLevel, 0), 0, 5),
      // 開店準備・締め作業をこの枠で行うか(行うなら担当できる人を必ず1人入れる)
      requiresOpen: !!src.requiresOpen,
      requiresClose: !!src.requiresClose,
      weekdays: normalizeWeekdays(src.weekdays, [0, 1, 2, 3, 4, 5, 6]),
    };
  }

  function normalizeStore(raw) {
    const src = raw || {};
    const roles = normalizeRoles(src.roles);
    return {
      name: String(src.name || '店舗'),
      periodStart: String(src.periodStart || ''),
      periodEnd: String(src.periodEnd || ''),
      closedWeekdays: normalizeWeekdays(src.closedWeekdays, []),
      closedDates: normalizeDates(src.closedDates),
      roles: roles,
      levelLabels: normalizeLevelLabels(src.levelLabels),
      // 勤務日数の既定の数え方: 'work'(出勤日数) / 'holiday'(公休日数)
      dayCountMode: src.dayCountMode === 'holiday' ? 'holiday' : 'work',
      slots: (Array.isArray(src.slots) ? src.slots : []).map((s, i) => normalizeSlot(s, i, roles)),
    };
  }

  function normalizeStaff(raw, slotIds, roleIds) {
    return (Array.isArray(raw) ? raw : []).map((src, i) => {
      const s = src || {};
      const availableSlots = Array.isArray(s.availableSlots)
        ? s.availableSlots.map(String).filter((id) => slotIds.indexOf(id) >= 0)
        : slotIds.slice();
      // roles が未指定なら「すべての役割ができる」扱い
      const roles = Array.isArray(s.roles)
        ? s.roles.map(String).filter((id) => roleIds.indexOf(id) >= 0)
        : roleIds.slice();
      return {
        id: String(s.id || 'staff' + (i + 1)),
        name: String(s.name || '(名前なし)'),
        level: clamp(toInt(s.level, 1), 1, 5),
        roles: roles,                                            // できる役割(担当)
        // 時短勤務: 出勤できる最早時刻・退勤する最遅時刻(空なら枠の時間どおり)
        startLimit: isValidTime(s.startLimit) ? String(s.startLimit) : '',
        endLimit: isValidTime(s.endLimit) ? String(s.endLimit) : '',
        canOpen: s.canOpen === undefined ? true : !!s.canOpen,    // 開店準備ができる
        canClose: s.canClose === undefined ? true : !!s.canClose, // 締め作業ができる
        // 日数の基準: '' なら店舗の既定、'work' なら出勤日数、'holiday' なら公休日数
        dayCountMode: (s.dayCountMode === 'work' || s.dayCountMode === 'holiday') ? s.dayCountMode : '',
        holidayDays: Math.max(0, toInt(s.holidayDays, 0)),       // 期間内の公休日数
        targetDays: Math.max(0, toInt(s.targetDays, 0)),         // 期間内の出勤日数(目標かつ上限)
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

  function roleSum(slot) {
    return Object.keys(slot.requiredByRole).reduce((n, k) => n + slot.requiredByRole[k], 0);
  }

  function requiredOf(slot, date) {
    const base = isWeekend(date) && slot.requiredWeekend !== null ? slot.requiredWeekend : slot.required;
    return Math.max(base, roleSum(slot));
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
    const roles = store.roles;
    const roleIds = roles.map((r) => r.id);
    const staff = normalizeStaff(input && input.staff, slots.map((s) => s.id), roleIds);

    const roleNameOf = {};
    roles.forEach((r) => { roleNameOf[r.id] = r.name; });
    function roleLabel(roleId) {
      return roleId === ANY_ROLE ? ANY_ROLE_LABEL : (roleNameOf[roleId] || roleId);
    }

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
      return { ok: false, errors: errors, store: store, roles: roles, slots: slots, days: [], staffSummary: [], warnings: [], stats: null };
    }

    const allDates = eachDate(store.periodStart, store.periodEnd);

    // 公休日数で設定している人は「期間の全日数 − 公休日数」を出勤日数として扱う
    staff.forEach((s) => {
      s.resolvedMode = s.dayCountMode || store.dayCountMode;
      s.inputDays = s.resolvedMode === 'holiday' ? s.holidayDays : s.targetDays;
      if (s.resolvedMode === 'holiday') {
        s.targetDays = Math.max(0, allDates.length - s.holidayDays);
      }
    });

    // 設定の穴を先に知らせる
    slots.forEach((slot) => {
      const sum = roleSum(slot);
      if (slot.required < sum) {
        setupWarnings.push({
          type: 'setup',
          message: '「' + slot.name + '」は必要人数(' + slot.required + '人)が役割ごとの必須人数の合計('
            + sum + '人)より少ないため、' + sum + '人として扱います。',
        });
      }
    });
    slots.forEach((slot) => {
      if (slot.requiresClose && !staff.some((s) => s.canClose && s.availableSlots.indexOf(slot.id) >= 0)) {
        setupWarnings.push({
          type: 'setup',
          message: '「' + slot.name + '」は締め作業ありですが、この枠に入れて締め作業ができるスタッフが登録されていません。',
        });
      }
      if (slot.requiresOpen && !staff.some((s) => s.canOpen && s.availableSlots.indexOf(slot.id) >= 0)) {
        setupWarnings.push({
          type: 'setup',
          message: '「' + slot.name + '」は開店準備ありですが、この枠に入れて開店準備ができるスタッフが登録されていません。',
        });
      }
    });
    staff.forEach((s) => {
      if (roles.length && !s.roles.length) {
        setupWarnings.push({ type: 'setup', message: s.name + ' はできる役割が 1 つも選ばれていないため、シフトに入れられません。' });
      }
      if (!s.availableSlots.length) {
        setupWarnings.push({ type: 'setup', message: s.name + ' は対応できる時間帯が 1 つも選ばれていません。' });
      }
      if (s.targetDays === 0) {
        setupWarnings.push({
          type: 'setup',
          message: s.resolvedMode === 'holiday'
            ? s.name + ' は公休日数が期間の全日数以上のため、シフトに入りません。'
            : s.name + ' は出勤日数が 0 日のため、シフトに入りません。',
        });
      }
    });

    const staffById = {};
    staff.forEach((s) => { staffById[s.id] = s; });

    // 開店準備・締め作業を担当できるか(その時間まで居られて、かつ担当できる人)
    function canOpenFor(s, slot) {
      if (!s.canOpen) return false;
      const span = effectiveSpan(s, slot);
      return !!span && span.coversOpen;
    }

    function canCloseFor(s, slot) {
      if (!s.canClose) return false;
      const span = effectiveSpan(s, slot);
      return !!span && span.coversClose;
    }

    function cellHasOpener(cell) {
      return cell.assigned.some((a) => a.coversOpen && a.canOpen);
    }

    function cellHasCloser(cell) {
      return cell.assigned.some((a) => a.coversClose && a.canClose);
    }

    // 役割を使わない設定(roles が空)のときは、誰でもどの枠にも入れる
    function canServe(s, roleId) {
      if (!roles.length) return true;
      if (roleId === ANY_ROLE) return s.roles.length > 0;
      return s.roles.indexOf(roleId) >= 0;
    }

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
          noCloser: false,
          noOpener: false,
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
        roleCount: {},
        passed: 0,        // 「入れたのに入らなかった日」= 残り機会の目減り
        availableTotal: 0,
      };
    });

    // その日にそのスタッフが働ける枠があるか(人数上限などは見ない、素の可否)
    function couldWorkDay(s, day) {
      if (roles.length && !s.roles.length) return false;
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
      if (roles.length && !s.roles.length) return 'norole';
      if (s.availableWeekdays.indexOf(weekdayOf(date)) < 0) return 'weekday';
      if (s.daysOff.indexOf(date) >= 0) return 'dayoff';
      if (s.availableSlots.indexOf(cell.slot.id) < 0) return 'slot';
      if (!effectiveSpan(s, cell.slot)) return 'time';
      const st = state[s.id];
      if (st.dates.has(date)) return 'sameday';
      if (st.assigned >= s.targetDays) return 'target';
      const maxc = maxConsecutiveOf(s);
      if (maxc > 0 && runBefore(s, date) + 1 + runAfter(s, date) > maxc) return 'consecutive';
      return null;
    }

    const REASON_LABELS = {
      norole: 'できる役割が未設定',
      weekday: '勤務できない曜日',
      dayoff: '希望休',
      slot: 'この時間帯に対応できない',
      time: '勤務できる時間と枠が合わない',
      sameday: '同じ日の別の枠に勤務',
      target: '出勤日数の上限に到達',
      consecutive: '連勤上限',
      capability: 'この役割ができない',
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
      const span = effectiveSpan(s, cell.slot) || {};
      cell.assigned.push({
        id: s.id, name: s.name, level: s.level, role: role,
        roleLabel: roleLabel(role), isLeader: !!isLeader,
        start: span.startLabel || cell.slot.start,
        end: span.endLabel || cell.slot.end,
        shortened: !!span.shortened,
        canOpen: !!s.canOpen,
        canClose: !!s.canClose,
        coversOpen: span.coversOpen !== false,
        coversClose: span.coversClose !== false,
      });
      st.assigned += 1;
      st.dates.add(date);
      st.slotCount[cell.slot.id] = (st.slotCount[cell.slot.id] || 0) + 1;
      st.roleCount[role] = (st.roleCount[role] || 0) + 1;
    }

    function unassign(s, cell) {
      const st = state[s.id];
      const idx = cell.assigned.findIndex((a) => a.id === s.id);
      if (idx < 0) return null;
      const removed = cell.assigned.splice(idx, 1)[0];
      st.slotCount[cell.slot.id] -= 1;
      st.roleCount[removed.role] -= 1;
      return removed;
    }

    // 枠を埋める
    function fillCell(cell, date) {
      const slot = cell.slot;
      const demands = [];
      roles.forEach((role) => {
        for (let i = 0; i < (slot.requiredByRole[role.id] || 0); i += 1) demands.push(role.id);
      });
      while (demands.length < cell.required) demands.push(ANY_ROLE);

      // 候補が少ない役割から埋める(あとから埋まらなくなるのを防ぐ)
      const scarcity = {};
      demands.concat([ANY_ROLE]).forEach((role) => {
        if (scarcity[role] === undefined) scarcity[role] = candidatesFor(cell, date, role, null).length;
      });
      demands.sort((a, b) => (scarcity[a] - scarcity[b]) || (a < b ? -1 : a > b ? 1 : 0));

      /*
       * 先に「必ず満たしたい条件」を1人ずつ埋める。
       * 条件を満たす人は、担当できる中でいちばん候補が少ない役割に入れる。
       * すでに条件を満たす人が入っていれば、追加では取らない。
       */
      function placeRequirement(filter, mark) {
        for (let i = 0; i < demands.length; i += 1) {
          const role = demands[i];
          const cands = candidatesFor(cell, date, role, null).filter(filter);
          if (!cands.length) continue;
          const best = pickBest(cands, cell, date);
          assign(best, cell, date, role, mark === 'leader');
          demands.splice(i, 1);
          return true;
        }
        return false;
      }

      // リーダー要件
      if (slot.leaderLevel > 0) {
        if (!placeRequirement((s) => s.level >= slot.leaderLevel, 'leader')) cell.noLeader = true;
      }

      // 締め作業: 時短などで締めまで残れない人しかいない枠にならないようにする
      if (slot.requiresClose && !cellHasCloser(cell)) {
        if (!placeRequirement((s) => canCloseFor(s, slot), 'close')) cell.noCloser = true;
      }

      // 開店準備
      if (slot.requiresOpen && !cellHasOpener(cell)) {
        if (!placeRequirement((s) => canOpenFor(s, slot), 'open')) cell.noOpener = true;
      }

      demands.forEach((role) => {
        const tally = {};
        const cands = candidatesFor(cell, date, role, tally);
        if (!cands.length) {
          cell.unfilled.push({ role: role, roleLabel: roleLabel(role), reasons: tally });
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
          // x を抜いても、B 側の締め作業・開店準備の担当が残るか
          const otherKeepsCloser = !other.slot.requiresClose
            || other.assigned.some((o) => o.id !== a.id && o.canClose && o.coversClose);
          const otherKeepsOpener = !other.slot.requiresOpen
            || other.assigned.some((o) => o.id !== a.id && o.canOpen && o.coversOpen);
          const cands = candidatesFor(other, day.date, a.role, null)
            .filter((y) => otherKeepsLeader || y.level >= leadB)
            .filter((y) => otherKeepsCloser || canCloseFor(y, other.slot))
            .filter((y) => otherKeepsOpener || canOpenFor(y, other.slot));
          if (!cands.length) continue;
          const y = pickBest(cands, other, day.date);
          const removed = unassign(x, other);
          if (!removed) continue;
          assign(x, target, day.date, role, false);
          assign(y, other, day.date, removed.role, leadB > 0 && !otherKeepsLeader);
          if (other.slot.requiresClose) other.noCloser = !cellHasCloser(other);
          if (other.slot.requiresOpen) other.noOpener = !cellHasOpener(other);
          if (target.slot.requiresClose) target.noCloser = !cellHasCloser(target);
          if (target.slot.requiresOpen) target.noOpener = !cellHasOpener(target);
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

    function dayDifficulty(day) {
      const required = day.cells.reduce((n, c) => n + c.required, 0);
      const cands = staff.filter((s) => couldWorkDay(s, day) && s.targetDays > 0).length;
      return cands === 0 ? Infinity : required / cands;
    }

    // 埋めにくい日から順に処理する(候補に対して必要人数が多い日 = 土日など)
    const order = openDays.slice().sort((a, b) => {
      const da = dayDifficulty(a);
      const db = dayDifficulty(b);
      if (da !== db) return db - da;
      return a.date < b.date ? -1 : 1;
    });

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
            .map((r) => (r === ANY_ROLE ? '' : roleLabel(r)) + byRole[r] + '人')
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
        if (cell.noCloser && cell.slot.requiresClose) {
          warnings.push({
            type: 'close',
            date: day.date,
            slotName: cell.slot.name,
            message: day.date + '(' + day.weekdayLabel + ')' + cell.slot.name + ': 締め作業(' + cell.slot.end
              + 'まで)を担当できる人がいません。',
          });
        }
        if (cell.noOpener && cell.slot.requiresOpen) {
          warnings.push({
            type: 'open',
            date: day.date,
            slotName: cell.slot.name,
            message: day.date + '(' + day.weekdayLabel + ')' + cell.slot.name + ': 開店準備(' + cell.slot.start
              + 'から)を担当できる人がいません。',
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
        roles: s.roles.slice(),
        roleNames: s.roles.map((id) => roleNameOf[id] || id),
        dayCountMode: s.resolvedMode,        // 'work'(出勤日数) / 'holiday'(公休日数)
        inputDays: s.inputDays,              // 画面で入力した日数
        targetDays: s.targetDays,            // 実際に目標とする出勤日数
        holidayTarget: s.resolvedMode === 'holiday' ? s.holidayDays : allDates.length - s.targetDays,
        assignedDays: st.assigned,
        restDays: allDates.length - st.assigned,   // 実際の休みの日数
        startLimit: s.startLimit,
        endLimit: s.endLimit,
        canOpen: s.canOpen,
        canClose: s.canClose,
        diff: s.targetDays - st.assigned === 0 ? 0 : st.assigned - s.targetDays,
        bySlot: Object.assign({}, st.slotCount),
        byRole: Object.assign({}, st.roleCount),
        maxConsecutive: maxRun,
        dates: dates,
      };
    });

    staffSummary.forEach((row) => {
      if (row.diff < 0) {
        warnings.push({
          type: 'unmet',
          message: row.dayCountMode === 'holiday'
            ? row.name + ': 公休が ' + row.restDays + '日 になります(設定 ' + row.holidayTarget + '日 / '
              + (row.restDays - row.holidayTarget) + '日 多い)'
            : row.name + ': 出勤日数が ' + row.assignedDays + '日 / 目標 ' + row.targetDays + '日('
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
      roles: roles,
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
    const rows = [['日付', '曜日', '時間帯', '勤務開始', '勤務終了', '担当', 'スタッフ', 'レベル', '備考']];
    result.days.forEach((day) => {
      if (day.closed) {
        rows.push([day.date, day.weekdayLabel, '定休日', '', '', '', '', '']);
        return;
      }
      day.cells.forEach((cell) => {
        cell.assigned.forEach((a) => {
          const notes = [];
          if (a.isLeader) notes.push('リーダー');
          if (cell.slot.requiresClose && a.canClose && a.coversClose) notes.push('締め');
          if (cell.slot.requiresOpen && a.canOpen && a.coversOpen) notes.push('開店');
          if (a.shortened) notes.push('時短');
          rows.push([day.date, day.weekdayLabel, cell.slot.name, a.start, a.end,
            a.roleLabel, a.name, a.level, notes.join('・')]);
        });
        cell.unfilled.forEach((u) => {
          rows.push([day.date, day.weekdayLabel, cell.slot.name, cell.slot.start, cell.slot.end,
            u.roleLabel, '(不足)', '', '']);
        });
      });
    });
    return rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  }

  function toCsvByStaff(result) {
    const slots = result.slots || [];
    const roles = result.roles || [];
    const header = ['スタッフ', 'レベル']
      .concat(roles.map((r) => r.name),
        ['勤務時間', '開店準備', '締め作業', '基準', '目標出勤日数', '実績', '過不足', '公休'],
        slots.map((s) => s.name), ['出勤日']);
    const rows = [header];
    result.staffSummary.forEach((row) => {
      const hours = (row.startLimit || row.endLimit)
        ? (row.startLimit || '') + '〜' + (row.endLimit || '') : '';
      rows.push([row.name, row.level]
        .concat(
          roles.map((r) => (row.roles.indexOf(r.id) >= 0 ? '可' : '不可')),
          [hours, row.canOpen ? '可' : '不可', row.canClose ? '可' : '不可',
            row.dayCountMode === 'holiday' ? '公休日数' : '出勤日数',
            row.targetDays, row.assignedDays, row.diff, row.restDays],
          slots.map((s) => row.bySlot[s.id] || 0),
          [row.dates.join(' ')]
        ));
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

  // ---------------- プリセット・サンプルデータ ----------------

  // プリセットの内容を店舗設定の形(roles / levelLabels / slots)に展開する
  function presetToStore(presetKey) {
    const preset = PRESETS[presetKey] || PRESETS.simple;
    const roles = preset.roles.map((name, i) => ({ id: 'role' + (i + 1), name: name }));
    const slots = preset.slots.map((slot, i) => {
      const requiredByRole = {};
      roles.forEach((role, ri) => { requiredByRole[role.id] = slot.byRole[ri] || 0; });
      return {
        id: 'slot' + (i + 1),
        name: slot.name,
        start: slot.start,
        end: slot.end,
        required: slot.required,
        requiredWeekend: slot.requiredWeekend === undefined ? null : slot.requiredWeekend,
        requiredByRole: requiredByRole,
        leaderLevel: slot.leaderLevel,
        requiresOpen: !!slot.requiresOpen,
        requiresClose: !!slot.requiresClose,
        weekdays: [0, 1, 2, 3, 4, 5, 6],
      };
    });
    return { roles: roles, levelLabels: preset.levelLabels.slice(), slots: slots };
  }

  // プリセットごとのサンプル要員
  // [名前, レベル, できる役割(index の配列), 出勤日数, 勤務できる曜日(省略で毎日),
  //  対応できる時間帯(index、省略で全部), 追加設定(時短・締め可否・公休日数 など)]
  const SAMPLE_STAFF = {
    aushop: [
      ['佐藤 店長', 5, [0, 1, 2], 20, null, null, { dayCountMode: 'holiday', holidayDays: 9 }],
      ['鈴木 副店長', 4, [0, 1, 2], 20, null, null, { dayCountMode: 'holiday', holidayDays: 9 }],
      ['高橋 (カウンター)', 4, [0, 1, 2], 20, null, null, { dayCountMode: 'holiday', holidayDays: 10 }],
      ['田中 (カウンター)', 3, [0, 1], 20, null, null, { dayCountMode: 'holiday', holidayDays: 10 }],
      ['伊藤 (カウンター)', 3, [1], 18, null, [1]],
      ['木村 (時短・カウンター)', 3, [0, 1], 18, null, null, { endLimit: '16:00', canClose: false }],
      ['渡辺 (フロア)', 2, [0], 18],
      ['山本 (フロア)', 2, [0, 2], 16],
      ['中村 (事務)', 3, [0, 2], 14, [1, 2, 3, 4, 5], [0]],
      ['小林 (学生)', 1, [0], 8, [0, 6], null, { canClose: false }],
      ['加藤 (新人)', 1, [0], 14, null, null, { canOpen: false, canClose: false }],
    ],
    restaurant: [
      ['佐藤 店長', 5, [0, 1], 20],
      ['鈴木 主任', 4, [0, 1], 20],
      ['高橋 (ホール)', 3, [0], 18],
      ['田中 (ホール)', 2, [0], 16, null, [1]],
      ['伊藤 (キッチン)', 4, [1], 20],
      ['渡辺 (キッチン)', 3, [1], 18],
      ['山本 (学生)', 2, [0], 8, [0, 5, 6], [1]],
      ['中村 (学生)', 1, [0], 8, [0, 6]],
      ['小林 (主婦)', 3, [0, 1], 12, [1, 2, 3, 4, 5], [0]],
      ['加藤 (新人)', 1, [0, 1], 14],
    ],
    retail: [
      ['佐藤 店長', 5, [0, 1], 20],
      ['鈴木 主任', 4, [0, 1], 20],
      ['高橋', 3, [0, 1], 18],
      ['田中', 3, [1], 18],
      ['伊藤', 2, [0], 16],
      ['渡辺', 2, [1], 14],
      ['山本 (学生)', 1, [1], 8, [0, 6]],
      ['中村 (新人)', 1, [0, 1], 12],
    ],
    simple: [
      ['佐藤 店長', 5, [], 20],
      ['鈴木 主任', 4, [], 20],
      ['高橋', 3, [], 20],
      ['田中', 2, [], 18],
      ['伊藤', 2, [], 18],
      ['渡辺 (学生)', 1, [], 10, [0, 6]],
    ],
  };

  function sampleData(presetKey, refDate) {
    const key = PRESETS[presetKey] ? presetKey : 'aushop';
    const base = isValidDate(refDate) ? refDate : formatDate(new Date());
    const first = base.slice(0, 8) + '01';
    const last = addDays(addDays(first, 32).slice(0, 8) + '01', -1);
    const parts = presetToStore(key);
    const store = {
      name: PRESETS[key].label + ' 〇〇店',
      periodStart: first,
      periodEnd: last,
      closedWeekdays: key === 'restaurant' ? [2] : [],
      closedDates: [],
      roles: parts.roles,
      levelLabels: parts.levelLabels,
      slots: parts.slots,
    };
    const staff = (SAMPLE_STAFF[key] || []).map((row, i) => Object.assign({
      id: 'staff' + (i + 1),
      name: row[0],
      level: row[1],
      roles: row[2].map((ri) => (parts.roles[ri] ? parts.roles[ri].id : null)).filter(Boolean),
      targetDays: row[3],
      availableWeekdays: row[4] || [0, 1, 2, 3, 4, 5, 6],
      availableSlots: (row[5] || parts.slots.map((s, si) => si)).map((si) => parts.slots[si].id),
      daysOff: [],
      maxConsecutiveDays: 0,
      startLimit: '',
      endLimit: '',
      canOpen: true,
      canClose: true,
      dayCountMode: '',
      holidayDays: 0,
      note: '',
    }, row[6] || {}));
    return { store: store, staff: staff };
  }

  return {
    WEEKDAY_LABELS: WEEKDAY_LABELS,
    ANY_ROLE: ANY_ROLE,
    ANY_ROLE_LABEL: ANY_ROLE_LABEL,
    DEFAULT_LEVEL_LABELS: DEFAULT_LEVEL_LABELS,
    DEFAULT_OPTIONS: DEFAULT_OPTIONS,
    PRESETS: PRESETS,
    presetToStore: presetToStore,
    generate: generate,
    toCsvByDate: toCsvByDate,
    toCsvByStaff: toCsvByStaff,
    toMatrix: toMatrix,
    sampleData: sampleData,
    eachDate: eachDate,
    addDays: addDays,
    effectiveSpan: effectiveSpan,
    isValidTime: isValidTime,
    weekdayOf: weekdayOf,
    isValidDate: isValidDate,
  };
});
