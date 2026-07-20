// Refresh job'u (handoff spec §7) — "Tümünü güncelle" için in-memory ilerleme.
// Tek job aynı anda; progress bar GET /status ile okunur.
const binance = require('./binance');
const scan = require('./scan');
const cfg = require('./config');

let job = {
  running: false,
  total: 0, done: 0, ok: 0, failed: 0,
  current: null, startedAt: null, finishedAt: null,
  errors: [],   // {symbol, error}
  lastResult: null,
};

function status() { return { ...job, errors: job.errors.slice(-20) }; }

// onComplete(opsiyonel): arka plan döngüsü bitince { ok, failed } ile çağrılır
// (scheduler bunu teknik takip bildirimi için kullanır; endpoint çağrısı vermez).
async function startAll(pool, onComplete) {
  if (job.running) return { started: false, reason: 'already_running' };

  const universe = await scan.getUniverse(pool);
  job = {
    running: true,
    total: universe.length, done: 0, ok: 0, failed: 0,
    current: null, startedAt: new Date(), finishedAt: null,
    errors: [], lastResult: null,
  };
  console.log(`[pump/refresh] evren = ${universe.length} coin (alpha ∩ TRADING futures)`);

  // Evren dışı kalmış (delist/settling) coinleri tablolardan temizle (guard: evren boş değilse)
  const symbols = universe.map(c => c.symbol);
  if (symbols.length) {
    const ph = symbols.map(() => '?').join(',');
    const [d1] = await pool.query(`DELETE FROM coin_metrics WHERE symbol NOT IN (${ph})`, symbols);
    const [d2] = await pool.query(`DELETE FROM pump_events  WHERE symbol NOT IN (${ph})`, symbols);
    let d3 = { affectedRows: 0 };
    try { [d3] = await pool.query(`DELETE FROM coin_tech_signals WHERE symbol NOT IN (${ph})`, symbols); }
    catch (e) { /* tablo henüz yoksa (migration çalışmadıysa) sessiz geç */ }
    if (d1.affectedRows || d2.affectedRows || d3.affectedRows)
      console.log(`[pump/refresh] prune: coin_metrics -${d1.affectedRows}, pump_events -${d2.affectedRows}, coin_tech_signals -${d3.affectedRows}`);
  }

  // Arka planda çalıştır; endpoint hemen döner.
  (async () => {
    for (const coin of universe) {
      job.current = coin.symbol;
      try {
        job.lastResult = await scan.scanCoin(pool, coin);
        job.ok++;
      } catch (err) {
        job.failed++;
        job.errors.push({ symbol: coin.symbol, error: err.message });
        console.error(`[pump/refresh] ${coin.symbol} hata:`, err.message);
      }
      job.done++;
      await binance.sleep(cfg.SCAN_DELAY_MS); // alpha bapi throttle
    }
    job.running = false;
    job.current = null;
    job.finishedAt = new Date();
    console.log(`[pump/refresh] bitti: ok=${job.ok} failed=${job.failed}`);
    if (typeof onComplete === 'function') {
      try { await onComplete({ ok: job.ok, failed: job.failed }); }
      catch (e) { console.error('[pump/refresh] onComplete hatası:', e.message); }
    }
  })();

  return { started: true, total: universe.length };
}

// Tek coin (satır içi buton)
async function refreshOne(pool, symbol) {
  const universe = await scan.getUniverse(pool);
  const coin = universe.find(c => c.symbol === symbol);
  if (!coin) throw Object.assign(new Error(`universe_disi: ${symbol}`), { status: 404 });
  return scan.scanCoin(pool, coin);
}

module.exports = { startAll, refreshOne, status };
