/*
 * 日本の祝日(国民の祝日・振替休日・国民の休日)の判定
 *
 * 外部 API を使わずに計算で求める(費用ゼロ・オフラインでも動く)。
 * 春分・秋分は近似式を使うため、おおむね 2000〜2099 年で正しい。
 * 法改正や特例(五輪など)には追随しないので、ずれる年は
 * 店舗設定の「繁忙日」に手で足して調整する。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ShiftHolidays = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }

  function parts(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr));
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }

  function toStr(y, m, d) {
    return y + '-' + pad2(m) + '-' + pad2(d);
  }

  function weekdayOf(dateStr) {
    const p = parts(dateStr);
    if (!p) return -1;
    return new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  }

  function shift(dateStr, n) {
    const p = parts(dateStr);
    const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
    d.setUTCDate(d.getUTCDate() + n);
    return toStr(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  // その月の n 回目の月曜日
  function nthMonday(y, m, n) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return 1 + ((8 - first) % 7) + ((n - 1) * 7);
  }

  // 春分の日・秋分の日(2000〜2099 年の近似式)
  function equinoxDay(y, spring) {
    const base = spring ? 20.8431 : 23.2488;
    return Math.floor(base + (0.242194 * (y - 1980)) - Math.floor((y - 1980) / 4));
  }

  // 国民の祝日(振替休日・国民の休日を含まない)
  function baseName(dateStr) {
    const p = parts(dateStr);
    if (!p) return '';
    const y = p.y;
    const m = p.m;
    const d = p.d;

    if (m === 1) {
      if (d === 1) return '元日';
      if (d === nthMonday(y, 1, 2)) return '成人の日';
    } else if (m === 2) {
      if (d === 11) return '建国記念の日';
      if (d === 23 && y >= 2020) return '天皇誕生日';
    } else if (m === 3) {
      if (d === equinoxDay(y, true)) return '春分の日';
    } else if (m === 4) {
      if (d === 29) return '昭和の日';
    } else if (m === 5) {
      if (d === 3) return '憲法記念日';
      if (d === 4) return 'みどりの日';
      if (d === 5) return 'こどもの日';
    } else if (m === 7) {
      if (d === nthMonday(y, 7, 3)) return '海の日';
    } else if (m === 8) {
      if (d === 11) return '山の日';
    } else if (m === 9) {
      if (d === nthMonday(y, 9, 3)) return '敬老の日';
      if (d === equinoxDay(y, false)) return '秋分の日';
    } else if (m === 10) {
      if (d === nthMonday(y, 10, 2)) return 'スポーツの日';
    } else if (m === 11) {
      if (d === 3) return '文化の日';
      if (d === 23) return '勤労感謝の日';
    } else if (m === 12) {
      if (d === 23 && y <= 2018) return '天皇誕生日';
    }
    return '';
  }

  /*
   * 祝日名を返す(祝日でなければ空文字)。
   *   1. 国民の祝日そのもの
   *   2. 振替休日 … 日曜が祝日のとき、その後の最初の平日
   *   3. 国民の休日 … 祝日にはさまれた平日
   */
  function nameOf(dateStr) {
    if (!parts(dateStr)) return '';

    const base = baseName(dateStr);
    if (base) return base;

    // 振替休日: さかのぼって祝日が続く間に日曜の祝日があれば振替
    let cur = shift(dateStr, -1);
    let guard = 0;
    while (baseName(cur) && guard < 7) {
      if (weekdayOf(cur) === 0) return '振替休日';
      cur = shift(cur, -1);
      guard += 1;
    }

    // 国民の休日: 前後が祝日で、その日が日曜でない
    if (weekdayOf(dateStr) !== 0 && baseName(shift(dateStr, -1)) && baseName(shift(dateStr, 1))) {
      return '国民の休日';
    }

    return '';
  }

  function is(dateStr) {
    return nameOf(dateStr) !== '';
  }

  return { is: is, nameOf: nameOf, baseName: baseName };
});
