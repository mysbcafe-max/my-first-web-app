/*
 * シフト自動生成ロジック(UI から独立した純粋な関数群)
 *
 * ブラウザでは window.ShiftScheduler として、Node では module.exports として使える。
 * 外部ライブラリ・外部 API には依存しない(費用ゼロ)。
 *
 * 案件(現場)は期間つきで登録する。期間を空欄にすると常設扱い(生成期間すべて)。
 * 各案件には「平均必要レベル」を設定でき、その日に入るスタッフのレベル平均が
 * これを下回らないように調整する。
 * また、案件ごとにコアメンバーを決めてから日々を埋めるため、
 * 同じ案件には同じ顔ぶれが入りやすい。
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
  const ALL_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

  const DEFAULT_OPTIONS = {
    weightDistance: 1,      // 通勤 1km あたりの減点
    weightFairness: 20,     // 稼働率(その人の上限に対する消化率 0〜1)への減点係数
    weightPreferred: 15,    // 希望案件への加点
    weightContinuity: 30,   // 同じ案件に入った実績への加点(顔ぶれを固定する力)
    weightCore: 60,         // その案件のコアメンバーへの加点
    weightCoverage: 40,     // コア選定時、案件期間をどれだけ担当できるかへの加点(顔ぶれ固定の要)
    weightOverLevel: 3,     // 必要レベルを超えた分 1 段階あたりの減点(高レベル人材を要求の高い案件に温存)
    maxDistanceKm: 60,      // これを超える通勤は候補から外す(0 で無効)
    maxConsecutiveDays: 5,  // 連勤上限(0 で無効)
    defaultMaxDaysPerWeek: 5,
    improve: true,          // 同日内の入れ替え改善を行う
    repair: true,           // 空き枠を連鎖的な入れ替えで埋める修復パスを行う
  };

  // 住所だけしか分からないときの距離の目安(km)
  const ESTIMATE_KM = {
    sameWard: 3,           // 同じ市の同じ区
    sameCity: 6,           // 同じ市区町村
    sameCityOtherWard: 10, // 同じ市の別の区
    tokyoWards: 12,        // 東京 23 区同士
    samePref: 30,          // 同じ都道府県
    otherPref: 50,         // 別の都道府県
    unknown: 40,           // 住所から判定できない
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

  // 社員と現場の距離。座標が両方あれば実距離、なければ住所から目安を出す。
  function estimateDistance(emp, site) {
    const elat = toNum(emp.lat), elng = toNum(emp.lng);
    const slat = toNum(site.lat), slng = toNum(site.lng);
    if (isNum(elat) && isNum(elng) && isNum(slat) && isNum(slng)) {
      return { km: round1(haversineKm(elat, elng, slat, slng)), method: 'coords' };
    }
    const a = parseAddress(emp.address);
    const b = parseAddress(site.address);
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

  function round2(n) {
    return Math.round(n * 100) / 100;
  }

  // ---------------- 正規化 ----------------

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function clampFloat(v, min, max, dflt) {
    const n = parseFloat(v);
    if (Number.isNaN(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function dateOrEmpty(v) {
    return isValidDate(v) ? String(v) : '';
  }

  function normalizeEmployee(e, opt) {
    const o = opt || DEFAULT_OPTIONS;
    return {
      id: String(e.id),
      name: e.name || '(名前なし)',
      address: e.address || '',
      lat: toNum(e.lat),
      lng: toNum(e.lng),
      level: clampInt(e.level, 1, 5, 1),
      maxDaysPerWeek: clampInt(e.maxDaysPerWeek, 0, 7, o.defaultMaxDaysPerWeek),
      availableWeekdays: Array.isArray(e.availableWeekdays) && e.availableWeekdays.length
        ? e.availableWeekdays.map(Number)
        : ALL_WEEKDAYS.slice(),
      unavailableDates: Array.isArray(e.unavailableDates) ? e.unavailableDates.map(String) : [],
      // 旧名(ngStoreIds / preferredStoreIds)も受け付ける
      ngProjectIds: idList(e.ngProjectIds, e.ngStoreIds),
      preferredProjectIds: idList(e.preferredProjectIds, e.preferredStoreIds),
      memo: e.memo || '',
    };
  }

  function idList(a, b) {
    const src = Array.isArray(a) ? a : Array.isArray(b) ? b : [];
    return src.map(String);
  }

  function normalizeProject(p) {
    return {
      id: String(p.id),
      name: p.name || '(案件名なし)',
      address: p.address || '',
      lat: toNum(p.lat),
      lng: toNum(p.lng),
      startDate: dateOrEmpty(p.startDate),
      endDate: dateOrEmpty(p.endDate),
      requiredStaff: clampInt(p.requiredStaff, 0, 99, 1),
      requiredAvgLevel: clampFloat(p.requiredAvgLevel, 0, 5, 0), // 0 = 不問
      minLevel: clampInt(p.minLevel, 1, 5, 1),
      leaderLevel: clampInt(p.leaderLevel, 0, 5, 0),             // 0 = リーダー不要
      openWeekdays: Array.isArray(p.openWeekdays) && p.openWeekdays.length
        ? p.openWeekdays.map(Number)
        : ALL_WEEKDAYS.slice(),
      memo: p.memo || '',
    };
  }

  // 登録済みの案件から、生成期間の候補(最も早い開始日〜最も遅い終了日)を出す
  function suggestPeriod(projects) {
    const starts = [], ends = [];
    (projects || []).forEach((p) => {
      if (isValidDate(p.startDate)) starts.push(p.startDate);
      if (isValidDate(p.endDate)) ends.push(p.endDate);
    });
    if (!starts.length || !ends.length) return null;
    return { startDate: starts.sort()[0], endDate: ends.sort()[ends.length - 1] };
  }

  function avgLevel(list) {
    if (!list.length) return 0;
    return list.reduce((a, e) => a + e.level, 0) / list.length;
  }

  // ---------------- 生成本体 ----------------

  function newStats() {
    return { days: 0, km: 0, byWeek: {}, projectCounts: {}, dates: [], dateSet: new Set() };
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
    const projects = (input.projects || input.stores || []).map(normalizeProject);
    const dates = eachDate(input.startDate, input.endDate);

    const warnings = [];
    const stats = {};
    employees.forEach((e) => { stats[e.id] = newStats(); });

    const projectById = new Map(projects.map((p) => [p.id, p]));
    const distCache = new Map();
    const distanceOf = (e, p) => {
      const key = e.id + '|' + p.id;
      if (!distCache.has(key)) distCache.set(key, estimateDistance(e, p));
      return distCache.get(key);
    };

    if (dates.length === 0) {
      warnings.push({ level: 'error', message: '期間が正しくありません(開始日・終了日を確認してください)。' });
    }
    if (employees.length === 0) warnings.push({ level: 'error', message: 'スタッフが登録されていません。' });
    if (projects.length === 0) warnings.push({ level: 'error', message: '案件が登録されていません。' });

    employees.forEach((e) => {
      if (!isNum(e.lat) && !parseAddress(e.address).pref) {
        warnings.push({ level: 'info', message: `${e.name}: 住所から都道府県を判定できないため距離は一律 ${ESTIMATE_KM.unknown}km として扱います。` });
      }
    });
    projects.forEach((p) => {
      if (!isNum(p.lat) && !parseAddress(p.address).pref) {
        warnings.push({ level: 'info', message: `${p.name}: 現場の住所から都道府県を判定できないため距離は一律 ${ESTIMATE_KM.unknown}km として扱います。` });
      }
    });

    // ---- 各案件の稼働日 ----
    const activeDates = new Map();
    projects.forEach((p) => {
      const list = dates.filter((d) =>
        p.openWeekdays.includes(weekdayOf(d)) &&
        (!p.startDate || d >= p.startDate) &&
        (!p.endDate || d <= p.endDate));
      activeDates.set(p.id, list);
      if (p.requiredStaff > 0 && list.length === 0 && dates.length) {
        warnings.push({ level: 'info', projectId: p.id, message: `${p.name}: 生成期間に稼働日がありません(案件の期間・稼働曜日を確認してください)。` });
      }
      if (p.startDate && p.endDate && p.startDate > p.endDate) {
        warnings.push({ level: 'error', projectId: p.id, message: `${p.name}: 案件の終了日が開始日より前になっています。` });
      }
    });
    const activeSet = new Map(projects.map((p) => [p.id, new Set(activeDates.get(p.id))]));
    const isActive = (p, date) => activeSet.get(p.id).has(date);

    // ---- ハード制約 ----
    const hardOk = (e, p) => {
      if (e.ngProjectIds.includes(p.id)) return false;
      if (e.level < p.minLevel) return false;
      if (opt.maxDistanceKm > 0 && distanceOf(e, p).km > opt.maxDistanceKm) return false;
      return true;
    };

    const canWorkOn = (e, date) => {
      const st = stats[e.id];
      if (!e.availableWeekdays.includes(weekdayOf(date))) return false;
      if (e.unavailableDates.includes(date)) return false;
      if (e.maxDaysPerWeek > 0 && (st.byWeek[weekKey(date)] || 0) >= e.maxDaysPerWeek) return false;
      if (exceedsConsecutive(st.dateSet, date, opt.maxConsecutiveDays)) return false;
      return true;
    };

    // 週上限・連勤を見ない「その日そもそも働けるか」
    const availableOn = (e, date) =>
      e.availableWeekdays.includes(weekdayOf(date)) && !e.unavailableDates.includes(date);

    const weeks = Math.max(1, Math.ceil(dates.length / 7));
    const capacityOf = (e) => (e.maxDaysPerWeek > 0 ? e.maxDaysPerWeek * weeks : dates.length);

    // ---- コアメンバーの選定(顔ぶれを固定するための土台) ----
    const core = new Map(projects.map((p) => [p.id, []]));
    const coreOf = new Map(); // 社員ID → 参加中の案件ID配列
    const isCore = (e, p) => core.get(p.id).some((x) => x.id === e.id);

    function overlaps(pid1, pid2) {
      const a = activeSet.get(pid1), b = activeDates.get(pid2);
      return b.some((d) => a.has(d));
    }

    // コアとして先取りした日数(社員ID → 週 → 日数)
    const coreCommit = new Map();

    // 案件期間のうち実際に何割を担当できるか。
    // 曜日・希望休だけでなく、他案件のコアとして週上限をどれだけ使うかも見る。
    // (これを見ないと「日付は重ならないが同じ週で上限に達する」案件に同じ人を選んでしまう)
    function coverage(e, p) {
      const list = activeDates.get(p.id);
      if (!list.length) return 0;
      const byWeek = {};
      list.forEach((d) => {
        if (availableOn(e, d)) byWeek[weekKey(d)] = (byWeek[weekKey(d)] || 0) + 1;
      });
      const used = coreCommit.get(e.id) || {};
      const cap = e.maxDaysPerWeek > 0 ? e.maxDaysPerWeek : Infinity;
      let eff = 0;
      Object.keys(byWeek).forEach((wk) => {
        eff += Math.min(byWeek[wk], Math.max(0, cap - (used[wk] || 0)));
      });
      return eff / list.length;
    }

    // コアに確定した分だけ、その人の週の空きを減らす
    function commitCore(e, p) {
      if (!coreCommit.has(e.id)) coreCommit.set(e.id, {});
      const used = coreCommit.get(e.id);
      const cap = e.maxDaysPerWeek > 0 ? e.maxDaysPerWeek : Infinity;
      const add = {};
      activeDates.get(p.id).forEach((d) => {
        if (availableOn(e, d)) add[weekKey(d)] = (add[weekKey(d)] || 0) + 1;
      });
      Object.keys(add).forEach((wk) => {
        used[wk] = Math.min(cap, (used[wk] || 0) + add[wk]);
      });
    }

    function coreScore(e, p) {
      let sc = -opt.weightDistance * distanceOf(e, p).km;
      sc += opt.weightCoverage * coverage(e, p);
      if (e.preferredProjectIds.includes(p.id)) sc += opt.weightPreferred;
      const cap = capacityOf(e);
      const load = (coreOf.get(e.id) || []).reduce((a, pid) => a + activeDates.get(pid).length, 0);
      sc -= opt.weightFairness * (cap > 0 ? load / cap : load);
      sc -= opt.weightOverLevel * Math.max(0, e.level - Math.max(p.minLevel, Math.ceil(p.requiredAvgLevel)));
      return sc;
    }

    function pickCoreTeams() {
      const order = projects
        .filter((p) => p.requiredStaff > 0 && activeDates.get(p.id).length > 0)
        .map((p) => ({ p, slack: employees.filter((e) => hardOk(e, p)).length - p.requiredStaff }))
        .sort((a, b) => a.slack - b.slack ||
          (activeDates.get(a.p.id)[0] < activeDates.get(b.p.id)[0] ? -1 : 1))
        .map((x) => x.p);

      order.forEach((p) => {
        const taken = [];
        const free = () => employees.filter((e) =>
          hardOk(e, p) &&
          !taken.some((x) => x.id === e.id) &&
          coverage(e, p) > 0 &&
          // 期間が重なる案件のコアには入れない(同じ日に 2 現場は不可のため)
          !(coreOf.get(e.id) || []).some((pid) => overlaps(p.id, pid)));

        // 「できる限り顔ぶれを変えない」ため、期間を通して入れる人(coverage 1.0)を優先する。
        // 全期間入れる人が足りないときだけ、部分的にしか入れない人を候補に含める。
        const preferFull = (list) => {
          const full = list.filter((e) => coverage(e, p) >= 1 - 1e-9);
          return full.length ? full : list;
        };

        for (let i = 0; i < p.requiredStaff; i++) {
          const cands = preferFull(free());
          if (!cands.length) break;
          cands.sort((a, b) => coreScore(b, p) - coreScore(a, p) || a.name.localeCompare(b.name, 'ja'));
          taken.push(cands[0]);
        }

        // 平均必要レベルを満たすよう、低い人を高い人と入れ替える
        if (p.requiredAvgLevel > 0) {
          let guard = taken.length * 3;
          while (taken.length && avgLevel(taken) < p.requiredAvgLevel - 1e-9 && guard-- > 0) {
            let lowIdx = 0;
            taken.forEach((e, i) => { if (e.level < taken[lowIdx].level) lowIdx = i; });
            const up = preferFull(free().filter((e) => e.level > taken[lowIdx].level));
            if (!up.length) break;
            // レベルだけで選ぶと期間の一部しか入れない人を引き込みやすいので、
            // 条件を満たす中では担当できる割合(coverage)を含むスコアで選ぶ
            up.sort((a, b) => coreScore(b, p) - coreScore(a, p) || b.level - a.level || a.name.localeCompare(b.name, 'ja'));
            taken[lowIdx] = up[0];
          }
        }

        // リーダー要件を満たす人を 1 名は入れる
        if (p.leaderLevel > 0 && taken.length && !taken.some((e) => e.level >= p.leaderLevel)) {
          const leaders = preferFull(free().filter((e) => e.level >= p.leaderLevel));
          if (leaders.length) {
            leaders.sort((a, b) => coreScore(b, p) - coreScore(a, p) || a.name.localeCompare(b.name, 'ja'));
            let lowIdx = 0;
            taken.forEach((e, i) => { if (e.level < taken[lowIdx].level) lowIdx = i; });
            taken[lowIdx] = leaders[0];
          }
        }

        core.set(p.id, taken);
        taken.forEach((e) => {
          if (!coreOf.has(e.id)) coreOf.set(e.id, []);
          coreOf.get(e.id).push(p.id);
          commitCore(e, p);
        });
      });
    }

    pickCoreTeams();

    // ---- 日ごとの割り当て ----
    const assignMap = new Map(); // `日付|案件ID` → 社員の配列
    const slotKey = (date, pid) => date + '|' + pid;
    const slotOf = (date, pid) => assignMap.get(slotKey(date, pid)) || [];

    function addAssign(e, p, date) {
      const key = slotKey(date, p.id);
      const list = assignMap.get(key) || [];
      list.push(e);
      assignMap.set(key, list);
      const st = stats[e.id];
      st.days += 1;
      st.km += distanceOf(e, p).km;
      st.byWeek[weekKey(date)] = (st.byWeek[weekKey(date)] || 0) + 1;
      st.projectCounts[p.id] = (st.projectCounts[p.id] || 0) + 1;
      st.dateSet.add(date);
      st.dates.push({ date, projectId: p.id });
    }

    function removeAssign(e, p, date) {
      const key = slotKey(date, p.id);
      const list = assignMap.get(key) || [];
      const i = list.findIndex((x) => x.id === e.id);
      if (i < 0) return;
      list.splice(i, 1);
      const st = stats[e.id];
      st.days -= 1;
      st.km = round1(st.km - distanceOf(e, p).km);
      st.byWeek[weekKey(date)] -= 1;
      st.projectCounts[p.id] -= 1;
      if (!st.projectCounts[p.id]) delete st.projectCounts[p.id];
      st.dateSet.delete(date);
      st.dates = st.dates.filter((x) => !(x.date === date && x.projectId === p.id));
    }

    // 日々の候補順を決めるスコア(コア・継続実績を強く優先する)
    const scoreOf = (e, p) => {
      const st = stats[e.id];
      let sc = -opt.weightDistance * distanceOf(e, p).km;
      if (isCore(e, p)) sc += opt.weightCore;
      if (st.projectCounts[p.id]) sc += opt.weightContinuity;
      if (e.preferredProjectIds.includes(p.id)) sc += opt.weightPreferred;
      const cap = capacityOf(e);
      sc -= opt.weightFairness * (cap > 0 ? st.days / cap : st.days);
      sc -= opt.weightOverLevel * Math.max(0, e.level - Math.max(p.minLevel, Math.ceil(p.requiredAvgLevel)));
      return sc;
    };

    dates.forEach((date) => {
      const active = projects.filter((p) => p.requiredStaff > 0 && isActive(p, date));
      const assignedToday = new Set();

      const eligible = (p, exclude) => employees.filter((e) =>
        !assignedToday.has(e.id) &&
        !(exclude || []).some((x) => x.id === e.id) &&
        hardOk(e, p) && canWorkOn(e, date));

      // 候補が少ない(埋めにくい)案件から先に埋める
      const order = active
        .map((p) => ({ p, slack: eligible(p).length - p.requiredStaff }))
        .sort((a, b) => a.slack - b.slack || a.p.name.localeCompare(b.p.name, 'ja'))
        .map((x) => x.p);

      const dayAssign = order.map((p) => ({ project: p, employees: [] }));

      dayAssign.forEach((slot) => {
        const p = slot.project;
        const picked = slot.employees;

        // 1) コアメンバーのうち、その日働ける人
        core.get(p.id).forEach((e) => {
          if (picked.length >= p.requiredStaff) return;
          if (assignedToday.has(e.id)) return;
          if (!canWorkOn(e, date)) return;
          picked.push(e);
          assignedToday.add(e.id);
        });

        // 2) 足りない分は交代要員で埋める(この案件の経験者を優先)
        let needLeader = p.leaderLevel > 0 && !picked.some((e) => e.level >= p.leaderLevel);
        while (picked.length < p.requiredStaff) {
          let cands = eligible(p, picked);
          if (needLeader) {
            const leaders = cands.filter((e) => e.level >= p.leaderLevel);
            if (leaders.length) cands = leaders;
          }
          if (!cands.length) break;
          cands.sort((a, b) => scoreOf(b, p) - scoreOf(a, p) || a.name.localeCompare(b.name, 'ja'));
          picked.push(cands[0]);
          assignedToday.add(cands[0].id);
          if (cands[0].level >= p.leaderLevel) needLeader = false;
        }

        // 3) 平均必要レベルを満たすよう入れ替える
        fixAverage(picked, p, date, assignedToday, eligible);
      });

      if (opt.improve) improveDay(dayAssign, date);

      dayAssign.forEach((slot) => slot.employees.forEach((e) => addAssign(e, slot.project, date)));
    });

    // 平均レベルが足りない場合、低い人を高い人と入れ替える(その日の未割り当て者から)
    function fixAverage(picked, p, date, assignedToday, eligible) {
      if (!(p.requiredAvgLevel > 0) || !picked.length) return;
      let guard = picked.length * 3;
      while (avgLevel(picked) < p.requiredAvgLevel - 1e-9 && guard-- > 0) {
        // 一番レベルが低い人(同レベルならコア以外)を入れ替え対象にする
        let lowIdx = 0;
        picked.forEach((e, i) => {
          const cur = picked[lowIdx];
          if (e.level < cur.level || (e.level === cur.level && isCore(cur, p) && !isCore(e, p))) lowIdx = i;
        });
        const low = picked[lowIdx];
        // リーダーを外してしまわない
        const leaderLost = p.leaderLevel > 0 &&
          low.level >= p.leaderLevel &&
          !picked.some((e, i) => i !== lowIdx && e.level >= p.leaderLevel);
        const up = eligible(p, picked).filter((e) => e.level > low.level && (!leaderLost || e.level >= p.leaderLevel));
        if (!up.length) break;
        up.sort((a, b) => b.level - a.level || scoreOf(b, p) - scoreOf(a, p) || a.name.localeCompare(b.name, 'ja'));
        assignedToday.delete(low.id);
        assignedToday.add(up[0].id);
        picked[lowIdx] = up[0];
      }
    }

    // 同日内で 2 案件間の担当を入れ替えて合計スコアが上がるなら入れ替える(局所改善)。
    // コアメンバーは動かさない(顔ぶれを固定するため)。
    function improveDay(dayAssign, date) {
      const EPS = 1e-6;
      const avgOk = (p, list) => !(p.requiredAvgLevel > 0) || !list.length || avgLevel(list) >= p.requiredAvgLevel - 1e-9;
      const leaderOkNow = (p, list) => p.leaderLevel === 0 || !list.length || list.some((e) => e.level >= p.leaderLevel);
      for (let round = 0; round < 20; round++) {
        let improved = false;
        for (let i = 0; i < dayAssign.length; i++) {
          for (let j = i + 1; j < dayAssign.length; j++) {
            const A = dayAssign[i], B = dayAssign[j];
            for (let ai = 0; ai < A.employees.length; ai++) {
              for (let bi = 0; bi < B.employees.length; bi++) {
                const a = A.employees[ai], b = B.employees[bi];
                if (isCore(a, A.project) || isCore(b, B.project)) continue;
                if (!hardOk(a, B.project) || !hardOk(b, A.project)) continue;
                const before = scoreOf(a, A.project) + scoreOf(b, B.project);
                const after = scoreOf(a, B.project) + scoreOf(b, A.project);
                if (after <= before + EPS) continue;
                const newA = A.employees.slice(); newA[ai] = b;
                const newB = B.employees.slice(); newB[bi] = a;
                // 平均レベル・リーダー要件を悪化させない
                if (avgOk(A.project, A.employees) && !avgOk(A.project, newA)) continue;
                if (avgOk(B.project, B.employees) && !avgOk(B.project, newB)) continue;
                if (leaderOkNow(A.project, A.employees) && !leaderOkNow(A.project, newA)) continue;
                if (leaderOkNow(B.project, B.employees) && !leaderOkNow(B.project, newB)) continue;
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

    // ---- 修復パス ----
    // 1 日ずつ埋めると「週上限を使い切った人しか候補がいない」空き枠が残る。
    // 空き枠に対して、他の人に別の日を肩代わりしてもらう連鎖(増加路)を探して埋める。
    if (opt.repair) {
      dates.forEach((date) => {
        projects.forEach((p) => {
          if (!isActive(p, date) || p.requiredStaff <= 0) return;
          let guard = p.requiredStaff;
          while (slotOf(date, p.id).length < p.requiredStaff && guard-- > 0) {
            if (!tryFill(p, date, new Set(), 0)) break;
          }
        });
      });
    }

    function canPlace(e, p, date) {
      if (!hardOk(e, p)) return false;
      if (!availableOn(e, date)) return false;
      return !stats[e.id].dateSet.has(date);
    }

    function hasWeekRoom(e, date) {
      if (!(e.maxDaysPerWeek > 0)) return true;
      return (stats[e.id].byWeek[weekKey(date)] || 0) < e.maxDaysPerWeek;
    }

    function leaderOk(p, list) {
      return p.leaderLevel === 0 || list.length === 0 || list.some((e) => e.level >= p.leaderLevel);
    }

    function tryFill(p, date, visited, depth) {
      if (depth > 3) return false;
      const room = employees.filter((e) => !visited.has(e.id) && canPlace(e, p, date));

      const direct = room
        .filter((e) => hasWeekRoom(e, date) && !exceedsConsecutive(stats[e.id].dateSet, date, opt.maxConsecutiveDays))
        .sort((a, b) => scoreOf(b, p) - scoreOf(a, p) || a.name.localeCompare(b.name, 'ja'));
      if (direct.length) {
        addAssign(direct[0], p, date);
        return true;
      }

      for (const e of room) {
        visited.add(e.id);
        const wk = weekKey(date);
        const freeable = stats[e.id].dates.filter((x) => x.date !== date && weekKey(x.date) === wk);
        for (const x of freeable) {
          const p3 = projectById.get(x.projectId);
          if (!p3) continue;
          const before3 = slotOf(x.date, p3.id).slice();
          removeAssign(e, p3, x.date);
          const canMove =
            !exceedsConsecutive(stats[e.id].dateSet, date, opt.maxConsecutiveDays) &&
            tryFill(p3, x.date, visited, depth + 1);
          if (canMove && (leaderOk(p3, slotOf(x.date, p3.id)) || !leaderOk(p3, before3))) {
            addAssign(e, p, date);
            return true;
          }
          if (canMove) {
            const now = slotOf(x.date, p3.id);
            const added = now.find((y) => !before3.some((z) => z.id === y.id));
            if (added) removeAssign(added, p3, x.date);
          }
          addAssign(e, p3, x.date);
        }
      }
      return false;
    }

    // ---- 最終の平均レベル調整 ----
    // 修復パスで人が増えた結果、平均が下がっている場合に入れ替えて戻す。
    dates.forEach((date) => {
      projects.forEach((p) => {
        if (!isActive(p, date) || !(p.requiredAvgLevel > 0)) return;
        const list = slotOf(date, p.id);
        if (!list.length) return;
        let guard = list.length * 3;
        while (avgLevel(list) < p.requiredAvgLevel - 1e-9 && guard-- > 0) {
          let lowIdx = 0;
          list.forEach((e, i) => { if (e.level < list[lowIdx].level) lowIdx = i; });
          const low = list[lowIdx];
          const up = employees.filter((e) =>
            e.level > low.level && canPlace(e, p, date) && hasWeekRoom(e, date) &&
            !exceedsConsecutive(stats[e.id].dateSet, date, opt.maxConsecutiveDays) &&
            (p.leaderLevel === 0 || e.level >= p.leaderLevel ||
              list.some((x, i) => i !== lowIdx && x.level >= p.leaderLevel)));
          if (!up.length) break;
          up.sort((a, b) => b.level - a.level || scoreOf(b, p) - scoreOf(a, p) || a.name.localeCompare(b.name, 'ja'));
          removeAssign(low, p, date);
          addAssign(up[0], p, date);
        }
      });
    });

    // ---- 出力の組み立て ----
    const days = dates.map((date) => {
      const wd = weekdayOf(date);
      const dayOut = { date, weekday: wd, weekdayLabel: WEEKDAY_LABELS[wd], projects: [] };
      projects.forEach((p) => {
        if (!isActive(p, date) || p.requiredStaff <= 0) return; // 期間外・稼働日外
        const assigned = slotOf(date, p.id)
          .slice()
          .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name, 'ja'))
          .map((e) => {
            const d = distanceOf(e, p);
            return { employeeId: e.id, name: e.name, level: e.level, km: d.km, method: d.method, core: isCore(e, p) };
          });
        const shortage = p.requiredStaff - assigned.length;
        const avg = assigned.length ? round2(avgLevel(assigned)) : 0;
        const avgShort = p.requiredAvgLevel > 0 && assigned.length > 0 && avg < p.requiredAvgLevel - 1e-9;
        const leaderMissing = p.leaderLevel > 0 && assigned.length > 0 && !assigned.some((a) => a.level >= p.leaderLevel);
        if (shortage > 0) {
          warnings.push({ level: 'error', date, projectId: p.id, message: `${date}(${WEEKDAY_LABELS[wd]}) ${p.name}: ${shortage} 名不足` });
        }
        if (avgShort) {
          warnings.push({ level: 'error', date, projectId: p.id, message: `${date}(${WEEKDAY_LABELS[wd]}) ${p.name}: 平均レベルが ${avg}(必要 ${p.requiredAvgLevel})` });
        }
        if (leaderMissing) {
          warnings.push({ level: 'warn', date, projectId: p.id, message: `${date}(${WEEKDAY_LABELS[wd]}) ${p.name}: レベル ${p.leaderLevel} 以上のリーダーが不在` });
        }
        dayOut.projects.push({
          projectId: p.id, projectName: p.name, required: p.requiredStaff,
          requiredAvgLevel: p.requiredAvgLevel, avgLevel: avg,
          assigned, shortage, avgShort, leaderMissing,
        });
      });
      return dayOut;
    });

    Object.values(stats).forEach((st) => st.dates.sort((a, b) => (a.date < b.date ? -1 : 1)));

    const employeeStats = {};
    employees.forEach((e) => {
      const st = stats[e.id];
      employeeStats[e.id] = {
        name: e.name,
        level: e.level,
        days: st.days,
        km: round1(st.km),
        projectCounts: st.projectCounts,
        dates: st.dates,
      };
      if (dates.length && st.days === 0) {
        warnings.push({ level: 'info', message: `${e.name}: 期間中のアサインが 0 日です。` });
      }
    });

    const projectStats = {};
    projects.forEach((p) => {
      const list = activeDates.get(p.id);
      let required = 0, filled = 0, levelSum = 0;
      const members = new Map();
      list.forEach((date) => {
        required += p.requiredStaff;
        slotOf(date, p.id).forEach((e) => {
          filled += 1;
          levelSum += e.level;
          members.set(e.id, (members.get(e.id) || 0) + 1);
        });
      });
      // 継続性: 必要人数に対して実際に何人が関わったか(1.0 = 完全に固定)
      const distinct = members.size;
      const continuity = distinct > 0 ? Math.min(1, p.requiredStaff / distinct) : 1;
      projectStats[p.id] = {
        name: p.name,
        startDate: p.startDate,
        endDate: p.endDate,
        activeDays: list.length,
        required,
        filled,
        avgLevel: filled ? round2(levelSum / filled) : 0,
        requiredAvgLevel: p.requiredAvgLevel,
        distinctStaff: distinct,
        continuity: round2(continuity),
        coreMembers: core.get(p.id).map((e) => ({ employeeId: e.id, name: e.name, level: e.level })),
        members: Array.from(members.entries()).map(([id, n]) => ({ employeeId: id, days: n })),
      };
      if (list.length && distinct > p.requiredStaff) {
        warnings.push({
          level: 'info', projectId: p.id,
          message: `${p.name}: ${p.requiredStaff} 名の枠に ${distinct} 名が入りました(希望休・週上限のため交代が発生)。`,
        });
      }
    });

    const levelOrder = { error: 0, warn: 1, info: 2 };
    warnings.sort((a, b) => levelOrder[a.level] - levelOrder[b.level] || String(a.date || '').localeCompare(String(b.date || '')));

    return {
      startDate: input.startDate,
      endDate: input.endDate,
      dates,
      days,
      employeeStats,
      projectStats,
      warnings,
      options: opt,
      generatedAt: new Date().toISOString(),
    };
  }

  // ---------------- 出力(CSV) ----------------

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // 1 行 = 1 アサイン の一覧形式
  function toCSV(result) {
    const rows = [['日付', '曜日', '案件', 'スタッフ', 'レベル', 'コア', '距離(km)', '距離の根拠']];
    result.days.forEach((d) => {
      d.projects.forEach((p) => {
        p.assigned.forEach((a) => {
          rows.push([d.date, d.weekdayLabel, p.projectName, a.name, a.level, a.core ? 'コア' : '交代', a.km, methodLabel(a.method)]);
        });
        for (let i = 0; i < p.shortage; i++) {
          rows.push([d.date, d.weekdayLabel, p.projectName, '(不足)', '', '', '', '']);
        }
      });
    });
    return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }

  // 行 = 案件、列 = 日付 の表形式
  function toMatrixCSV(result) {
    const ids = [];
    result.days.forEach((d) => d.projects.forEach((p) => { if (!ids.includes(p.projectId)) ids.push(p.projectId); }));
    const header = ['案件'].concat(result.days.map((d) => `${d.date}(${d.weekdayLabel})`));
    const rows = [header];
    ids.forEach((id) => {
      const row = [result.projectStats[id] ? result.projectStats[id].name : id];
      result.days.forEach((d) => {
        const p = d.projects.find((x) => x.projectId === id);
        if (!p) { row.push('—'); return; }
        const names = p.assigned.map((a) => a.name);
        if (p.shortage > 0) names.push(`(${p.shortage}名不足)`);
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
    isValidDate,
    eachDate,
    weekKey,
    parseAddress,
    haversineKm,
    estimateDistance,
    normalizeEmployee,
    normalizeProject,
    suggestPeriod,
    avgLevel,
    generate,
    toCSV,
    toMatrixCSV,
    methodLabel,
  };
});
