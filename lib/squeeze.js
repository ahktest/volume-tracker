// Hacim kuruması + volatilite sıkışması metrikleri (STORE katmanı ek adımı).
// Girdi: parseRows(futRows) — {close, qvol, day} içeren futures serisi.
// Yeni fetch YOK; scanCoin'in zaten belleğe aldığı futures serisinden hesaplanır.
const cfg = require('./config');

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Bollinger Band Width = (üst bant − alt bant) / SMA = 4*std / SMA  (kapanışlarla)
function bbwSeries(close, period) {
  const out = [];
  for (let i = period - 1; i < close.length; i++) {
    const seg = close.slice(i - period + 1, i + 1);
    const m = mean(seg);
    const sd = Math.sqrt(mean(seg.map((x) => (x - m) * (x - m))));
    out.push(m > 0 ? (4 * sd) / m : 0);
  }
  return out;
}

function computeSqueeze(rows) {
  const out = {
    vol_dryup_ratio: null, vol_dryup_days: null, bbw_percentile: null,
    band_top_20d: null, vol_avg_20d: null,
  };
  const n = rows.length;
  if (!n) return out;

  const close = rows.map((r) => r.close);
  const vol   = rows.map((r) => (Number.isFinite(r.qvol) ? r.qvol : 0));
  const L = cfg.VOL_DRYUP_LONG, S = cfg.VOL_DRYUP_SHORT;

  // band_top_20d & vol_avg_20d — eldeki pencereyle (genç coinlerde de hesaplanır)
  const c20 = close.slice(-cfg.BAND_TOP_WINDOW);
  if (c20.length) out.band_top_20d = Math.max(...c20);
  const v20 = vol.slice(-cfg.VOL_AVG_WINDOW);
  if (v20.length) out.vol_avg_20d = mean(v20);

  // vol_dryup_days — bugünden geriye, hacim < 0.40 * (o günün 90g rolling ort.) kesintisiz
  let dryDays = 0;
  for (let i = n - 1; i >= 0; i--) {
    const w = vol.slice(Math.max(0, i - (L - 1)), i + 1);
    const avg = mean(w);
    if (avg > 0 && vol[i] < cfg.VOL_DRYUP_THRESH * avg) dryDays++;
    else break;
  }
  out.vol_dryup_days = dryDays;

  // vol_dryup_ratio & bbw_percentile — sadece >=90g geçmişte
  if (n >= L) {
    const m90 = mean(vol.slice(-L));
    const m7  = mean(vol.slice(-S));
    out.vol_dryup_ratio = (m90 && m90 > 0) ? +(m7 / m90).toFixed(3) : null;

    const bbw = bbwSeries(close, cfg.BB_PERIOD);
    if (bbw.length) {
      const today = bbw[bbw.length - 1];
      const look = bbw.slice(-cfg.BBW_LOOKBACK);           // son 180g BBW
      const cnt = look.filter((v) => v <= today).length;   // yüzdelik sıra
      out.bbw_percentile = +((cnt / look.length) * 100).toFixed(1);
    }
  }

  return out;
}

module.exports = { computeSqueeze };
