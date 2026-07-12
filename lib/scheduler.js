// Zamanlayıcı: gecelik tam güncelleme (04:00) + 15dk breakout telegram bildirimi.
// pm2 ile süreç sürekli ayakta olduğundan in-process cron kullanılır.
const cron = require('node-cron');
const refresh = require('./refresh');
const live = require('./live');
const tg = require('./telegram');
const cfg = require('./config');

const COOLDOWN_MS = cfg.TG_ALERT_COOLDOWN_H * 3600 * 1000;
const lastAlertAt = new Map();   // symbol -> son uyarı ts
let firingPrev = new Set();      // önceki turda yanan semboller
let primed = false;              // açılışta ilk tur sessiz mi geçildi

// ── biçimlendirme ──
function triggerLabels(b) {
  const p = [];
  if (b.kirilim)    p.push('🔥 KIRILIM');
  if (b.band_break) p.push('BAND');
  if (b.vol_spike)  p.push('HACİM');
  if (b.chg_break)  p.push('24S%');
  return p.join(' · ');
}
function fmtPrice(v) {
  if (v == null) return '—';
  if (v >= 1) return v.toFixed(4);
  if (v >= 0.01) return v.toFixed(5);
  return Number(v).toPrecision(4);
}
function fmtVol(v) {
  if (v == null) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(v);
}

// ── 15dk breakout kontrolü + telegram ──
async function breakoutCheck(pool) {
  let result;
  try {
    result = await live.computeLive(pool);
  } catch (e) {
    console.error('[scheduler] live hesap hatası:', e.message);
    return;
  }
  const firingNow = new Set(result.breakouts.map(b => b.symbol));

  // Açılışta ilk tur sessiz — sadece durumu doldur, restart'ta patlama olmasın
  if (!primed) {
    firingPrev = firingNow;
    primed = true;
    console.log(`[scheduler] ilk tur sessiz — ${firingNow.size} coin yanıyor, uyarı atılmadı`);
    return;
  }

  const now = Date.now();
  // Yeni girenler: önceki turda yanmıyordu + cooldown geçmiş
  const fresh = result.breakouts.filter(b => {
    if (firingPrev.has(b.symbol)) return false;
    return (now - (lastAlertAt.get(b.symbol) || 0)) >= COOLDOWN_MS;
  });
  firingPrev = firingNow;
  if (!fresh.length) return;

  for (const b of fresh) lastAlertAt.set(b.symbol, now);

  const lines = fresh.map(b => {
    const dist = b.dist_lo7 != null ? `${b.dist_lo7 >= 0 ? '+' : ''}${b.dist_lo7.toFixed(1)}%` : '—';
    const chg = `${b.chgPct >= 0 ? '+' : ''}${Number(b.chgPct).toFixed(1)}%`;
    return `*${b.symbol}*  ${triggerLabels(b)}\n` +
           `  fiyat ${fmtPrice(b.last)} · 24h ${chg} · hacim ${fmtVol(b.quoteVol)} · dip ${dist}\n` +
           `  [coin »](${cfg.DASH_URL}/pump-coin.html?symbol=${b.symbol})`;
  });
  const header = `🚨 *Hareket başladı* — ${fresh.length} yeni coil\n` +
                 `[» Hareket başladı sekmesi](${cfg.DASH_URL}/pump.html#hareket)`;
  await tg.sendMessage(`${header}\n\n${lines.join('\n\n')}`);
  console.log(`[scheduler] telegram: ${fresh.length} yeni breakout → ${fresh.map(b => b.symbol).join(', ')}`);
}

function start(pool) {
  // Gecelik tam güncelleme (04:00, Istanbul)
  cron.schedule(cfg.CRON_NIGHTLY, async () => {
    console.log('[scheduler] gecelik tam güncelleme başlıyor');
    try { await refresh.startAll(pool); }
    catch (e) { console.error('[scheduler] gecelik refresh hatası:', e.message); }
  }, { timezone: cfg.CRON_TZ });

  // 15dk breakout kontrol + telegram
  cron.schedule(cfg.CRON_BREAKOUT, () => breakoutCheck(pool));

  // Açılışta bir kez sessiz priming (DB hazır olsun diye kısa gecikme)
  setTimeout(() => breakoutCheck(pool), 10000);

  console.log(`[scheduler] başlatıldı — gecelik ${cfg.CRON_NIGHTLY} (${cfg.CRON_TZ}) refresh + ${cfg.CRON_BREAKOUT} breakout bildirimi`);
}

module.exports = { start };
