// Teknik Takip taraması — pump taramasından AYRI ve daha geniş evren.
//   Evren : TÜM TRADING futures (binance_futures_tracking), alpha şartı YOK.
//   Çıktı : coin_tech_signals (symbol, timeframe) — 1d/4h/1w × RSI+MA+MACD.
// Pump tarafı (coin_metrics / pump_events, alpha∩futures) bundan etkilenmez.
// Sadece fapi klines'a vurur (alpha bapi yok) → düşük throttle yeterli.
const binance = require('./binance');
const P = require('./pumps');
const cfg = require('./config');
const { rsiSignal } = require('./rsi');
const { techSignals } = require('./tech');

let job = { running: false, total: 0, done: 0, ok: 0, failed: 0, current: null,
            startedAt: null, finishedAt: null };

function status() { return { ...job }; }

// Evren = TRADING & delist olmayan tüm futures base_asset'leri (PERPETUAL öncelikli)
async function getTechUniverse(pool) {
  const [rows] = await pool.query(`
    SELECT base_asset
      FROM binance_futures_tracking
     WHERE is_delist = 0 AND status = 'TRADING'
     GROUP BY base_asset
  `);
  return rows.map(r => r.base_asset).filter(Boolean);
}

const TECH_COLS = ['symbol','timeframe','rsi14','rsi_ma','rsi_cross_bars_ago',
                   'ma50','ma200','ma_cross_bars_ago','ma_source',
                   'macd','macd_signal','macd_hist','macd_cross_bars_ago','updated_at'];

// Tek coin: her zaman dilimi için klines çek → RSI/MA/MACD → upsert
async function scanTechCoin(pool, symbol) {
  const tfRows = [];
  for (const [tf, c] of Object.entries(cfg.TIMEFRAMES)) {
    try {
      const rows = P.parseRows(await binance.futuresKlines(symbol, c.interval, c.limit));
      if (!rows.length) continue;
      const cl = rows.map(r => r.close);
      tfRows.push({ tf, rs: rsiSignal(cl), tech: techSignals(cl) });
      await binance.sleep(cfg.TECH_SCAN_DELAY_MS);
    } catch (e) { /* bu dilim yoksa atla */ }
  }
  if (!tfRows.length) return { symbol, timeframes: 0 };

  // MA devri: bir dilimde MA200 oluşmamışsa (ör. haftalıkta 200 hafta geçmiş yok)
  // günlük MA'yı kullan. ma_source hangi dilimden geldiğini söyler; kesişim yaşı
  // o kaynağın BAR biriminde kalır (frontend eşiği ma_source'a göre seçer).
  const daily = tfRows.find(r => r.tf === '1d');
  for (const row of tfRows) {
    if (row.tf !== '1d' && row.tech.ma200 == null && daily && daily.tech.ma200 != null) {
      row.tech = { ...row.tech,
        ma50: daily.tech.ma50, ma200: daily.tech.ma200,
        ma_cross_days_ago: daily.tech.ma_cross_days_ago };
      row.maSource = '1d';
    } else {
      row.maSource = row.tf;
    }
  }

  const now = new Date();
  const values = tfRows.map(({ tf, rs, tech, maSource }) => [
    symbol, tf, rs.rsi14, rs.rsi_ma, rs.rsi_cross_days_ago,
    tech.ma50, tech.ma200, tech.ma_cross_days_ago, maSource || tf,
    tech.macd, tech.macd_signal, tech.macd_hist, tech.macd_cross_days_ago, now,
  ]);
  const updates = TECH_COLS.filter(c => c !== 'symbol' && c !== 'timeframe')
    .map(c => `\`${c}\`=VALUES(\`${c}\`)`).join(',');
  await pool.query(
    `INSERT INTO coin_tech_signals (${TECH_COLS.map(c => `\`${c}\``).join(',')}) VALUES ?
     ON DUPLICATE KEY UPDATE ${updates}`,
    [values]
  );
  return { symbol, timeframes: tfRows.length };
}

// Tüm evren — refresh'ten sonra scheduler tarafından çağrılır (await edilebilir).
async function runAll(pool) {
  if (job.running) return { started: false, reason: 'already_running' };
  const universe = await getTechUniverse(pool);
  job = { running: true, total: universe.length, done: 0, ok: 0, failed: 0,
          current: null, startedAt: new Date(), finishedAt: null };
  console.log(`[tech-scan] evren = ${universe.length} coin (tüm TRADING futures)`);

  // Evren dışı kalmışları temizle
  if (universe.length) {
    const ph = universe.map(() => '?').join(',');
    try {
      const [d] = await pool.query(`DELETE FROM coin_tech_signals WHERE symbol NOT IN (${ph})`, universe);
      if (d.affectedRows) console.log(`[tech-scan] prune: -${d.affectedRows} satır`);
    } catch (e) { /* tablo yoksa sessiz */ }
  }

  for (const symbol of universe) {
    job.current = symbol;
    try { await scanTechCoin(pool, symbol); job.ok++; }
    catch (err) { job.failed++; console.error(`[tech-scan] ${symbol} hata:`, err.message); }
    job.done++;
  }
  job.running = false; job.current = null; job.finishedAt = new Date();
  const secs = ((job.finishedAt - job.startedAt) / 1000).toFixed(0);
  console.log(`[tech-scan] bitti: ok=${job.ok} failed=${job.failed} (${secs}s)`);
  return { started: true, ok: job.ok, failed: job.failed };
}

module.exports = { getTechUniverse, scanTechCoin, runAll, status };
