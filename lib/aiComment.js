// AI Yorum — Claude Code CLI'ı headless çağırır (Anthropic Messages API DEĞİL).
// Faturalandırma kullanıcının Claude aboneliğinden düşer; ayrı API faturası çıkmaz.
//
// Doğrulanmış davranışlar (VPS'te test edildi):
//  • `--bare` KULLANILMAZ — kayıtlı oturumu da atlayıp "Not logged in" veriyor.
//    Keşif yükü bunun yerine boş temp cwd + --strict-mcp-config ile kısılır.
//  • CLI, auth hatasında bile exit 0 + type:"result" JSON döndürür → `is_error` kontrolü ŞART.
//  • Web araması Haiku'ya delege ediliyor: usage.server_tool_use.web_search_requests = 0 kalır,
//    gerçek sayı modelUsage[*].webSearchRequests içindedir → toplayarak okunur.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cfg = require('./config');

// ── Boş çalışma dizini: CLAUDE.md / proje skill'i / hook keşfini engeller ──
let WORKDIR = null;
function workdir() {
  if (!WORKDIR || !fs.existsSync(WORKDIR)) {
    WORKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-comment-'));
  }
  return WORKDIR;
}

// ── Eşzamanlılık: her çağrı tam bir Claude Code süreci (ağır) → aynı anda 1 ──
let busy = false;
const inFlight = new Set();          // symbol bazlı kilit
const errorCooldown = new Map();     // symbol -> ts (hata sonrası bekleme)

// ── CLI çağrısı ──
// promptText: pozisyonel argüman (SABİT metin, interpolasyon YOK → shell injection imkânsız)
// stdinData : coin verisi (JSON) — stdin'den geçer, asla komut satırına girmez
function runClaude(promptText, stdinData) {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', promptText,
      '--output-format', 'json',
      '--model', cfg.AI_MODEL,
      '--allowedTools', cfg.AI_ALLOWED_TOOLS,
      '--strict-mcp-config',              // --mcp-config verilmedi → tüm MCP sunucuları yok sayılır
      '--max-turns', String(cfg.AI_MAX_TURNS),
    ];
    const env = { ...process.env, HOME: cfg.AI_HOME };
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      // trim: .env'den gelen değerde görünmez boşluk/CR olursa auth sessizce patlar
      env.CLAUDE_CODE_OAUTH_TOKEN = String(process.env.CLAUDE_CODE_OAUTH_TOKEN).trim();
    }

    let child;
    try { child = spawn(cfg.CLAUDE_BIN, args, { cwd: workdir(), env }); }
    catch (e) { return reject(new Error(`spawn başarısız: ${e.message}`)); }

    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, cfg.AI_TIMEOUT_MS);

    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); reject(new Error(`spawn hatası: ${e.message}`)); });
    child.on('close', () => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`zaman aşımı (${cfg.AI_TIMEOUT_MS / 1000}sn)`));
      let j;
      try { j = JSON.parse(out); }
      catch { return reject(new Error(`JSON parse edilemedi: ${(err || out || '(boş çıktı)').slice(0, 300)}`)); }
      resolve(j);
    });

    child.stdin.on('error', () => { /* EPIPE: process erken kapandıysa yut */ });
    child.stdin.end(stdinData);
  });
}

// modelUsage içindeki tüm modellerin web arama sayısını topla (üstteki alan hep 0 geliyor)
function countWebSearches(j) {
  let n = Number((j.usage && j.usage.server_tool_use && j.usage.server_tool_use.web_search_requests) || 0);
  for (const mu of Object.values(j.modelUsage || {})) n += Number(mu.webSearchRequests || 0);
  return n;
}

// ── Limitler (Istanbul/UTC+3 takvim günü; Türkiye sabit +03, DST yok) ──
const DAY_START_TR = `CONVERT_TZ(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+03:00')),'+03:00','+00:00')`;
const MONTH_START_TR = `CONVERT_TZ(DATE_FORMAT(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+03:00'),'%Y-%m-01'),'+03:00','+00:00')`;

// Kotaya sadece modele ulaşan çağrılar sayılır (altyapı hatası kotayı yakmaz).
const COUNTED = `status IN ('ok','refusal')`;

async function limits(pool, symbol) {
  const [[coin]] = await pool.query(
    `SELECT COUNT(*) AS n FROM coin_ai_comments
      WHERE symbol = ? AND ${COUNTED} AND created_at >= ${DAY_START_TR}`, [symbol]);
  const [[day]] = await pool.query(
    `SELECT COUNT(*) AS n FROM coin_ai_comments
      WHERE ${COUNTED} AND created_at >= ${DAY_START_TR}`);
  const [[month]] = await pool.query(
    `SELECT COALESCE(SUM(cost_usd),0) AS c FROM coin_ai_comments
      WHERE created_at >= ${MONTH_START_TR}`);

  const coinUsed = Number(coin.n), dayUsed = Number(day.n), spent = Number(month.c);
  let blocked = null;
  if (coinUsed >= cfg.AI_DAILY_PER_COIN)          blocked = 'coin_daily';
  else if (dayUsed >= cfg.AI_DAILY_GLOBAL_CAP)    blocked = 'global_daily';
  else if (spent >= cfg.AI_MONTHLY_BUDGET_USD)    blocked = 'monthly_budget';

  return {
    coinUsed, coinLimit: cfg.AI_DAILY_PER_COIN,
    dayUsed,  dayLimit:  cfg.AI_DAILY_GLOBAL_CAP,
    spent: +spent.toFixed(4), budget: cfg.AI_MONTHLY_BUDGET_USD,
    blocked, canGenerate: !blocked,
  };
}

// ── Coin verisi topla (DB'den; ek API çağrısı yok) ──
async function buildContext(pool, symbol) {
  const [[m]] = await pool.query(`
    SELECT cm.*, bft.mcap_usd AS bft_mcap, bft.cmc_slug
      FROM coin_metrics cm
      LEFT JOIN (SELECT base_asset, MAX(mcap_usd) mcap_usd, MAX(cmc_slug) cmc_slug
                   FROM binance_futures_tracking WHERE is_delist=0 GROUP BY base_asset) bft
             ON bft.base_asset = cm.symbol
     WHERE cm.symbol = ?`, [symbol]);

  // coin_metrics'te yoksa (alpha evreni dışı) futures meta'sına düş
  let meta = m;
  if (!meta) {
    const [[f]] = await pool.query(
      `SELECT base_asset AS symbol, mcap_usd AS bft_mcap, cmc_slug, status, contract_type
         FROM binance_futures_tracking
        WHERE base_asset=? AND is_delist=0 AND status='TRADING'
        ORDER BY (contract_type='PERPETUAL') DESC LIMIT 1`, [symbol]);
    if (!f) return null;
    meta = f;
  }

  const [tech] = await pool.query(
    `SELECT timeframe, rsi14, rsi_ma, rsi_cross_bars_ago, ma50, ma200, ma_cross_bars_ago,
            ma_source, macd, macd_signal, macd_hist
       FROM coin_tech_signals WHERE symbol = ?`, [symbol]);

  const [events] = await pool.query(
    `SELECT market, trough_date, peak_date, ROUND(magnitude_x,1) AS x,
            duration_days, speed_class, is_listing_pump
       FROM pump_events WHERE symbol = ? ORDER BY peak_date DESC LIMIT 8`, [symbol]);

  const num = v => (v === null || v === undefined) ? null : Number(v);
  return {
    sembol: symbol,
    borsalar: {
      binance_alpha: !!+meta.is_alpha, binance_futures: !!+meta.is_fut,
      binance_spot: !!+meta.is_spot, upbit: !!+meta.is_upbit, bybit: !!+meta.is_bybit,
    },
    piyasa_degeri_usd: num(meta.mcap_usd ?? meta.bft_mcap),
    son_fiyat: num(meta.last_price),
    getiriler_yuzde: { '3g': num(meta.ret3d), '7g': num(meta.ret7d), '30g': num(meta.ret30d) },
    dip_uzakligi_7g_yuzde: num(meta.dist_lo7),
    ath: {
      futures: { fiyat: num(meta.fut_ath_price), kac_gun_once: num(meta.fut_ath_age_days) },
      alpha:   { fiyat: num(meta.alpha_ath_price), kac_gun_once: num(meta.alpha_ath_age_days) },
    },
    konsolidasyon: {
      gun: num(meta.consolidation_days), bant_genisligi_yuzde: num(meta.cons_range_pct),
      uyuyor: !!+meta.is_sleeping,
    },
    sikisma: {
      hacim_kurumasi_orani: num(meta.vol_dryup_ratio),   // 7g/90g hacim; düşük = kuru
      kuru_gun_streak: num(meta.vol_dryup_days),
      bollinger_genislik_yuzdelik: num(meta.bbw_percentile), // 180g içindeki sıra; düşük = sıkışık
    },
    teknik_zaman_dilimleri: tech.map(t => ({
      dilim: t.timeframe,
      rsi14: num(t.rsi14), rsi_ortalama: num(t.rsi_ma),
      rsi_yukari_kesis_kac_bar_once: num(t.rsi_cross_bars_ago),
      ma50: num(t.ma50), ma200: num(t.ma200),
      ma_kesisim_kac_bar_once: num(t.ma_cross_bars_ago),
      ma_kaynagi: t.ma_source,   // '1d' ise bu dilimde MA200 yok, günlükten devralındı
      macd: num(t.macd), macd_sinyal: num(t.macd_signal), macd_histogram: num(t.macd_hist),
    })),
    gecmis_pumplar: events.map(e => ({
      market: e.market, dip: e.trough_date, zirve: e.peak_date,
      kat: num(e.x), gun: num(e.duration_days), hiz: e.speed_class,
      listeleme_gunu_pumpi: !!+e.is_listing_pump,
    })),
    veri_tarihi: meta.last_updated_at || null,
  };
}

// ── Prompt (pozisyonel arg: SABİT metin) ──
const TASK_PROMPT = `Sana stdin üzerinden bir kripto para birimi hakkında JSON formatında teknik veri seti verildi.

Görevin: bu coin hakkında Türkçe, KISA ve ÖZ bir değerlendirme yazmak.
TOPLAM 250-350 KELİMEYİ AŞMA. Uzun yazmak kötüdür; seçici ol.

Önce WebSearch ile güncel bilgi ara (proje ne yapıyor, son haberler). 2 arama yeterli.

Çıktı tam olarak şu başlıklarla ve belirtilen SERT sınırlarla olmalı:

## Proje
En fazla 2 cümle. Ne yapıyor, hangi sektörde.

## Güncel Gelişmeler
En fazla 3 madde. Her madde TEK cümle. Kaynak linkini sadece ilk geçtiği maddede ver; aynı linki tekrar tekrar ekleme.

## Teknik Durum
En fazla 4 madde. Her madde TEK cümle. PARAGRAF YAZMA — madde kullan.
Sayıları tekrar etme, ne anlama geldiklerini söyle. En önemli 4 sinyali seç (ör. RSI kesişimleri, MA dizilimi, MACD, konsolidasyon/hacim); hepsini saymaya çalışma.

## Riskler
En fazla 3 madde, her biri TEK cümle.

## Özet
En fazla 2 cümle.

Kurallar:
- "Al", "sat", "gir", "çık", hedef fiyat gibi işlem tavsiyesi VERME. Durum tespiti sun.
- Madde işareti olarak "-" kullan.
- Metnin en sonuna şu satırı ekle: "_Bu bir yatırım tavsiyesi değildir._"
- Sadece markdown metni döndür; JSON, kod bloğu veya ön açıklama ekleme.
- Veride null olan alanları "veri yok" say, sayı uydurma.`;

// ── Ana akış ──
async function generate(pool, symbol) {
  if (inFlight.has(symbol)) { const e = new Error('Bu coin için üretim zaten sürüyor'); e.status = 409; throw e; }
  const cd = errorCooldown.get(symbol);
  if (cd && Date.now() < cd) { const e = new Error('Hata sonrası bekleme süresi'); e.status = 429; throw e; }
  if (busy) { const e = new Error('Başka bir yorum üretiliyor, birazdan tekrar dene'); e.status = 429; throw e; }

  // Bayrakları await'lerden ÖNCE set et — yoksa iki farklı coin için eşzamanlı
  // iki Claude süreci açılabilir (limit sorgusu sırasında ikinci istek geçerdi).
  busy = true; inFlight.add(symbol);
  const t0 = Date.now();
  try {
    const lim = await limits(pool, symbol);
    if (lim.blocked) { const e = new Error(`Limit: ${lim.blocked}`); e.status = 429; e.limits = lim; throw e; }

    const ctx = await buildContext(pool, symbol);
    if (!ctx) { const e = new Error('Coin bulunamadı'); e.status = 404; throw e; }

    const j = await runClaude(TASK_PROMPT, JSON.stringify(ctx));
    const text = String(j.result || '').trim();

    // CLI auth/limit hatalarında da exit 0 + result JSON döner → is_error şart
    if (j.is_error) {
      errorCooldown.set(symbol, Date.now() + cfg.AI_ERROR_COOLDOWN_MS);
      await insert(pool, symbol, { status: 'error', error: text.slice(0, 250), j, ms: Date.now() - t0 });
      const e = new Error(`Claude hatası: ${text.slice(0, 200)}`); e.status = 502; throw e;
    }
    if (!text) {
      errorCooldown.set(symbol, Date.now() + cfg.AI_ERROR_COOLDOWN_MS);
      await insert(pool, symbol, { status: 'error', error: 'boş yanıt', j, ms: Date.now() - t0 });
      const e = new Error('Claude boş yanıt döndü'); e.status = 502; throw e;
    }

    const id = await insert(pool, symbol, { status: 'ok', comment: text, j, ms: Date.now() - t0 });
    return { id, comment: text, limits: await limits(pool, symbol) };
  } catch (err) {
    if (!err.status) {
      errorCooldown.set(symbol, Date.now() + cfg.AI_ERROR_COOLDOWN_MS);
      try { await insert(pool, symbol, { status: 'error', error: String(err.message).slice(0, 250), ms: Date.now() - t0 }); }
      catch (e2) { /* log kaydı da olmadıysa sessiz geç */ }
      err.status = 502;
    }
    throw err;
  } finally {
    inFlight.delete(symbol); busy = false;
  }
}

async function insert(pool, symbol, { status, comment = null, error = null, j = {}, ms = null }) {
  const u = j.usage || {};
  const [r] = await pool.query(
    `INSERT INTO coin_ai_comments
       (symbol, comment, status, error, model, input_tokens, output_tokens,
        cache_read_tokens, web_search_count, cost_usd, num_turns, duration_ms, session_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [symbol, comment, status, error, cfg.AI_MODEL,
     u.input_tokens ?? null, u.output_tokens ?? null, u.cache_read_input_tokens ?? null,
     countWebSearches(j), j.total_cost_usd ?? null, j.num_turns ?? null,
     ms ?? j.duration_ms ?? null, j.session_id ?? null]);
  return r.insertId;
}

// Bugünün yorumları (Istanbul günü) + limit durumu
async function today(pool, symbol) {
  const [rows] = await pool.query(
    `SELECT id, created_at, comment FROM coin_ai_comments
      WHERE symbol = ? AND status = 'ok' AND created_at >= ${DAY_START_TR}
      ORDER BY created_at DESC`, [symbol]);
  return { comments: rows, limits: await limits(pool, symbol) };
}

module.exports = { generate, today, limits, buildContext };
