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
    module.exports = factory(require('./holidays.js'));
  } else {
    root.SingleShiftScheduler = factory(root.ShiftHolidays);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Holidays) {
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
      // 1日の合計は 平日4.5・土日祝5 カウント(通常1・時短0.5)
      label: 'au ショップ / 携帯ショップ',
      roles: ['フロア', 'カウンター', '事務'],
      levelLabels: ['研修中', '一人立ち', '一通り対応可', 'リーダー', '店長代行'],
      dayMinCount: 4.5,
      dayMinCountWeekend: 5,
      slots: [
        { name: 'C(早番)', start: '09:30', end: '18:30', required: 2, requiredWeekend: 2, byRole: [1, 1, 0], leaderLevel: 4, requiresOpen: true },
        { name: 'B(遅番)', start: '10:30', end: '19:30', required: 2, requiredWeekend: 2, byRole: [1, 1, 0], leaderLevel: 3, requiresClose: true },
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
    // 出勤時刻を固定している人(時短など)は、その時刻に始まる枠にしか入れない
    if (staff.fixedStart && isValidTime(staff.startLimit)) {
      const fixed = toMinutes(staff.startLimit);
      if (fixed !== span.start && fixed + 1440 !== span.start) return null;
    }
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

  function toNum(v, def) {
    if (v === '' || v === null || v === undefined) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

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

  /*
   * 定休日のルール: { weekday: 0〜6, week: 1〜5 または 'last' }
   * 例) 第1水曜 → { weekday: 3, week: 1 } / 最終月曜 → { weekday: 1, week: 'last' }
   */
  function normalizeClosedRules(v) {
    if (!Array.isArray(v)) return [];
    const seen = {};
    const out = [];
    v.forEach((raw) => {
      const src = raw || {};
      const weekday = toInt(src.weekday, -1);
      if (weekday < 0 || weekday > 6) return;
      const week = src.week === 'last' ? 'last' : toInt(src.week, 0);
      if (week !== 'last' && (week < 1 || week > 5)) return;
      const key = weekday + '/' + week;
      if (seen[key]) return;
      seen[key] = true;
      out.push({ weekday: weekday, week: week });
    });
    return out;
  }

  // その月で「その曜日の何回目」か(1 始まり)
  function weekdayOccurrence(dateStr) {
    const d = Number(String(dateStr).slice(8, 10));
    return Math.floor((d - 1) / 7) + 1;
  }

  // その月で最後のその曜日か
  function isLastWeekdayOfMonth(dateStr) {
    const y = Number(String(dateStr).slice(0, 4));
    const m = Number(String(dateStr).slice(5, 7));
    const d = Number(String(dateStr).slice(8, 10));
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d + 7 > lastDay;
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
    const required = Math.max(0, toNum(src.required, 0));
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
      requiredWeekend: rw === '' || rw === null || rw === undefined ? null : Math.max(0, toNum(rw, required)),
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
      closedRules: normalizeClosedRules(src.closedRules),
      closedDates: normalizeDates(src.closedDates),
      // 1日の合計カウントの下限(空なら使わない)
      dayMinCount: (src.dayMinCount === '' || src.dayMinCount === null || src.dayMinCount === undefined)
        ? null : Math.max(0, toNum(src.dayMinCount, 0)),
      dayMinCountWeekend: (src.dayMinCountWeekend === '' || src.dayMinCountWeekend === null || src.dayMinCountWeekend === undefined)
        ? null : Math.max(0, toNum(src.dayMinCountWeekend, 0)),
      // 人手が足りないときに平日の必要量を自動で下げるか
      autoRelax: src.autoRelax === undefined ? true : !!src.autoRelax,
      // 祝日を土日と同じ「多めに配置する日」として扱うか
      useHolidays: src.useHolidays === undefined ? true : !!src.useHolidays,
      // 土日祝のほかに、多めに配置したい日(セール日など)
      busyDates: normalizeDates(src.busyDates),
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
        // 出勤時刻を固定する(その時刻に始まる枠にだけ入れる)
        fixedStart: !!s.fixedStart,
        // 人数カウント。null なら自動(枠より短い勤務=時短 は 0.5、それ以外は 1)
        headcount: (s.headcount === '' || s.headcount === null || s.headcount === undefined)
          ? null : Math.max(0, Number(s.headcount) || 0),
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

  // その日が定休日か(毎週の曜日 / 第○曜日 / 臨時休業日)
  function isClosedDate(store, date) {
    const wd = weekdayOf(date);
    if (store.closedWeekdays.indexOf(wd) >= 0) return true;
    if (store.closedDates.indexOf(date) >= 0) return true;
    return store.closedRules.some((rule) => {
      if (rule.weekday !== wd) return false;
      return rule.week === 'last'
        ? isLastWeekdayOfMonth(date)
        : weekdayOccurrence(date) === rule.week;
    });
  }

  function holidayNameOf(date) {
    return Holidays && Holidays.nameOf ? Holidays.nameOf(date) : '';
  }

  // 多めに配置する日(土日・祝日・店舗が指定した繁忙日)
  function isBusyDay(store, date) {
    if (isWeekend(date)) return true;
    if (store.busyDates.indexOf(date) >= 0) return true;
    return !!(store.useHolidays && holidayNameOf(date));
  }

  // 小数の誤差を避けて 0.1 単位に丸める
  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // 3 → '3'、4.5 → '4.5'
  function formatCount(n) {
    const v = round1(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  }

  function roleSum(slot) {
    return Object.keys(slot.requiredByRole).reduce((n, k) => n + slot.requiredByRole[k], 0);
  }

  // その日の店舗全体で必要な合計カウント(設定していなければ 0 = 使わない)
  function requiredDayCount(store, date) {
    const busy = isBusyDay(store, date);
    const value = busy && store.dayMinCountWeekend !== null ? store.dayMinCountWeekend : store.dayMinCount;
    return value === null ? 0 : round1(value);
  }

  // その日に必要なカウント(通常スタッフ1・時短0.5 で数えた合計の下限)
  function requiredOf(slot, date, store) {
    const busy = store ? isBusyDay(store, date) : isWeekend(date);
    const base = busy && slot.requiredWeekend !== null ? slot.requiredWeekend : slot.required;
    return round1(Math.max(0, base));
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
      if (sum > 0 && slot.required < sum) {
        setupWarnings.push({
          type: 'setup',
          message: '「' + slot.name + '」は必要カウント(' + formatCount(slot.required)
            + ')に対して役割ごとの必須人数が ' + sum + '人あります。役割の必須人数は実人数なので、'
            + '必要カウントより多くの人が入ることがあります。',
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
      if (s.fixedStart && isValidTime(s.startLimit)) {
        const matched = slots.filter((slot) => s.availableSlots.indexOf(slot.id) >= 0
          && toMinutes(slot.start) === toMinutes(s.startLimit));
        if (!matched.length) {
          setupWarnings.push({
            type: 'setup',
            message: s.name + ' は出勤時刻を ' + s.startLimit + ' で固定していますが、その時刻に始まる時間帯がありません。',
          });
        }
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

    // 平日の必要量を relax カウントぶん下げる(土日祝は下げない)
    function relaxDay(day, relax) {
      if (!relax || day.busy || day.closed) return;
      let need = relax;
      const slotSum = () => round1(day.cells.reduce((n, c) => n + c.required, 0));
      // まず「1日の合計カウント」を下げる
      if (day.dayRequired > slotSum()) {
        const cut = Math.min(need, round1(day.dayRequired - slotSum()));
        day.dayRequired = round1(day.dayRequired - cut);
        need = round1(need - cut);
      }
      // それでも足りなければ、枠ごとの必要カウントを削る(枠自体は残す)
      if (need > 0.001) {
        day.cells.slice().sort((a, b) => b.required - a.required).forEach((c) => {
          if (need <= 0.001) return;
          const room = Math.max(0, round1(c.required - 0.5));
          const cut = Math.floor(Math.min(need, room) * 2) / 2;
          if (cut > 0) {
            c.required = round1(c.required - cut);
            need = round1(need - cut);
          }
        });
        day.dayRequired = Math.min(day.dayRequired, slotSum());
      }
    }

    // 平日をこれ以上薄くできるか
    function canRelaxMore() {
      return openDays.some((d) => !d.busy
        && (d.dayRequired > round1(d.cells.reduce((n, c) => n + c.required, 0))
          || d.cells.some((c) => c.required > 0.5)));
    }

    let days = [];
    let openDays = [];
    let state = {};

    /*
     * units 個の「0.5 カウント」を平日に均等に配る。
     * 必要な分だけ薄くしたいので、全日を一律に下げるのではなく、
     * 日数で割ってとびとびに適用する。
     */
    function relaxPlan(weekdayDates, units) {
      const plan = {};
      const n = weekdayDates.length;
      if (!n || units <= 0) return plan;
      const base = Math.floor(units / n);
      const extra = units % n;
      weekdayDates.forEach((date, i) => { plan[date] = 0.5 * base; });
      for (let k = 0; k < extra; k += 1) {
        const idx = Math.min(n - 1, Math.round((k * n) / extra));
        plan[weekdayDates[idx]] = round1((plan[weekdayDates[idx]] || 0) + 0.5);
      }
      return plan;
    }

    let weekdayDates = [];

    // 日ごとの枠(cells)を作る
    function buildDays(units) {
      days = allDates.map((date) => {
        const wd = weekdayOf(date);
        const closed = isClosedDate(store, date);
        const cells = closed ? [] : slots
          .filter((slot) => slot.weekdays.indexOf(wd) >= 0)
          .map((slot) => ({
            slot: slot,
            required: requiredOf(slot, date, store),
            baseRequired: requiredOf(slot, date, store),
            demands: roles.reduce((acc, role) => {
              for (let i = 0; i < (slot.requiredByRole[role.id] || 0); i += 1) acc.push(role.id);
              return acc;
            }, []),
            assigned: [],
            unfilled: [],
            assignedCount: 0,
            shortCount: 0,
            shortReasons: {},
            noLeader: false,
            noCloser: false,
            noOpener: false,
          }))
          .filter((cell) => cell.required > 0);
        return {
          date: date,
          weekday: wd,
          weekdayLabel: WEEKDAY_LABELS[wd],
          holidayName: store.useHolidays ? holidayNameOf(date) : '',
          busy: isBusyDay(store, date),
          closed: closed,
          dayRequired: closed ? 0 : requiredDayCount(store, date),
          baseDayRequired: closed ? 0 : requiredDayCount(store, date),
          assignedCount: 0,
          dayShort: 0,
          cells: cells,
        };
      });
      openDays = days.filter((d) => !d.closed && d.cells.length);
      weekdayDates = openDays.filter((d) => !d.busy).map((d) => d.date);
      const plan = relaxPlan(weekdayDates, units || 0);
      days.forEach((d) => relaxDay(d, plan[d.date] || 0));
      openDays = days.filter((d) => !d.closed && d.cells.length);
    }

    // スタッフごとの状態を初期化する
    function initState() {
      state = {};
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
      openDays.forEach((day) => {
        staff.forEach((s) => { if (couldWorkDay(s, day)) state[s.id].availableTotal += 1; });
      });
    }

    // その日にそのスタッフが働ける枠があるか(人数上限などは見ない、素の可否)
    function couldWorkDay(s, day) {
      if (roles.length && !s.roles.length) return false;
      if (s.availableWeekdays.indexOf(day.weekday) < 0) return false;
      if (s.daysOff.indexOf(day.date) >= 0) return false;
      return day.cells.some((cell) => s.availableSlots.indexOf(cell.slot.id) >= 0);
    }

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

    /*
     * 残りカウントに収まる人を優先して選ぶ。
     * 例) あと 0.5 必要なら、通常スタッフ(1)より時短スタッフ(0.5)を先に見る。
     * これをしないと毎日 0.5 ずつ余分に人を使い、月末に人が足りなくなる。
     */
    function pickForGap(cands, cell, date, gap) {
      const fits = cands.filter((c) => headcountOf(c, cell.slot) <= gap + 0.001);
      return pickBest(fits.length ? fits : cands, cell, date);
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

    // そのスタッフがその枠で何カウントになるか
    function headcountOf(s, slot) {
      if (s.headcount !== null) return s.headcount;
      const span = effectiveSpan(s, slot);
      return (span && span.shortened) ? 0.5 : 1;
    }

    function countOf(cell) {
      return round1(cell.assigned.reduce((n, a) => n + a.count, 0));
    }

    function dayCountOf(day) {
      return round1(day.cells.reduce((n, c) => n + countOf(c), 0));
    }

    function assign(s, cell, date, role, isLeader) {
      const st = state[s.id];
      const span = effectiveSpan(s, cell.slot) || {};
      cell.assigned.push({
        count: headcountOf(s, cell.slot),
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
    /*
     * 「必ず満たしたい条件」を1人ずつ埋める共通処理。
     * 役割の必須枠から埋め、空きがなければフリー枠として入れる。
     */
    function placeInCell(cell, date, filter, isLeader) {
      const demands = cell.demands;
      // 候補が少ない役割から埋める。
      // 単純に先頭から埋めると、リーダーが毎回同じ役割に入ってしまい、
      // 候補の少ない役割(カウンターなど)が埋まらなくなる。
      const scarcity = {};
      demands.forEach((role) => {
        if (scarcity[role] === undefined) scarcity[role] = candidatesFor(cell, date, role, null).length;
      });
      const order = demands.map((role, i) => i)
        .sort((a, b) => (scarcity[demands[a]] - scarcity[demands[b]]) || (a - b));

      for (let k = 0; k < order.length; k += 1) {
        const i = order[k];
        const role = demands[i];
        const cands = candidatesFor(cell, date, role, null).filter(filter);
        if (!cands.length) continue;
        assign(pickBest(cands, cell, date), cell, date, role, isLeader);
        demands.splice(i, 1);
        return true;
      }
      const free = candidatesFor(cell, date, ANY_ROLE, null).filter(filter);
      if (!free.length) return false;
      assign(pickBest(free, cell, date), cell, date, ANY_ROLE, isLeader);
      return true;
    }

    /*
     * リーダーを先に押さえる。
     * ほかのスタッフと同じ順番で取り合うと、リーダーの出勤日数が先に尽きて
     * 後半の日がリーダー不在になるため、全日ぶんを先に確保する。
     */
    function ensureLeader(cell, date) {
      const lead = cell.slot.leaderLevel;
      if (lead <= 0) return true;
      if (cell.assigned.some((a) => a.level >= lead)) return true;
      if (placeInCell(cell, date, (s) => s.level >= lead, true)) return true;
      cell.noLeader = true;
      return false;
    }

    function fillCell(cell, date) {
      const slot = cell.slot;
      // 役割ごとの必須人数は「実人数」で確保する(demands はセル作成時に用意済み)
      const demands = cell.demands;

      // 候補が少ない役割から埋める(あとから埋まらなくなるのを防ぐ)
      const scarcity = {};
      demands.concat([ANY_ROLE]).forEach((role) => {
        if (scarcity[role] === undefined) scarcity[role] = candidatesFor(cell, date, role, null).length;
      });
      demands.sort((a, b) => (scarcity[a] - scarcity[b]) || (a < b ? -1 : a > b ? 1 : 0));

      // リーダー要件(先に押さえていなければここで)
      ensureLeader(cell, date);

      // 締め作業: 時短などで締めまで残れない人しかいない枠にならないようにする
      if (slot.requiresClose && !cellHasCloser(cell)) {
        if (!placeInCell(cell, date, (s) => canCloseFor(s, slot), false)) cell.noCloser = true;
      }

      // 開店準備
      if (slot.requiresOpen && !cellHasOpener(cell)) {
        if (!placeInCell(cell, date, (s) => canOpenFor(s, slot), false)) cell.noOpener = true;
      }

      // 役割ごとの必須人数
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

      // カウント合計が必要量に届くまでフリー枠で足す
      // (通常スタッフ 1・時短スタッフ 0.5 で数える)
      let guard = 0;
      while (countOf(cell) < cell.required - 0.001 && guard < 60) {
        const tally = {};
        const cands = candidatesFor(cell, date, ANY_ROLE, tally);
        if (!cands.length) {
          cell.shortReasons = tally;
          break;
        }
        assign(pickForGap(cands, cell, date, cell.required - countOf(cell)), cell, date, ANY_ROLE, false);
        guard += 1;
      }
      cell.assignedCount = countOf(cell);
      cell.shortCount = Math.max(0, round1(cell.required - cell.assignedCount));
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

    // 開店準備・締め作業の担当がいない枠を、同じ日の枠との交換で埋める
    // (人数は動かさず、その日のうちで担当を入れ替えるだけ)
    function dutyOk(s, slot, kind) {
      if (kind === 'close') return canCloseFor(s, slot);
      if (kind === 'open') return canOpenFor(s, slot);
      return s.level >= slot.leaderLevel;
    }

    /*
     * ある枠から removeId を抜いて addStaff を入れても、条件が悪くならないか。
     * もともと満たせていない条件(例: すでにリーダー不在)は、
     * ほかの条件を直す妨げにしない。
     */
    function stillSatisfies(cell, removeId, addStaff, addRole) {
      const rest = cell.assigned.filter((a) => a.id !== removeId);
      const lead = cell.slot.leaderLevel;
      if (lead > 0 && cell.assigned.some((a) => a.level >= lead)
        && !rest.some((a) => a.level >= lead) && addStaff.level < lead) return false;
      if (cell.slot.requiresClose && cellHasCloser(cell)
        && !rest.some((a) => a.canClose && a.coversClose)
        && !canCloseFor(addStaff, cell.slot)) return false;
      if (cell.slot.requiresOpen && cellHasOpener(cell)
        && !rest.some((a) => a.canOpen && a.coversOpen)
        && !canOpenFor(addStaff, cell.slot)) return false;
      return canServe(addStaff, addRole) && !!effectiveSpan(addStaff, cell.slot);
    }

    function trySwapForDuty(day, target, kind) {
      for (let bi = 0; bi < day.cells.length; bi += 1) {
        const other = day.cells[bi];
        if (other === target) continue;
        for (let ai = 0; ai < other.assigned.length; ai += 1) {
          const a = other.assigned[ai];
          const x = staffById[a.id];
          if (!dutyOk(x, target.slot, kind)) continue;
          if (x.availableSlots.indexOf(target.slot.id) < 0) continue;

          for (let ti = 0; ti < target.assigned.length; ti += 1) {
            const b = target.assigned[ti];
            const y = staffById[b.id];
            if (y.availableSlots.indexOf(other.slot.id) < 0) continue;
            // 交換しても両方の枠の条件が壊れないこと
            if (!stillSatisfies(target, b.id, x, b.role)) continue;
            if (!stillSatisfies(other, a.id, y, a.role)) continue;

            const removedX = unassign(x, other);
            const removedY = unassign(y, target);
            assign(x, target, day.date, removedY.role, removedY.isLeader);
            assign(y, other, day.date, removedX.role, removedX.isLeader);
            [target, other].forEach((c) => {
              if (c.slot.requiresClose) c.noCloser = !cellHasCloser(c);
              if (c.slot.requiresOpen) c.noOpener = !cellHasOpener(c);
              if (c.slot.leaderLevel > 0) c.noLeader = !c.assigned.some((z) => z.level >= c.slot.leaderLevel);
            });
            return true;
          }
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
        // 人数を動かせなくても、担当の入れ替えで締め・開店を満たせることがある
        day.cells.forEach((cell) => {
          if (cell.slot.requiresClose && cell.noCloser && trySwapForDuty(day, cell, 'close')) changed = true;
          if (cell.slot.requiresOpen && cell.noOpener && trySwapForDuty(day, cell, 'open')) changed = true;
          if (cell.slot.leaderLevel > 0 && cell.noLeader && trySwapForDuty(day, cell, 'leader')) changed = true;
        });
        if (!changed) break;
      }
    }

    function dayDifficulty(day) {
      // 1日の合計カウントの下限も込みで「その日の必要量」を見る。
      // これを見ないと、土日祝(下限が高い日)が後回しになって人が足りなくなる。
      const required = Math.max(
        day.cells.reduce((n, c) => n + c.required, 0),
        day.dayRequired || 0
      );
      const cands = staff.filter((s) => couldWorkDay(s, day) && s.targetDays > 0).length;
      return cands === 0 ? Infinity : required / cands;
    }

    // 1 回ぶんの割り当て
    function runPass() {
      // 埋めにくい日から順に処理する(候補に対して必要人数が多い日 = 土日など)
      const order = openDays.slice().sort((a, b) => {
        const da = dayDifficulty(a);
        const db = dayDifficulty(b);
        if (da !== db) return db - da;
        return a.date < b.date ? -1 : 1;
      });

      /*
       * まず全日ぶんのリーダーを押さえる。
       * リーダーは人数が限られているので、ほかの枠に使ってしまうと
       * 後半の日で足りなくなる。日ごとの取り合いにしない。
       */
      order.forEach((day) => {
        day.cells
          .slice()
          .sort((a, b) => (b.slot.leaderLevel - a.slot.leaderLevel)
            || (a.slot.id < b.slot.id ? -1 : 1))
          .forEach((cell) => ensureLeader(cell, day.date));
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

      // 枠ごとの人数を満たしたうえで、1日の合計カウントが足りなければ足す
      if (day.dayRequired > 0) {
        let guard = 0;
        while (dayCountOf(day) < day.dayRequired - 0.001 && guard < 60) {
          // 人が少ない枠から順に足していく
          const targets = day.cells.slice().sort((a, b) => (countOf(a) - countOf(b))
            || (a.slot.id < b.slot.id ? -1 : 1));
          let placed = false;
          const gap = day.dayRequired - dayCountOf(day);
          for (let i = 0; i < targets.length && !placed; i += 1) {
            const cands = candidatesFor(targets[i], day.date, ANY_ROLE, null);
            if (!cands.length) continue;
            assign(pickForGap(cands, targets[i], day.date, gap), targets[i], day.date, ANY_ROLE, false);
            placed = true;
          }
          if (!placed) break;
          guard += 1;
        }
      }

        day.cells.forEach((cell) => {
          cell.assignedCount = countOf(cell);
          cell.shortCount = Math.max(0, round1(cell.required - cell.assignedCount));
        });
        day.assignedCount = dayCountOf(day);
        day.dayShort = Math.max(0, round1(day.dayRequired - day.assignedCount));
        // この日に入れたのに入らなかった人は、残りの機会が 1 つ減ったとみなす
        staff.forEach((s) => {
          if (!state[s.id].dates.has(day.date) && couldWorkDay(s, day)) state[s.id].passed += 1;
        });
      });
    }

    /*
     * 必要量を満たしたあと、出勤日数がまだ残っている人を
     * 人の少ない日から順に足していく。
     * 公休や出勤日数は契約なので、余らせずに使い切る。
     */
    function distributeSurplus() {
      // 配ってよい上限は「調整前の設定どおりの必要量」まで
      function dayRoom(day) {
        const base = Math.max(
          day.cells.reduce((n, c) => n + c.baseRequired, 0),
          day.baseDayRequired || 0
        );
        return round1(base - dayCountOf(day));
      }

      let guard = 0;
      while (guard < 800) {
        const remaining = staff.some((s) => state[s.id].assigned < s.targetDays);
        if (!remaining) break;
        const dayOrder = openDays
          .filter((d) => dayRoom(d) > 0.001)
          .sort((a, b) => (dayCountOf(a) - dayCountOf(b)) || (a.date < b.date ? -1 : 1));
        let placed = false;
        for (let i = 0; i < dayOrder.length && !placed; i += 1) {
          const day = dayOrder[i];
          const cells = day.cells.slice().sort((a, b) => countOf(a) - countOf(b));
          for (let j = 0; j < cells.length && !placed; j += 1) {
            const cands = candidatesFor(cells[j], day.date, ANY_ROLE, null);
            if (!cands.length) continue;
            assign(pickForGap(cands, cells[j], day.date, dayRoom(day)), cells[j], day.date, ANY_ROLE, false);
            placed = true;
          }
        }
        if (!placed) break;
        guard += 1;
      }
      days.forEach((day) => {
        day.cells.forEach((cell) => {
          cell.assignedCount = countOf(cell);
          cell.shortCount = Math.max(0, round1(cell.required - cell.assignedCount));
        });
        day.assignedCount = dayCountOf(day);
        day.dayShort = Math.max(0, round1(day.dayRequired - day.assignedCount));
      });
    }

    // 足りない量の合計(枠のカウント不足と、1日の合計の不足)
    function shortageScore() {
      return round1(days.reduce((n, d) => n + d.dayShort
        + d.cells.reduce((m, c) => m + c.shortCount, 0), 0));
    }

    /*
     * まず設定どおりに組んでみる。足りない日が出たら、平日を 0.5 ずつ薄くして
     * 組み直す。土日祝は薄くしない。
     * 足りない日がなくなるか、薄くしても良くならなくなったら終わり。
     */
    const relax = { applied: false, units: 0, shed: 0, days: 0, before: 0, after: 0 };

    buildDays(0);
    initState();
    runPass();

    if (store.autoRelax) {
      relax.before = shortageScore();
      let best = relax.before;
      let units = 0;
      let guard = 0;
      const maxUnits = weekdayDates.length * 4;
      while (best > 0.001 && guard < 8 && canRelaxMore()) {
        // 足りない量ぶんだけ薄くする(0.5 カウント × 個数)
        const next = Math.min(maxUnits, units + Math.max(1, Math.ceil(best / 0.5)));
        if (next === units) break;
        buildDays(next);
        initState();
        runPass();
        const score = shortageScore();
        if (score >= best) {
          buildDays(units);
          initState();
          runPass();
          break;
        }
        units = next;
        best = score;
        guard += 1;
      }
      if (units > 0) {
        relax.applied = true;
        relax.units = units;
        relax.shed = round1(units * 0.5);
        relax.days = weekdayDates.length;
        relax.after = shortageScore();
      }
    }

    // 必要量を満たしたあと、残っている出勤日数を配る
    distributeSurplus();

    // ---------------- 集計 ----------------

    const warnings = setupWarnings.slice();

    if (relax.applied) {
      const weekdayMins = openDays.filter((d) => !d.busy).map((d) => d.dayRequired);
      const lo = weekdayMins.length ? Math.min.apply(null, weekdayMins) : 0;
      const hi = weekdayMins.length ? Math.max.apply(null, weekdayMins) : 0;
      warnings.push({
        type: 'relaxed',
        message: '設定どおりだと足りない日が出るため、平日の下限を一部の日で下げて全体を回しました'
          + '(平日 ' + relax.days + '日のうち合計 ' + formatCount(relax.shed) + 'カウントぶん。'
          + '平日の下限は ' + (lo === hi ? formatCount(lo) : formatCount(lo) + '〜' + formatCount(hi)) + ')。'
          + '土日祝は下げていません。'
          + (relax.after > 0.001
            ? ' これでもまだ ' + formatCount(relax.after) + 'カウント足りない日があります。'
            : ' これで全日まかなえています。'),
      });
    }

    days.forEach((day) => {
      if (day.dayShort > 0) {
        warnings.push({
          type: 'dayShortage',
          date: day.date,
          message: day.date + '(' + day.weekdayLabel + ')' + (day.holidayName ? ' ' + day.holidayName : '')
            + ': 1日の合計が ' + formatCount(day.assignedCount) + ' / '
            + formatCount(day.dayRequired) + 'カウント(' + formatCount(day.dayShort) + '不足)',
        });
      }
      day.cells.forEach((cell) => {
        if (cell.unfilled.length || cell.shortCount > 0) {
          const byRole = {};
          const reasons = Object.assign({}, cell.shortReasons || {});
          cell.unfilled.forEach((u) => {
            byRole[u.role] = (byRole[u.role] || 0) + 1;
            Object.keys(u.reasons).forEach((k) => { reasons[k] = Math.max(reasons[k] || 0, u.reasons[k]); });
          });
          const parts = Object.keys(byRole)
            .map((r) => (r === ANY_ROLE ? '' : roleLabel(r)) + byRole[r] + '人');
          if (cell.shortCount > 0) parts.push(formatCount(cell.shortCount) + 'カウント');
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
            shortCount: cell.shortCount,
            message: day.date + '(' + day.weekdayLabel + ')' + cell.slot.name + ': ' + parts.join('、') + '不足'
              + '(' + formatCount(cell.assignedCount) + '/' + formatCount(cell.required) + 'カウント)'
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
        fixedStart: s.fixedStart,
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

    // その日の必要量は「枠ごとの合計」と「1日の下限」の大きいほう
    const requiredTotal = round1(days.reduce((n, d) => {
      const slotSum = d.cells.reduce((m, c) => m + c.required, 0);
      return n + Math.max(slotSum, d.dayRequired || 0);
    }, 0));
    const assignedTotal = round1(days.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.assignedCount, 0), 0));
    const assignedPeople = days.reduce((n, d) => n + d.cells.reduce((m, c) => m + c.assigned.length, 0), 0);

    return {
      ok: true,
      errors: [],
      store: store,
      roles: roles,
      slots: slots,
      days: days,
      staffSummary: staffSummary,
      warnings: warnings,
      relaxed: relax,
      stats: {
        openDays: openDays.length,
        closedDays: days.length - openDays.length,
        requiredTotal: requiredTotal,
        assignedTotal: assignedTotal,
        assignedPeople: assignedPeople,
        shortage: round1(Math.max(0, requiredTotal - assignedTotal)),
        fillRate: requiredTotal ? assignedTotal / requiredTotal : 1,
        targetTotal: staff.reduce((n, s) => n + s.targetDays, 0),
        dayShortDays: days.filter((d) => d.dayShort > 0).length,
      },
    };
  }

  // ---------------- CSV ----------------

  function toCsvByDate(result) {
    const rows = [['日付', '曜日', '祝日', '時間帯', '勤務開始', '勤務終了', '担当', 'スタッフ', 'レベル', '備考']];
    result.days.forEach((day) => {
      if (day.closed) {
        rows.push([day.date, day.weekdayLabel, day.holidayName, '定休日', '', '', '', '', '', '']);
        return;
      }
      day.cells.forEach((cell) => {
        cell.assigned.forEach((a) => {
          const notes = [];
          if (a.isLeader) notes.push('リーダー');
          if (cell.slot.requiresClose && a.canClose && a.coversClose) notes.push('締め');
          if (cell.slot.requiresOpen && a.canOpen && a.coversOpen) notes.push('開店');
          if (a.shortened) notes.push('時短');
          notes.push(formatCount(a.count) + 'カウント');
          rows.push([day.date, day.weekdayLabel, day.holidayName, cell.slot.name, a.start, a.end,
            a.roleLabel, a.name, a.level, notes.join('・')]);
        });
        cell.unfilled.forEach((u) => {
          rows.push([day.date, day.weekdayLabel, day.holidayName, cell.slot.name, cell.slot.start, cell.slot.end,
            u.roleLabel, '(不足)', '', '']);
        });
        if (cell.shortCount > 0) {
          rows.push([day.date, day.weekdayLabel, day.holidayName, cell.slot.name, cell.slot.start, cell.slot.end,
            '', '(カウント不足)', '', formatCount(cell.assignedCount) + '/' + formatCount(cell.required)]);
        }
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
        ? (row.startLimit || '') + '〜' + (row.endLimit || '') + (row.fixedStart && row.startLimit ? '(固定)' : '')
        : '';
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
      holidayName: day.holidayName,
      busy: day.busy,
      dayRequired: day.dayRequired,
      assignedCount: day.assignedCount,
      dayShort: day.dayShort,
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
    return {
      roles: roles,
      levelLabels: preset.levelLabels.slice(),
      slots: slots,
      dayMinCount: preset.dayMinCount === undefined ? null : preset.dayMinCount,
      dayMinCountWeekend: preset.dayMinCountWeekend === undefined ? null : preset.dayMinCountWeekend,
    };
  }

  // プリセットごとのサンプル要員
  // [名前, レベル, できる役割(index の配列), 出勤日数, 勤務できる曜日(省略で毎日),
  //  対応できる時間帯(index、省略で全部), 追加設定(時短・締め可否・公休日数 など)]
  const SAMPLE_STAFF = {
    aushop: [
      ['佐藤 店長', 5, [0, 1, 2], 0, null, null, { dayCountMode: 'holiday', holidayDays: 9 }],
      ['鈴木 副店長', 4, [0, 1, 2], 0, null, null, { dayCountMode: 'holiday', holidayDays: 9 }],
      ['高橋 (カウンター)', 4, [0, 1, 2], 0, null, null, { dayCountMode: 'holiday', holidayDays: 10 }],
      ['田中 (カウンター)', 3, [0, 1], 0, null, null, { dayCountMode: 'holiday', holidayDays: 10 }],
      ['伊藤 (カウンター)', 3, [1], 16, null, [1]],
      ['木村 (時短・カウンター)', 3, [0, 1], 18, null, null,
        { startLimit: '09:30', fixedStart: true, endLimit: '16:00', canClose: false }],
      ['渡辺 (フロア)', 2, [0], 14],
      ['中村 (事務)', 3, [0, 2], 12, [1, 2, 3, 4, 5], [0]],
      ['小林 (学生)', 1, [0], 8, [0, 6], null, { canClose: false }],
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
      dayMinCount: parts.dayMinCount,
      dayMinCountWeekend: parts.dayMinCountWeekend,
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
      fixedStart: false,
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
    holidayNameOf: holidayNameOf,
    isClosedDate: isClosedDate,
    weekdayOccurrence: weekdayOccurrence,
    isLastWeekdayOfMonth: isLastWeekdayOfMonth,
    formatCount: formatCount,
    weekdayOf: weekdayOf,
    isValidDate: isValidDate,
  };
});
