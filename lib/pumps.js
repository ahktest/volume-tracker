// Pump / konsolidasyon algoritmaları (handoff spec §5 — Python referansından port)
// 1d klines beklenir. Element index'leri (Binance):
//   [0]=openTime(ms) [1]=open [2]=high [3]=low [4]=close [5]=baseVol [7]=quoteVol
const cfg = require('./config');

const DAY_MS = 86400000;
const dayOf = (ts) => Math.floor(ts / DAY_MS);          // UTC gün numarası (fark hesabı için)
const isoDate = (ts) => new Date(ts).toISOString().slice(0, 10); // 'YYYY-MM-DD'

// klines -> [{ts, day, date, open, high, low, raw_low, close, qvol}]
// low, wick-clamp'lidir (bozuk listeleme/flash print'lerini gövde tabanına çeker).
function parseRows(klines) {
  return (klines || []).map(k => {
    const ts = Number(k[0]);
    const open = Number(k[1]), high = Number(k[2]), rawLow = Number(k[3]), close = Number(k[4]);
    const bodyBottom = Math.min(open, close);
    const low = (rawLow > 0 && bodyBottom > 0 && rawLow < bodyBottom * cfg.LOW_WICK_FLOOR)
      ? bodyBottom : rawLow;
    return {
      ts, day: dayOf(ts), date: isoDate(ts),
      open, high, low, raw_low: rawLow, close,
      qvol: k[7] != null ? Number(k[7]) : (k[5] != null ? Number(k[5]) : 0),
    };
  }).filter(r => Number.isFinite(r.high) && Number.isFinite(r.low));
}

const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ── detect_pumps ──────────────────────────────────────────────────────────
// >= thr'lik dip->tepe koşularını olaylar halinde döndürür.
// Her mum: trailing 'window' gün min-low'a göre high/low oranı; eşiği aşan
// mumları <= cluster_gap gün arayla kümele, olay başına max ratio.
function detectPumps(rows, window = cfg.PUMP_WINDOW, thr = cfg.PUMP_X, gap = cfg.PUMP_CLUSTER_GAP) {
  const flagged = [];
  for (let idx = 0; idx < rows.length; idx++) {
    const start = Math.max(0, idx - window);
    const seg = rows.slice(start, idx + 1).filter(r => r.low > 0);
    if (!seg.length) continue;
    let lo = seg[0], loVal = seg[0].low;
    for (const r of seg) if (r.low < loVal) { loVal = r.low; lo = r; }
    const ratio = loVal > 0 ? rows[idx].high / loVal : 0;
    if (ratio >= thr) {
      flagged.push({
        peakDay: rows[idx].day, peakDate: rows[idx].date, peakPrice: rows[idx].high,
        troughDay: lo.day, troughDate: lo.date, troughPrice: lo.low, ratio,
      });
    }
  }
  if (!flagged.length) return [];

  // <= gap gün arayla kümele; olay = küme içindeki max ratio
  const events = [];
  let cur = [flagged[0]];
  for (let i = 1; i < flagged.length; i++) {
    if (flagged[i].peakDay - cur[cur.length - 1].peakDay <= gap) cur.push(flagged[i]);
    else { events.push(bestOf(cur)); cur = [flagged[i]]; }
  }
  events.push(bestOf(cur));
  return events.map(e => {
    const duration = e.peakDay - e.troughDay;
    return {
      trough_date: e.troughDate, trough_price: e.troughPrice,
      peak_date: e.peakDate,     peak_price: e.peakPrice,
      magnitude_x: e.ratio,
      duration_days: duration,
      speed_class: duration <= cfg.SPEED_FAST_MAX ? 'GUCLU' : 'YAVAS',
    };
  });
}
function bestOf(cluster) { return cluster.reduce((a, b) => (b.ratio > a.ratio ? b : a)); }

// ── detect_consolidation ──────────────────────────────────────────────────
// En uzun trailing pencere: bugünden geriye, tüm high/low, pencere medyanının
// +-band'ı içinde kaldığı sürece uzat.
// Döner: {days, since_date, range_pct, cons_mid}
function detectConsolidation(rows, band = cfg.CONS_BAND) {
  const n = rows.length;
  if (!n) return { days: 0, since_date: null, range_pct: null, cons_mid: null };
  let best = n - 1;
  let bestMid = (rows[n - 1].high + rows[n - 1].low) / 2;
  for (let start = n - 1; start >= 0; start--) {
    const seg = rows.slice(start, n);
    const med = median(seg.map(r => (r.high + r.low) / 2));
    let hi = -Infinity, lo = Infinity;
    for (const r of seg) { if (r.high > hi) hi = r.high; if (r.low < lo) lo = r.low; }
    if (hi <= med * (1 + band) && lo >= med * (1 - band)) { best = start; bestMid = med; }
    else break;
  }
  const seg = rows.slice(best, n);
  let hi = -Infinity, lo = Infinity;
  for (const r of seg) { if (r.high > hi) hi = r.high; if (r.low < lo) lo = r.low; }
  return {
    days: rows[n - 1].day - rows[best].day,
    since_date: rows[best].date,
    range_pct: lo > 0 ? (hi / lo - 1) * 100 : null,
    cons_mid: bestMid,
  };
}

// ── metrik yardımcıları ─────────────────────────────────────────────────────
function athOf(rows) {
  if (!rows.length) return { price: null, date: null, ageDays: null };
  let top = rows[0];
  for (const r of rows) if (r.high > top.high) top = r;
  const lastDay = rows[rows.length - 1].day;
  return { price: top.high, date: top.date, ageDays: lastDay - top.day };
}

// son N günün min low'u (pencere = son N eleman)
function lowN(rows, n) {
  const seg = rows.slice(-n);
  if (!seg.length) return null;
  return seg.reduce((m, r) => Math.min(m, r.low), Infinity);
}

// N gün önceki close'a göre getiri %
function retN(rows, n) {
  if (rows.length <= n) return null;
  const now = rows[rows.length - 1].close;
  const past = rows[rows.length - 1 - n].close;
  return past > 0 ? (now / past - 1) * 100 : null;
}

// vol_base = son N günün medyan günlük quote hacmi (breakout hacim kıyası)
function volBase(rows, n = cfg.VOL_BASE_WINDOW) {
  const seg = rows.slice(-n).map(r => r.qvol).filter(v => Number.isFinite(v) && v > 0);
  return median(seg);
}

function historyDays(rows) {
  if (rows.length < 2) return rows.length ? 0 : null;
  return rows[rows.length - 1].day - rows[0].day;
}

// olay listeleme günü pump'ı mı? (trough, ilk mumdan <= LISTING_PUMP_DAYS sonra)
function markListingPumps(events, rows) {
  if (!rows.length) return events;
  const firstDay = rows[0].day;
  return events.map(e => {
    const troughDay = Math.floor(new Date(e.trough_date + 'T00:00:00Z').getTime() / DAY_MS);
    return { ...e, is_listing_pump: (troughDay - firstDay) <= cfg.LISTING_PUMP_DAYS ? 1 : 0 };
  });
}

module.exports = {
  parseRows, detectPumps, detectConsolidation,
  athOf, lowN, retN, volBase, historyDays, markListingPumps,
  median, isoDate,
};
