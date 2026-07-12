// LIVE katmanı — canlı batch ticker + funding + breakout/kırılım hesabı.
// Hem GET /api/pump/live endpoint'i hem scheduler (15dk telegram) buradan beslenir.
const binance = require('./binance');
const cfg = require('./config');

async function computeLive(pool) {
  const [ticker, funding, sleepers] = await Promise.all([
    binance.ticker24hAll(),
    binance.fundingAll(),
    pool.query(`SELECT symbol, cons_mid, vol_base, low_7d, band_top_20d, vol_avg_20d, is_sleeping
                FROM coin_metrics WHERE is_sleeping = 1`).then(r => r[0]),
  ]);

  // Tüm coinler için canlı map (frontend merge eder)
  const [allSyms] = await pool.query('SELECT symbol FROM coin_metrics');
  const coins = {};
  for (const { symbol } of allSyms) {
    const t = ticker.get(`${symbol}USDT`);
    coins[symbol] = t
      ? { last: t.last, chgPct: t.chgPct, quoteVol: t.quoteVol, funding: funding.get(`${symbol}USDT`) ?? null }
      : { last: null, chgPct: null, quoteVol: null, funding: null };
  }

  // Breakout tetiği yalnızca uyuyan set
  const breakouts = [];
  for (const s of sleepers) {
    const t = ticker.get(`${s.symbol}USDT`);
    if (!t) continue;
    const consMid = s.cons_mid != null ? Number(s.cons_mid) : null;
    const volBase = s.vol_base != null ? Number(s.vol_base) : null;
    const low7    = s.low_7d != null ? Number(s.low_7d) : null;
    const bandTop = s.band_top_20d != null ? Number(s.band_top_20d) : null;
    const volAvg  = s.vol_avg_20d != null ? Number(s.vol_avg_20d) : null;
    const bandBreak = consMid != null && t.last > consMid * (1 + cfg.CONS_BAND);
    const volSpike  = volBase != null && volBase > 0 && t.quoteVol > volBase * cfg.BREAKOUT_VOL_MULT;
    const chgBreak  = t.chgPct >= cfg.BREAKOUT_CHG_PCT;
    // KIRILIM (20g yüksek + hacim)
    const kirilim   = bandTop != null && volAvg != null && volAvg > 0
      && t.last > bandTop * cfg.KIRILIM_PRICE_MULT && t.quoteVol > volAvg * cfg.KIRILIM_VOL_MULT;
    if (bandBreak || volSpike || chgBreak || kirilim) {
      breakouts.push({
        symbol: s.symbol, last: t.last, chgPct: t.chgPct, quoteVol: t.quoteVol,
        funding: funding.get(`${s.symbol}USDT`) ?? null,
        dist_lo7: low7 && low7 > 0 ? (t.last / low7 - 1) * 100 : null,
        band_break: bandBreak, vol_spike: volSpike, chg_break: chgBreak, kirilim,
      });
    }
  }
  // kırılım yapanlar en üstte, sonra 24h değişime göre
  breakouts.sort((a, b) => (Number(b.kirilim) - Number(a.kirilim)) || ((b.chgPct || 0) - (a.chgPct || 0)));

  return { updatedAt: new Date(), coins, breakouts };
}

module.exports = { computeLive };
