// MA50/MA200 (golden/death cross) + MACD(12/26/9) + StochRSI sinyalleri — günlük kapanışlardan.
// Yeni fetch YOK; scanCoin'in futures serisinden hesaplanır (rsi.js / squeeze.js deseni).
const cfg = require('./config');
const { rsiSeries, smaOf } = require('./rsi');

const r2 = (v) => (v == null || !isFinite(v)) ? null : +v.toFixed(2);
const r6 = (v) => (v == null || !isFinite(v)) ? null : +v.toFixed(6);

// Basit hareketli ortalama serisi (closes ile aynı uzunlukta, ilk period-1 null).
function smaSeries(closes, period) {
  const n = closes.length, out = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// EMA serisi; ilk period değerin SMA'sı ile seed edilir, öncesi null.
function emaSeries(closes, period) {
  const n = closes.length, out = new Array(n).fill(null);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  out[period - 1] = seed / period;
  for (let i = period; i < n; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

// Baştaki null'ları atlayarak, ilk `period` geçerli değerin SMA'sıyla seed edilen EMA.
// (MACD çizgisi gibi başı null olan serilerin sinyal EMA'sı için.)
function emaOfSeries(series, period) {
  const n = series.length, out = new Array(n).fill(null);
  const k = 2 / (period + 1);
  let prev = null; const seed = []; let started = false;
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v == null) continue;
    if (!started) {
      seed.push(v);
      if (seed.length === period) { prev = seed.reduce((a, b) => a + b, 0) / period; out[i] = prev; started = true; }
    } else {
      prev = v * k + prev * (1 - k); out[i] = prev;
    }
  }
  return out;
}

// a serisinin b serisini kestiği en son bar: {daysAgo, dir}  dir=+1 yukarı, -1 aşağı.
function lastCross(a, b) {
  const last = a.length - 1;
  for (let i = last; i >= 1; i--) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
    const prev = a[i - 1] - b[i - 1], now = a[i] - b[i];
    if (prev <= 0 && now > 0) return { daysAgo: last - i, dir: 1 };
    if (prev >= 0 && now < 0) return { daysAgo: last - i, dir: -1 };
  }
  return null;
}

// { ma50, ma200, ma_cross_days_ago, macd, macd_signal, macd_hist, macd_cross_days_ago }
// Not: en son kesiş yönü = güncel diziliş (ma50>ma200 ⟺ son kesiş golden). Yön ayrıca saklanmaz.
function techSignals(closes) {
  const n = closes.length, last = n - 1;
  const out = {
    ma50: null, ma200: null, ma_cross_days_ago: null,
    macd: null, macd_signal: null, macd_hist: null, macd_cross_days_ago: null,
  };
  if (!n) return out;

  // ── MA50 / MA200 golden-death ──
  const maF = smaSeries(closes, cfg.MA_FAST);
  const maS = smaSeries(closes, cfg.MA_SLOW);
  out.ma50 = r2(maF[last]);
  out.ma200 = r2(maS[last]);
  if (maF[last] != null && maS[last] != null) {
    const c = lastCross(maF, maS);
    if (c) out.ma_cross_days_ago = c.daysAgo;
  }

  // ── MACD(12/26/9) ──
  const emaF = emaSeries(closes, cfg.MACD_FAST);
  const emaS = emaSeries(closes, cfg.MACD_SLOW);
  const macdLine = new Array(n).fill(null);
  for (let i = 0; i < n; i++) if (emaF[i] != null && emaS[i] != null) macdLine[i] = emaF[i] - emaS[i];
  const signalLine = emaOfSeries(macdLine, cfg.MACD_SIGNAL);
  const macd = macdLine[last], sig = signalLine[last];
  out.macd = r6(macd);
  out.macd_signal = r6(sig);
  out.macd_hist = (macd != null && sig != null) ? r6(macd - sig) : null;
  if (macd != null && sig != null) {
    const c = lastCross(macdLine, signalLine);
    if (c) out.macd_cross_days_ago = c.daysAgo;
  }

  return out;
}

// ── Stochastic RSI ──
// StochRSI = (RSI − son STOCH_LEN RSI'nın min) / (max − min) × 100.  %K=SMA(StochRSI,3), %D=SMA(%K,3).
// Döner: { k:[], d:[] } — closes ile hizalı (başta null'lar). Grafik ve anlık değer için ortak.
function stochRsiSeries(closes) {
  const n = closes.length;
  const rsi = rsiSeries(closes, cfg.STOCH_RSI_PERIOD);   // başta null, sonrası kesintisiz
  const L = cfg.STOCH_LEN;
  const stoch = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const start = i - L + 1;
    if (start < 0 || rsi[i] == null || rsi[start] == null) continue;   // yeterli RSI penceresi yok
    let mn = Infinity, mx = -Infinity;
    for (let j = start; j <= i; j++) { const v = rsi[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    const raw = mx > mn ? ((rsi[i] - mn) / (mx - mn)) * 100 : 50;   // düz pencere (nadir) → nötr 50
    stoch[i] = raw < 0 ? 0 : raw > 100 ? 100 : raw;                 // FP epsilon'u klampla
  }
  const k = smaOf(stoch, cfg.STOCH_K);
  const d = smaOf(k, cfg.STOCH_D);
  return { k, d };
}

// En son "aşırı satımda yukarı kesiş": %K, %D'yi kesiş barında %K ≤ STOCH_OS iken yukarı keser.
function lastStochOversoldCross(k, d) {
  const last = k.length - 1;
  for (let i = last; i >= 1; i--) {
    if (k[i] == null || d[i] == null || k[i - 1] == null || d[i - 1] == null) continue;
    if (k[i - 1] <= d[i - 1] && k[i] > d[i] && k[i] <= cfg.STOCH_OS) return last - i;
  }
  return null;
}

// { stoch_k, stoch_d, stoch_cross_bars_ago }  (anlık değerler + kesiş yaşı)
function stochRsi(closes) {
  const { k, d } = stochRsiSeries(closes);
  const last = closes.length - 1;
  const kL = k[last], dL = d[last];
  return {
    stoch_k: r2(kL),
    stoch_d: r2(dL),
    stoch_cross_bars_ago: (kL != null && dL != null) ? lastStochOversoldCross(k, d) : null,
  };
}

// ── SuperTrend (ATR tabanlı trend takibi) ──
// ATR(period, Wilder) → hl2 ± mult×ATR ham bantları → bantlar "kilitlenir" (trend yönünde
// daralabilir, geri açılamaz) → fiyat bandı kırınca yön döner.
// Yukarı trendde çizgi fiyatın ALTINDA (destek), aşağı trendde ÜSTÜNDE (direnç).
// Döner: { st:[], dir:[] } — closes ile hizalı, başta null (ATR ısınması).
function superTrendSeries(highs, lows, closes, period = cfg.ST_PERIOD, mult = cfg.ST_MULT) {
  const n = closes.length;
  const st = new Array(n).fill(null), dir = new Array(n).fill(null);
  if (n < period + 1) return { st, dir };

  // True Range → ATR (Wilder/RMA: ilk değer period TR'nin ortalaması, sonrası yumuşatma)
  const tr = new Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1]));
  }
  const atr = new Array(n).fill(null);
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;

  // Kilitlenen bantlar + yön
  const fUp = new Array(n).fill(null), fLo = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const bUp = hl2 + mult * atr[i], bLo = hl2 - mult * atr[i];

    if (fUp[i - 1] == null) {                       // ilk bar: seed
      fUp[i] = bUp; fLo[i] = bLo;
      dir[i] = closes[i] >= hl2 ? 1 : -1;
    } else {
      // Bant yalnız daralabilir; fiyat bandı aştıysa serbest bırakılır
      fUp[i] = (bUp < fUp[i - 1] || closes[i - 1] > fUp[i - 1]) ? bUp : fUp[i - 1];
      fLo[i] = (bLo > fLo[i - 1] || closes[i - 1] < fLo[i - 1]) ? bLo : fLo[i - 1];
      dir[i] = dir[i - 1] === -1
        ? (closes[i] > fUp[i] ? 1 : -1)             // aşağı trendde üst bandı yukarı kırdı mı
        : (closes[i] < fLo[i] ? -1 : 1);            // yukarı trendde alt bandı aşağı kırdı mı
    }
    st[i] = dir[i] === 1 ? fLo[i] : fUp[i];
  }
  return { st, dir };
}

// Anlık durum: { st, st_dir, st_bars, st_dist_pct }
//  st_bars     : güncel trendin kaç bardır sürdüğü (dönüş barı = 0)
//  st_dist_pct : fiyatın çizgiye uzaklığı (%) — dönüşe ne kadar yakın olduğunu gösterir
function superTrend(highs, lows, closes, period = cfg.ST_PERIOD, mult = cfg.ST_MULT) {
  const { st, dir } = superTrendSeries(highs, lows, closes, period, mult);
  const last = closes.length - 1;
  if (last < 0 || st[last] == null) return { st: null, st_dir: null, st_bars: null, st_dist_pct: null };

  let bars = 0;
  for (let i = last; i >= 1 && dir[i - 1] != null && dir[i] === dir[i - 1]; i--) bars++;

  return {
    st: r6(st[last]),
    st_dir: dir[last],
    st_bars: bars,
    st_dist_pct: r2(((closes[last] - st[last]) / closes[last]) * 100),
  };
}

module.exports = {
  smaSeries, emaSeries, emaOfSeries, lastCross, techSignals,
  stochRsiSeries, stochRsi, superTrendSeries, superTrend,
};
