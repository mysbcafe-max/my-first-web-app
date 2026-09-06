/*
 * 試用(トライアル)の設定
 *
 * 店舗に試用してもらうときは、この 3 行だけ書き換える。
 *   storeName : 店舗名(案内に表示される)
 *   startDate : 試用開始日 'YYYY-MM-DD'(空なら案内を出さない)
 *   contact   : 困ったときの連絡先
 *
 * 終了日は「開始日 + months か月 の前日」で自動計算する。
 * endDate を直接書けば、そちらが優先される。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShiftTrial = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CONFIG = {
    storeName: 'au ショップ 大和店',
    startDate: '2026-09-15',   // 10月のシフト作成から使い始められるように9月中旬開始
    months: 3,                 // 試用期間(か月)→ 2026-12-14 まで
    endDate: '',               // 空なら startDate + months の前日
    // 連絡先は店舗に直接お伝え済みのため、公開ページには載せない
    contact: '',
    noticeDays: 14,     // 終了何日前から「まもなく終了」を出すか
  };

  function pad2(n) { return String(n).padStart(2, '0'); }

  function isValidDate(str) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(str));
  }

  function parse(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return { y: y, m: m, d: d };
  }

  function toUtc(str) {
    const p = parse(str);
    return Date.UTC(p.y, p.m - 1, p.d);
  }

  function format(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  // 月末の繰り上がりを防ぐ(1/31 + 1か月 = 2/28)
  function addMonths(dateStr, n) {
    const p = parse(dateStr);
    const total = (p.y * 12) + (p.m - 1) + n;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return y + '-' + pad2(m) + '-' + pad2(Math.min(p.d, lastDay));
  }

  function addDays(dateStr, n) {
    return format(toUtc(dateStr) + (n * 86400000));
  }

  function endOf(config) {
    if (isValidDate(config.endDate)) return config.endDate;
    if (!isValidDate(config.startDate)) return '';
    const months = Number(config.months) > 0 ? Number(config.months) : 3;
    return addDays(addMonths(config.startDate, months), -1);
  }

  /*
   * 試用の状態を返す。
   *   enabled : 案内を出すかどうか(開始日が未設定なら false)
   *   phase   : 'before'(開始前)/ 'active'(試用中)/ 'ending'(まもなく終了)/ 'ended'(終了)
   *   daysLeft: 終了日まで何日か(終了日当日は 0)
   */
  function status(config, todayStr) {
    const cfg = Object.assign({}, CONFIG, config || {});
    const today = isValidDate(todayStr) ? todayStr : format(Date.now());
    const start = cfg.startDate;
    const end = endOf(cfg);
    if (!isValidDate(start) || !isValidDate(end)) {
      return { enabled: false, phase: '', storeName: cfg.storeName, startDate: '', endDate: '', daysLeft: null, contact: cfg.contact, message: '' };
    }

    const daysLeft = Math.round((toUtc(end) - toUtc(today)) / 86400000);
    const noticeDays = Number(cfg.noticeDays) >= 0 ? Number(cfg.noticeDays) : 14;
    let phase;
    if (today < start) phase = 'before';
    else if (daysLeft < 0) phase = 'ended';
    else if (daysLeft <= noticeDays) phase = 'ending';
    else phase = 'active';

    const period = start.replace(/-/g, '/') + ' 〜 ' + end.replace(/-/g, '/');
    let message;
    if (phase === 'before') {
      message = '試用期間は ' + period + ' です(開始前)。';
    } else if (phase === 'ended') {
      message = '試用期間(' + period + ')は終了しました。引き続きお使いになる場合はご相談ください。';
    } else if (phase === 'ending') {
      message = '試用期間は ' + period + '。残り ' + daysLeft + ' 日です。';
    } else {
      message = '試用期間中です(' + period + '。残り ' + daysLeft + ' 日)。';
    }

    return {
      enabled: true,
      phase: phase,
      storeName: cfg.storeName,
      startDate: start,
      endDate: end,
      daysLeft: daysLeft,
      contact: cfg.contact,
      message: message,
    };
  }

  return { CONFIG: CONFIG, status: status, addMonths: addMonths, addDays: addDays, endOf: endOf };
});
