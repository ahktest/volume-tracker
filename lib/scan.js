// STORE katmanı (handoff spec §6) — tek coin ağır tarama + evren sorgusu.
// coin_metrics (upsert) + pump_events (delete-then-insert) doldurur.
const binance = require('./binance');
const P = require('./pumps');
const cfg = require('./config');

// ── Evren: alpha ∩ futures (exchangecoins) + binance_futures_tracking meta ──
async function getUniverse(pool) {
  // venue flag'leri exchangecoins.source'tan; evren = is_alpha & is_fut
  const [rows] = await pool.query(`
    SELECT
      ec.symbol AS symbol,
      MAX(CASE WHEN ec.source='binance_alpha' THEN ec.alpha_id END) AS alpha_id,
      MAX(ec.source='binance_alpha')   AS is_alpha,
      MAX(ec.source='binance_futures') AS is_fut,
      MAX(ec.source='binance_spot')    AS is_spot,
      MAX(ec.source='upbit')           AS is_upbit,
      MAX(ec.source='bybit_futures')   AS is_bybit
    FROM exchangecoins ec
    GROUP BY ec.symbol
    HAVING is_alpha = 1 AND is_fut = 1
  `);

  // binance_futures_tracking meta'sı (base_asset başına PERPETUAL tercihli tek satır)
  const [bftRows] = await pool.query(`
    SELECT base_asset, mcap_usd, is_verified, status, contract_type
    FROM binance_futures_tracking
    WHERE is_delist = 0
    ORDER BY (contract_type='PERPETUAL') DESC, mcap_usd DESC
  `);
  const bft = new Map();
  for (const r of bftRows) if (!bft.has(r.base_asset)) bft.set(r.base_asset, r);

  return rows.map(r => {
    const m = bft.get(r.symbol) || {};
    return {
      symbol: r.symbol,
      alpha_id: r.alpha_id || null,
      is_alpha: +r.is_alpha, is_fut: +r.is_fut, is_spot: +r.is_spot,
      is_upbit: +r.is_upbit, is_bybit: +r.is_bybit,
      mcap_usd: m.mcap_usd != null ? Number(m.mcap_usd) : null,
      is_verified: m.is_verified != null ? +m.is_verified : 0,
      status: m.status || null,
      contract_type: m.contract_type || null,
    };
  });
}

// ── Tek coin STORE hesabı ──
async function scanCoin(pool, coin) {
  const symbol = coin.symbol;

  // Klines çek (market başına izole; biri patlarsa diğeri devam)
  let futRows = [];
  let alphaRows = [];
  try { futRows = P.parseRows(await binance.futuresKlines(symbol)); }
  catch (e) { /* futures yok/erişilemez -> boş */ }
  if (coin.alpha_id) {
    try { alphaRows = P.parseRows(await binance.alphaKlines(coin.alpha_id)); }
    catch (e) { /* alpha yok -> boş */ }
  }

  // Birincil seri = futures (yoksa metrikler null kalır, is_sleeping=0)
  const primary = futRows;
  const lastPrice = primary.length ? primary[primary.length - 1].close : null;

  const futAth   = P.athOf(futRows);
  const alphaAth = P.athOf(alphaRows);
  const cons     = P.detectConsolidation(primary);
  const low7     = P.lowN(primary, cfg.LOW_WINDOWS.low_7d);

  const metrics = {
    symbol,
    alpha_id: coin.alpha_id,
    is_alpha: coin.is_alpha, is_fut: coin.is_fut, is_spot: coin.is_spot,
    is_upbit: coin.is_upbit, is_bybit: coin.is_bybit,
    mcap_usd: coin.mcap_usd, is_verified: coin.is_verified,
    status: coin.status, contract_type: coin.contract_type,

    alpha_created_at: alphaRows.length ? alphaRows[0].date : null,
    fut_created_at:   futRows.length ? futRows[0].date : null,

    fut_history_days: P.historyDays(futRows),
    fut_ath_price: futAth.price, fut_ath_date: futAth.date, fut_ath_age_days: futAth.ageDays,

    alpha_history_days: P.historyDays(alphaRows),
    alpha_ath_price: alphaAth.price, alpha_ath_date: alphaAth.date, alpha_ath_age_days: alphaAth.ageDays,

    low_7d:  low7,
    low_30d: P.lowN(primary, cfg.LOW_WINDOWS.low_30d),
    low_90d: P.lowN(primary, cfg.LOW_WINDOWS.low_90d),
    dist_lo7: (lastPrice != null && low7 > 0) ? (lastPrice / low7 - 1) * 100 : null,
    ret3d:  P.retN(primary, cfg.RET_WINDOWS.ret3d),
    ret7d:  P.retN(primary, cfg.RET_WINDOWS.ret7d),
    ret30d: P.retN(primary, cfg.RET_WINDOWS.ret30d),

    consolidation_days: cons.days,
    cons_range_pct: cons.range_pct,
    cons_since_date: cons.since_date,
    cons_mid: cons.cons_mid,
    is_sleeping: cons.days >= cfg.CONS_MIN_DAYS ? 1 : 0,

    vol_base: P.volBase(primary),
    last_price: lastPrice,
    last_updated_at: new Date(),
  };

  // pump_events (iki market)
  const futEvents   = P.markListingPumps(P.detectPumps(futRows), futRows).map(e => ({ ...e, market: 'futures' }));
  const alphaEvents = P.markListingPumps(P.detectPumps(alphaRows), alphaRows).map(e => ({ ...e, market: 'alpha' }));

  await upsertMetrics(pool, metrics);
  await replaceEvents(pool, symbol, [...futEvents, ...alphaEvents]);

  return {
    symbol,
    fut_klines: futRows.length, alpha_klines: alphaRows.length,
    fut_events: futEvents.length, alpha_events: alphaEvents.length,
    is_sleeping: metrics.is_sleeping, consolidation_days: cons.days,
  };
}

const METRIC_COLS = [
  'symbol','alpha_id','is_alpha','is_fut','is_spot','is_upbit','is_bybit',
  'mcap_usd','is_verified','status','contract_type','alpha_created_at','fut_created_at',
  'fut_history_days','fut_ath_price','fut_ath_date','fut_ath_age_days',
  'alpha_history_days','alpha_ath_price','alpha_ath_date','alpha_ath_age_days',
  'low_7d','low_30d','low_90d','dist_lo7','ret3d','ret7d','ret30d',
  'consolidation_days','cons_range_pct','cons_since_date','cons_mid','is_sleeping',
  'vol_base','last_price','last_updated_at',
];

async function upsertMetrics(pool, m) {
  const vals = METRIC_COLS.map(c => (m[c] === undefined ? null : m[c]));
  const placeholders = METRIC_COLS.map(() => '?').join(',');
  const updates = METRIC_COLS.filter(c => c !== 'symbol').map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(',');
  await pool.query(
    `INSERT INTO coin_metrics (${METRIC_COLS.map(c => `\`${c}\``).join(',')})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates}`,
    vals
  );
}

async function replaceEvents(pool, symbol, events) {
  await pool.query('DELETE FROM pump_events WHERE symbol = ?', [symbol]);
  if (!events.length) return;
  const cols = ['symbol','market','trough_date','trough_price','peak_date','peak_price',
                'magnitude_x','duration_days','speed_class','is_listing_pump'];
  const rows = events.map(e => [
    symbol, e.market, e.trough_date, e.trough_price, e.peak_date, e.peak_price,
    e.magnitude_x, e.duration_days, e.speed_class, e.is_listing_pump ? 1 : 0,
  ]);
  await pool.query(
    `INSERT INTO pump_events (${cols.map(c => `\`${c}\``).join(',')}) VALUES ?
     ON DUPLICATE KEY UPDATE
       peak_date=VALUES(peak_date), peak_price=VALUES(peak_price),
       magnitude_x=VALUES(magnitude_x), duration_days=VALUES(duration_days),
       speed_class=VALUES(speed_class), is_listing_pump=VALUES(is_listing_pump)`,
    [rows]
  );
}

module.exports = { getUniverse, scanCoin };
