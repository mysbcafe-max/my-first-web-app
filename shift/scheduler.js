/*
 * シフト自動生成ロジック(UI から独立した純粋な関数群)
 *
 * ブラウザでは window.ShiftScheduler として、Node では module.exports として使える。
 * 外部ライブラリ・外部 API には依存しない(費用ゼロ)。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShiftScheduler = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

  const DEFAULT_OPTIONS = {
    weightDistance: 1,      // 通勤 1km あたりの減点
    weightFairness: 20,     // 稼働率(その人の上限に対する消化率 0〜1)への減点係数
    weightPreferred: 15,    // 希望店舗への加点
    weightContinuity: 5,    // 期間内に同じ店舗へ入った経験への加点(慣れ)
    weightOverLevel: 2,     // 必要レベルを超えた分 1 段階あたりの減点(高レベル人材の温存)
    maxDistanceKm: 60,      // これを超える通勤は候補から外す(0 で無効)
    maxConsecutiveDays: 5,  // 連勤上限(0 で無効)
    defaultMaxDaysPerWeek: 5,
    improve: true,          // 同日内の入れ替え改善を行う
  };

  // 住所だけしか分からないときの距離の目安(km)
  const ESTIMATE_KM = {
    sameWard: 3,      // 同じ市の同じ区
    sameCity: 6,      // 同じ市区町村
    sameCityOtherWard: 10, // 同じ市の別の区
    tokyoWards: 12,   // 東京 23 区同士
    samePref: 30,     // 同じ都道府県
    otherPref: 50,    // 別の都道府県(隣県への通勤は現実的にあるため上限 60km 以内に収める)
    unknown: 40,      // 住所から判定できない
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

  // 週の識別子(月曜始まり: その週の月曜日の日付)
  function weekKey(str) {
    const wd = weekdayOf(str);
    return addDays(str, -((wd + 6) % 7));
  }

  // ---------------- 住所・距離 ----------------

  // 「東京都千代田区丸の内1-1」→ { pref: '東京都', city: '千代田区', ward: '' }
  // 「神奈川県横浜市西区みなとみらい」→ { pref: '神奈川県', city: '横浜市', ward: '西区' }
  function parseAddress(address) {
    const s = String(address || '').replace(/\s+/g, '');
    const pm = s.match(/^(東京都|北海道|京都府|大阪府|.{2,3}県)/);
    const pref = pm ? pm[1] : '';
    const rest = pm ? s.slice(pref.length) : s;
    let city = '';
    let ward = '';
    let m = rest.match(/^(.+?郡.+?[町村])/);
    if (m) {
      city = m[1];
    } else {
      m = rest.match(/^(.+?市)/);
      if (m) {
        city = m[1];
        const wm = rest.slice(city.length).match(/^(.+?区)/);
        if (wm) ward = wm[1];
      } else {
        m = rest.match(/^(.+?[区町村])/);
        if (m) city = m[1];
      }
    }
    return { pref, city, ward };
  }

  function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  function toNum(v) {
    if (v === '' || v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const toRad = (x) => (x * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  // 社員と店舗の距離。座標が両方あれば実距離、なければ住所から目安を出す。
  function estimateDistance(emp, store) {
    const elat = toNum(emp.lat), elng = toNum(emp.lng);
    const slat = toNum(store.lat), slng = toNum(store.lng);
    if (isNum(elat) && isNum(elng) && isNum(slat) && isNum(slng)) {
      return { km: round1(haversineKm(elat, elng, slat, slng)), method: 'coords' };
    }
    const a = parseAddress(emp.address);
    const b = parseAddress(store.address);
    if (!a.pref || !b.pref) return { km: ESTIMATE_KM.unknown, method: 'unknown' };
    if (a.pref !== b.pref) return { km: ESTIMATE_KM.otherPref, method: 'estimate' };
    if (a.city && a.city === b.city) {
      if (a.ward && b.ward) {
        return { km: a.ward === b.ward ? ESTIMATE_KM.sameWard : ESTIMATE_KM.sameCityOtherWard, method: 'estimate' };
      }
      return { km: ESTIMATE_KM.sameCity, method: 'estimate' };
    }
    if (a.pref === '東京都' && /区$/.test(a.city) && /区$/.test(b.city)) {
      return { km: ESTIMATE_KM.tokyoWards, method: 'estimate' };
    }
    return { km: ESTIMATE_KM.samePref, method: 'estimate' };
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  // ---------------- 正規化 ----------------

  const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

  function normalizeEmployee(e, opt) {
    return {
      id: String(e.id),
      name: e.name || '(名前なし)',
      address: e.address || '',
      lat: toNum(e.lat),
      lng: toNum(e.lng),
      level: clampInt(e.level, 1, 5, 1),
      maxDaysPerWeek: clampInt(e.maxDaysPerWeek, 0, 7, opt.defaultMaxDaysPerWeek),
      availableWeekdays: Array.isArray(e.availableWeekdays) && e.availableWeekdays.length
        ? e.availableWeekdays.map(Number)
        : ALL_WEEKDAYS.slice(),
      unavailableDates: Array.isArray(e.unavailableDates) ? e.unavailableDates.map(String) : [],
      ngStoreIds: Array.isArray(e.ngStoreIds) ? e.ngStoreIds.map(String) : [],
      preferredStoreIds: Array.isArray(e.preferredStoreIds) ? e.preferredStoreIds.map(String) : [],
      memo: e.memo || '',
    };
  }

  function normalizeStore(s) {
    return {
      id: String(s.id),
      name: s.name || '(店舗名なし)',
      address: s.address || '',
      lat: toNum(s.lat),
      lng: toNum(s.lng),
      requiredStaff: clampInt(s.requiredStaff, 0, 99, 1),
      minLevel: clampInt(s.minLevel, 1, 5, 1),
      leaderLevel: clampInt(s.leaderLevel, 0, 5, 0), // 0 = リーダー不要
      openWeekdays: Array.isArray(s.openWeekdays) && s.openWeekdays.length
        ? s.openWeekdays.map(Number)
        : ALL_WEEKDAYS.slice(),
      memo: s.memo || '',
    };
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  // ---------------- 生成本体 ----------------

  function newStats() {
    return { days: 0, km: 0, byWeek: {}, storeCounts: {}, dates: [], dateSet: new Set() };
  }

  // date に出勤を追加すると連勤上限を超えるか(処理順に依存しない判定)
  function exceedsConsecutive(dateSet, date, max) {
    if (!(max > 0)) return false;
    let run = 1;
    for (let d = addDays(date, -1); dateSet.has(d); d = addDays(d, -1)) run++;
    for (let d = addDays(date, 1); dateSet.has(d); d = addDays(d, 1)) run++;
    return run > max;
  }

  function generate(input) {
    const opt = Object.assign({}, DEFAULT_OPTIONS, input.options || {});
    const employees = (input.employees || []).map((e) => normalizeEmployee(e, opt));
    const stores = (input.stores || []).map(normalizeStore);
    const dates = eachDate(input.startDate, input.endDate);
    const weeks = Math.max(1, Math.ceil(dates.length / 7));

    const warnings = [];
    const stats = {};
    employees.forEach((e) => { stats[e.id] = newStats(); });

    // 距離キャッシュ
    const distCache = new Map();
    const distanceOf = (e, s) => {
      const key = e.id + '|' + s.id;
      if (!distCache.has(key)) distCache.set(key, estimateDistance(e, s));
      return distCache.get(key);
    };

    if (dates.length === 0) {
      warnings.push({ level: 'error', message: '期間が正しくありません(開始日・終了日を確認してください)。' });
    }
    if (employees.length === 0) warnings.push({ level: 'error', message: '社員が登録されていません。' });
    if (stores.length === 0) warnings.push({ level: 'error', message: '店舗が登録されていません。' });

    employees.forEach((e) => {
      if (!isNum(e.lat) && !parseAddress(e.address).pref) {
        warnings.push({ level: 'info', message: `${e.name}: 住所から都道府県を判定できないため距離は一律 ${ESTIMATE_KM.unknown}km として扱います。` });
      }
    });
    stores.forEach((s) => {
      if (!isNum(s.lat) && !parseAddress(s.address).pref) {
        warnings.push({ level: 'info', message: `${s.name}: 住所から都道府県を判定できないため距離は一律 ${ESTIMATE_KM.unknown}km として扱います。` });
      }
    });

    // ハード制約(その日の状況に依存しないもの)
    const hardOk = (e, s) => {
      if (e.ngStoreIds.includes(s.id)) return false;
      if (e.level < s.minLevel) return false;
      if (opt.maxDistanceKm > 0 && distanceOf(e, s).km > opt.maxDistanceKm) return false;
      return true;
    };

    // その日に働けるか(曜日・希望休・週上限・連勤)
    const canWorkOn = (e, date, wd) => {
      const st = stats[e.id];
      if (!e.availableWeekdays.includes(wd)) return false;
      if (e.unavailableDates.includes(date)) return false;
      if (e.maxDaysPerWeek > 0 && (st.byWeek[weekKey(date)] || 0) >= e.maxDaysPerWeek) return false;
      if (exceedsConsecutive(st.dateSet, date, opt.maxConsecutiveDays)) return false;
      return true;
    };

    const capacityOf = (e) => (e.maxDaysPerWeek > 0 ? e.maxDaysPerWeek * weeks : dates.length);

    const scoreOf = (e, s) => {
      const st = stats[e.id];
      let sc = -opt.weightDistance * distanceOf(e, s).km;
      if (e.preferredStoreIds.includes(s.id)) sc += opt.weightPreferred;
      if (st.storeCounts[s.id]) sc += opt.weightContinuity;
      const cap = capacityOf(e);
      sc -= opt.weightFairness * (cap > 0 ? st.days / cap : st.days);
      sc -= opt.weightOverLevel * Math.max(0, e.level - s.minLevel);
      return sc;
    };

    const days = [];

    // 埋めにくい日(候補者に対して必要枠が多い日)から先に処理する。
    // 日付順に埋めると平日で週上限を使い切り、候補の少ない土日が不足しやすいため。
    const demandOf = (date) => {
      const wd = weekdayOf(date);
      return stores.filter((s) => s.openWeekdays.includes(wd)).reduce((sum, s) => sum + s.requiredStaff, 0);
    };
    const supplyOf = (date) => {
      const wd = weekdayOf(date);
      return employees.filter((e) => e.availableWeekdays.includes(wd) && !e.unavailableDates.includes(date)).length;
    };
    const processOrder = dates
      .map((date) => ({ date, scarcity: supplyOf(date) === 0 ? Infinity : demandOf(date) / supplyOf(date) }))
      .sort((a, b) => b.scarcity - a.scarcity || (a.date < b.date ? -1 : 1))
      .map((x) => x.date);

    processOrder.forEach((date) => {
      const wd = weekdayOf(date);
      const openStores = stores.filter((s) => s.openWeekdays.includes(wd) && s.requiredStaff > 0);
      const assignedToday = new Set();
      const workable = employees.filter((e) => canWorkOn(e, date, wd));

      const eligibleFor = (s) => workable.filter((e) => !assignedToday.has(e.id) && hardOk(e, s));

      // 候補が少ない(埋めにくい)店舗から先に埋める
      const order = openStores
        .map((s) => ({ s, slack: eligibleFor(s).length - s.requiredStaff }))
        .sort((a, b) => a.slack - b.slack || a.s.name.localeCompare(b.s.name, 'ja'))
        .map((x) => x.s);

      const dayAssign = order.map((s) => ({ store: s, employees: [] }));

      dayAssign.forEach((slot) => {
        const s = slot.store;
        let needLeader = s.leaderLevel > 0;
        for (let i = 0; i < s.requiredStaff; i++) {
          let cands = eligibleFor(s);
          if (needLeader) {
            const leaders = cands.filter((e) => e.level >= s.leaderLevel);
            if (leaders.length) cands = leaders;
          }
          if (!cands.length) break;
          cands.sort((a, b) => scoreOf(b, s) - scoreOf(a, s) || a.name.localeCompare(b.name, 'ja'));
          const pick = cands[0];
          slot.employees.push(pick);
          assignedToday.add(pick.id);
          if (pick.level >= s.leaderLevel) needLeader = false;
        }
      });

      if (opt.improve) improveDay(dayAssign, hardOk, scoreOf);

      // 統計を更新し、出力形式に整える
      const dayOut = {
        date,
        weekday: wd,
        weekdayLabel: WEEKDAY_LABELS[wd],
        stores: [],
      };
      // 出力は元の店舗登録順に並べる
      stores.forEach((s) => {
        const slot = dayAssign.find((x) => x.store.id === s.id);
        if (!slot) return; // 定休日
        const assigned = slot.employees.map((e) => {
          const d = distanceOf(e, s);
          const st = stats[e.id];
          st.days += 1;
          st.km += d.km;
          st.byWeek[weekKey(date)] = (st.byWeek[weekKey(date)] || 0) + 1;
          st.storeCounts[s.id] = (st.storeCounts[s.id] || 0) + 1;
          st.dateSet.add(date);
          st.dates.push({ date, storeId: s.id });
          return { employeeId: e.id, name: e.name, level: e.level, km: d.km, method: d.method };
        });
        const shortage = s.requiredStaff - assigned.length;
        const leaderMissing = s.leaderLevel > 0 && assigned.length > 0 && !assigned.some((a) => a.level >= s.leaderLevel);
        if (shortage > 0) {
          warnings.push({ level: 'error', date, storeId: s.id, message: `${date}(${WEEKDAY_LABELS[wd]}) ${s.name}: ${shortage} 名不足` });
        }
        if (leaderMissing) {
          warnings.push({ level: 'warn', date, storeId: s.id, message: `${date}(${WEEKDAY_LABELS[wd]}) ${s.name}: レベル ${s.leaderLevel} 以上のリーダーが不在` });
        }
        dayOut.stores.push({ storeId: s.id, storeName: s.name, required: s.requiredStaff, assigned, shortage, leaderMissing });
      });
      days.push(dayOut);
    });

    days.sort((a, b) => (a.date < b.date ? -1 : 1));
    Object.values(stats).forEach((st) => st.dates.sort((a, b) => (a.date < b.date ? -1 : 1)));

    const employeeStats = {};
    employees.forEach((e) => {
      const st = stats[e.id];
      employeeStats[e.id] = {
        name: e.name,
        level: e.level,
        days: st.days,
        km: round1(st.km),
        storeCounts: st.storeCounts,
        dates: st.dates,
      };
      if (dates.length && st.days === 0) {
        warnings.push({ level: 'info', message: `${e.name}: 期間中のアサインが 0 日です。` });
      }
    });

    const storeStats = {};
    stores.forEach((s) => {
      let required = 0, filled = 0;
      days.forEach((d) => {
        const x = d.stores.find((y) => y.storeId === s.id);
        if (x) { required += x.required; filled += x.assigned.length; }
      });
      storeStats[s.id] = { name: s.name, required, filled };
    });

    const levelOrder = { error: 0, warn: 1, info: 2 };
    warnings.sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || String(a.date || '').localeCompare(String(b.date || '')));

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      dates,
      days,
      employeeStats,
      storeStats,
      warnings,
      options: opt,
      generatedAt: new Date().toISOString(),
    };
  }

  // 同日内で 2 店舗間の担当を入れ替えて合計スコアが上がるなら入れ替える(局所改善)
  function improveDay(dayAssign, hardOk, scoreOf) {
    const hasLeader = (slot, list) =>
      slot.store.leaderLevel === 0 || list.some((e) => e.level >= slot.store.leaderLevel);
    const EPS = 1e-6;
    for (let round = 0; round < 20; round++) {
      let improved = false;
      for (let i = 0; i < dayAssign.length; i++) {
        for (let j = i + 1; j < dayAssign.length; j++) {
          const A = dayAssign[i], B = dayAssign[j];
          for (let ai = 0; ai < A.employees.length; ai++) {
            for (let bi = 0; bi < B.employees.length; bi++) {
              const a = A.employees[ai], b = B.employees[bi];
              if (!hardOk(a, B.store) || !hardOk(b, A.store)) continue;
              const before = scoreOf(a, A.store) + scoreOf(b, B.store);
              const after = scoreOf(a, B.store) + scoreOf(b, A.store);
              if (after <= before + EPS) continue;
              const newA = A.employees.slice(); newA[ai] = b;
              const newB = B.employees.slice(); newB[bi] = a;
              // リーダー要件を悪化させない
              if (hasLeader(A, A.employees) && !hasLeader(A, newA)) continue;
              if (hasLeader(B, B.employees) && !hasLeader(B, newB)) continue;
              A.employees = newA;
              B.employees = newB;
              improved = true;
            }
          }
        }
      }
      if (!improved) break;
    }
  }

  // ---------------- 出力(CSV) ----------------

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // 1 行 = 1 アサイン の一覧形式
  function toCSV(result) {
    const rows = [['日付', '曜日', '店舗', '社員', 'レベル', '距離(km)', '距離の根拠']];
    result.days.forEach((d) => {
      d.stores.forEach((s) => {
        s.assigned.forEach((a) => {
          rows.push([d.date, d.weekdayLabel, s.storeName, a.name, a.level, a.km, methodLabel(a.method)]);
        });
        for (let i = 0; i < s.shortage; i++) {
          rows.push([d.date, d.weekdayLabel, s.storeName, '(不足)', '', '', '']);
        }
      });
    });
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  // 行 = 店舗、列 = 日付 の表形式
  function toMatrixCSV(result) {
    const storeIds = [];
    result.days.forEach((d) => d.stores.forEach((s) => { if (!storeIds.includes(s.storeId)) storeIds.push(s.storeId); }));
    const header = ['店舗'].concat(result.days.map((d) => `${d.date}(${d.weekdayLabel})`));
    const rows = [header];
    storeIds.forEach((id) => {
      const row = [result.storeStats[id] ? result.storeStats[id].name : id];
      result.days.forEach((d) => {
        const s = d.stores.find((x) => x.storeId === id);
        if (!s) { row.push('定休'); return; }
        const names = s.assigned.map((a) => a.name);
        if (s.shortage > 0) names.push(`(${s.shortage}名不足)`);
        row.push(names.join(' / '));
      });
      rows.push(row);
    });
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  function methodLabel(m) {
    return m === 'coords' ? '座標' : m === 'estimate' ? '住所から推定' : '不明(既定値)';
  }

  return {
    WEEKDAY_LABELS,
    DEFAULT_OPTIONS,
    ESTIMATE_KM,
    parseDate,
    formatDate,
    addDays,
    weekdayOf,
    eachDate,
    weekKey,
    parseAddress,
    haversineKm,
    estimateDistance,
    normalizeEmployee,
    normalizeStore,
    generate,
    toCSV,
    toMatrixCSV,
    methodLabel,
  };
});
