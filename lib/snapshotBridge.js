// snapshotBridge.js — "Hareket başladı" breakout sinyallerini kardeş telegram-bot
// projesindeki signal_snapshots pipeline'ına source_type='hareket' ile düşürür.
//
// Mimari: volume-tracker (CJS) breakout tespitini yapar, buradan telegram-bot'un
// ESM collector'ı (runSignalSnapshotCollector) dinamik import ile çağrılır. İki proje
// AYNI DB'yi kullandığından collector, bu sürecin process.env.DB_* değerlerini miras
// alır ve doğru DB'ye yazar (server.js zaten aynı env ile signal_snapshots okur).
//
// SADECE KAYIT: bu source_type trade tetiklemez (telegram-bot tarafında pre-trader.js
// ve traderfable.js guard'ları 'hareket'i dışlar). Outcome takibi mevcut sistemle işler.
const path = require('path');

// Collector yolu — kardeş klasör varsayılanı, gerekirse env ile override edilir.
const COLLECTOR_PATH = process.env.SNAPSHOT_COLLECTOR_PATH
  || path.resolve(__dirname, '../../telegram-bot/signal-snapshot-collector/index.js');

// Aynı symbol için tekrar snapshot atma penceresi (saat). Scheduler'ın in-memory
// cooldown'ına ek olarak restart sonrası da mükerrer kaydı engeller.
const COOLDOWN_H = Number(process.env.HAREKET_COOLDOWN_H || process.env.TG_ALERT_COOLDOWN_H || 10);

// base_asset → binance_symbol (futures) eşlemesi. Collector, binancefuturedata /
// oi_funding_snapshots ile binance_symbol üzerinden eşleşir; coin_metrics.symbol ise
// base_asset (çıplak "BTC") tutar. PERPETUAL kontratı tercih edilir.
async function loadFuturesSymbolMap(pool) {
  const [rows] = await pool.query(
    `SELECT base_asset, binance_symbol, contract_type
       FROM binance_futures_tracking
      WHERE is_delist = 0 AND status = 'TRADING'
      ORDER BY (contract_type = 'PERPETUAL') DESC`
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.base_asset)) map.set(r.base_asset, r.binance_symbol);
  }
  return map;
}

// signal_snapshots'ta son COOLDOWN_H saat içinde bu symbol+hareket kaydı var mı?
async function inCooldown(pool, binanceSymbol) {
  const [rows] = await pool.query(
    `SELECT id FROM signal_snapshots
       WHERE symbol = ? AND source_type = 'hareket'
         AND created_at >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)
       LIMIT 1`,
    [binanceSymbol, COOLDOWN_H]
  );
  return rows.length > 0;
}

// Breakout tetik etiketlerini note (VARCHAR 64) için kompakt string'e çevirir.
function triggerTag(b) {
  const p = [];
  if (b.kirilim)    p.push('KIRILIM');
  if (b.band_break) p.push('BAND');
  if (b.vol_spike)  p.push('HACIM');
  if (b.chg_break)  p.push('24S');
  return p.join('+') || 'breakout';
}

/**
 * Fresh breakout listesini snapshot pipeline'ına gönderir.
 * @param {import('mysql2/promise').Pool} pool  volume-tracker DB pool'u
 * @param {Array<Object>} breakouts  live.computeLive().breakouts (fresh süzülmüş) —
 *   { symbol(base), last, chgPct, quoteVol, funding, dist_lo7, band_break, vol_spike, chg_break, kirilim }
 */
async function pushHareketSignals(pool, breakouts) {
  if (!breakouts || !breakouts.length) return;

  let symMap;
  try {
    symMap = await loadFuturesSymbolMap(pool);
  } catch (e) {
    console.error('[hareket-bridge] futures symbol map hatası:', e.message);
    return;
  }

  const candidates = [];
  const skipped = [];
  for (const b of breakouts) {
    const binanceSymbol = symMap.get(b.symbol);
    if (!binanceSymbol) { skipped.push(`${b.symbol}(map-yok)`); continue; }

    try {
      if (await inCooldown(pool, binanceSymbol)) { skipped.push(`${b.symbol}(cooldown)`); continue; }
    } catch (e) {
      console.error(`[hareket-bridge] ${b.symbol} cooldown sorgu hatası:`, e.message);
      continue;
    }

    const chg = b.chgPct != null ? Number(b.chgPct).toFixed(1) : '-';
    const dist = b.dist_lo7 != null ? Number(b.dist_lo7).toFixed(1) : '-';
    const note = `hareket ${triggerTag(b)} chg${chg} dip${dist}`.slice(0, 64);

    candidates.push({
      symbol: binanceSymbol,
      source_type: 'hareket',
      price_change: b.chgPct != null ? Number(b.chgPct) : null,
      funding_fee: b.funding != null ? Number(b.funding) : null,
      note,
    });
  }

  console.log(`[hareket-bridge] tetik=${candidates.length}`
    + (skipped.length ? ` | atlanan: ${skipped.join(', ')}` : ''));

  if (!candidates.length) return;

  // ESM collector'ı dinamik import (CJS'ten çalışır). Pipeline kendi DB verilerini
  // (OI, RSI, hacim, fuel) çeker ve tam snapshot + score yazar.
  try {
    const mod = await import(COLLECTOR_PATH);
    await mod.runSignalSnapshotCollector(candidates);
    console.log(`[hareket-bridge] ${candidates.length} hareket snapshot pipeline'a gönderildi`);
  } catch (e) {
    console.error('[hareket-bridge] runSignalSnapshotCollector hatası:', e.message || e);
  }
}

module.exports = { pushHareketSignals };
