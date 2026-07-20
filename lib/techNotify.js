// Teknik Takip telegram bildirimi — her tam refresh (günde 4×) BİTİNCE çağrılır.
// coin_metrics'ten aday süzer (RSI kesişi + golden/MACD), signal_snapshots dedup'ı
// uygular, TECH_TG grubuna/topic'ine tek toplu mesaj atar ve kayıtları source_type
// 'teknik_takip' ile snapshot pipeline'ına düşürür (sadece kayıt; trade guard'ları hariç tutar).
const cfg = require('./config');
const tg = require('./telegram');
const { runCollector, loadFuturesSymbolMap } = require('./snapshotBridge');

const N = (v) => (v === null || v === undefined || v === '') ? null : Number(v);

// Kategori: golden = ma50>ma200 & kesişim ≤ ma_source diliminin eşiği ; macdPos = macd>0
// RSI (rsi_cross_bars_ago ≤ dilim eşiği) zaten aday filtresinde garanti.
function categorize(c) {
  const f = N(c.ma50), s = N(c.ma200), md = N(c.ma_cross_bars_ago);
  const srcTf = c.ma_source || c.timeframe || '1d';
  const lim = (cfg.TIMEFRAMES[srcTf] || cfg.TIMEFRAMES['1d']).maCrossRecentBars;
  const golden = f !== null && s !== null && f > s && md !== null && md <= lim;
  const macdPos = N(c.macd) !== null && N(c.macd) > 0;
  if (!golden && !macdPos) return null;          // sadece RSI → mesaj yok
  if (golden && macdPos)   return 'TAM';          // hepsi pozitif
  return macdPos ? 'RSI+MACD' : 'RSI+GC';
}

// Aynı coin+teknik_takip için: bugün (Istanbul/UTC+3 takvim günü) kaydı var mı,
// son 7 günde (bugün dahil) kaydı var mı?  Türkiye sabit UTC+3 (DST yok) → fixed offset.
async function dedupInfo(pool, binanceSymbol) {
  const [[today]] = await pool.query(
    `SELECT COUNT(*) AS n FROM signal_snapshots
      WHERE symbol = ? AND source_type = 'teknik_takip'
        AND created_at >= CONVERT_TZ(DATE(CONVERT_TZ(UTC_TIMESTAMP(),'+00:00','+03:00')),'+03:00','+00:00')`,
    [binanceSymbol]
  );
  const [[wk]] = await pool.query(
    `SELECT COUNT(*) AS n FROM signal_snapshots
      WHERE symbol = ? AND source_type = 'teknik_takip'
        AND created_at >= (UTC_TIMESTAMP() - INTERVAL 7 DAY)`,
    [binanceSymbol]
  );
  return { today: today.n > 0, week: wk.n > 0 };
}

const CAT_LABEL = { 'TAM': '⭐ TAM (hepsi pozitif)', 'RSI+MACD': 'RSI + MACD', 'RSI+GC': 'RSI + Golden Cross' };
const CAT_SHORT = { 'TAM': '⭐ TAM', 'RSI+MACD': 'RSI+MACD', 'RSI+GC': 'RSI+GC' };
const ORDER = ['TAM', 'RSI+MACD', 'RSI+GC'];
const MAX_LIST = 5;  // bu sayıdan fazla coin varsa detay yerine özet + link
const fmtPrice = (v) => { v = N(v); if (v === null) return '—'; if (v >= 1) return v.toFixed(4); if (v >= 0.01) return v.toFixed(5); return Number(v).toPrecision(4); };
const fmtDist  = (v) => { v = N(v); return v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`; };
const TAB_LINK = () => `[» Teknik Takip sekmesi](${cfg.DASH_URL}/pump.html#teknik)`;

// toSend: [{ c, cat, repeat }]  → telegram mesaj metni.
// ≤ MAX_LIST coin: kategoriye göre gruplu detaylı liste.
// >  MAX_LIST coin: kısa özet + kategori sayıları + panel linki (mesaj şişmesin).
function buildMessage(toSend) {
  const sorted = [...toSend].sort((a, b) => ORDER.indexOf(a.cat) - ORDER.indexOf(b.cat)
    || (N(a.c.rsi_cross_bars_ago) - N(b.c.rsi_cross_bars_ago)));

  const head = `📈 ${sorted.length} coin teknik takibe yakalandı.`;

  if (sorted.length > MAX_LIST) {
    const counts = ORDER.map(cat => {
      const n = sorted.filter(x => x.cat === cat).length;
      return n ? `${CAT_SHORT[cat]}: ${n}` : null;
    }).filter(Boolean);
    return `${head}\n` +
           (counts.length ? counts.join(' · ') + '\n' : '') +
           `Detaylar panelde:\n${TAB_LINK()}\n\n#teknikTakip`;
  }

  let body = '';
  for (const cat of ORDER) {
    const grp = sorted.filter(x => x.cat === cat);
    if (!grp.length) continue;
    body += `\n*${CAT_LABEL[cat]}* (${grp.length})\n`;
    body += grp.map(({ c, repeat }) => {
      const rsi = N(c.rsi14) !== null ? N(c.rsi14).toFixed(1) : '—';
      const rep = repeat ? ' 🔁 _7g içinde tekrar_' : '';
      return `• *${c.symbol}*  RSI ${rsi} · dip ${fmtDist(c.dist_lo7)} · ${fmtPrice(c.last_price)}${rep}\n` +
             `   [coin »](${cfg.DASH_URL}/pump-coin.html?symbol=${c.symbol})`;
    }).join('\n');
    body += '\n';
  }
  return `${head}\n${TAB_LINK()}\n${body}\n#teknikTakip`;
}

// note (VARCHAR 64) — kompakt
function noteFor(cat, c, repeat) {
  const rsi = N(c.rsi14) !== null ? Math.round(N(c.rsi14)) : '-';
  return `teknik_takip ${cat} rsi${rsi}${repeat ? ' tekrar7g' : ''}`.slice(0, 64);
}

async function run(pool) {
  // 1) Adaylar — GÜNLÜK dilimde RSI kesişi son ≤ eşik bar içinde.
  // Evren = coin_tech_signals (TÜM TRADING futures); dist_lo7/last_price alpha
  // coinlerde coin_metrics'ten gelir, diğerlerinde null (mesajda "—" görünür).
  const tf = cfg.DEFAULT_TIMEFRAME;
  const [rows] = await pool.query(
    `SELECT t.symbol, t.timeframe, t.rsi14, t.rsi_ma, t.rsi_cross_bars_ago,
            t.ma50, t.ma200, t.ma_cross_bars_ago, t.ma_source, t.macd,
            cm.dist_lo7, cm.last_price, bft.mcap_usd
       FROM coin_tech_signals t
       LEFT JOIN coin_metrics cm ON cm.symbol = t.symbol
       LEFT JOIN (
         SELECT base_asset, MAX(mcap_usd) AS mcap_usd
         FROM binance_futures_tracking WHERE is_delist = 0 GROUP BY base_asset
       ) bft ON bft.base_asset = t.symbol
      WHERE t.timeframe = ?
        AND t.rsi_cross_bars_ago IS NOT NULL AND t.rsi_cross_bars_ago <= ?`,
    [tf, (cfg.TIMEFRAMES[tf] || {}).rsiCrossMaxBars ?? cfg.RSI_CROSS_MAX_DAYS]
  );

  // 2) Kategorize et (RSI-tek olanları ele)
  const cand = [];
  for (const c of rows) { const cat = categorize(c); if (cat) cand.push({ c, cat }); }
  if (!cand.length) { console.log('[tech-notify] aday yok'); return; }

  // 3) base → binance_symbol map (snapshot symbol'u binance_symbol tutar)
  let symMap;
  try { symMap = await loadFuturesSymbolMap(pool); }
  catch (e) { console.error('[tech-notify] symbol map hatası:', e.message); return; }

  // 4) Dedup + mesaj/kayıt listesi
  const toSend = [];       // { c, cat, repeat, binanceSymbol }
  const snapshotCand = []; // collector'a
  const skipped = [];
  for (const { c, cat } of cand) {
    const binanceSymbol = symMap.get(c.symbol);
    if (!binanceSymbol) { skipped.push(`${c.symbol}(map-yok)`); continue; }
    let info;
    try { info = await dedupInfo(pool, binanceSymbol); }
    catch (e) { console.error(`[tech-notify] ${c.symbol} dedup hatası:`, e.message); continue; }
    if (info.today) { skipped.push(`${c.symbol}(bugün-var)`); continue; }  // aynı gün tekrar yok
    const repeat = info.week;                                              // son 7g'de vardı → not
    toSend.push({ c, cat, repeat, binanceSymbol });
    snapshotCand.push({
      symbol: binanceSymbol, source_type: 'teknik_takip',
      price_change: null, funding_fee: null, note: noteFor(cat, c, repeat),
    });
  }

  console.log(`[tech-notify] aday=${cand.length} gönderilecek=${toSend.length}`
    + (skipped.length ? ` | atlanan: ${skipped.join(', ')}` : ''));
  if (!toSend.length) return;

  // 5) Mesaj (≤5 coin → detaylı liste, >5 coin → özet + link)
  const text = buildMessage(toSend);
  const sent = await tg.sendMessage(text, { chat_id: cfg.TECH_TG_CHAT_ID, message_thread_id: cfg.TECH_TG_THREAD_ID });
  console.log(`[tech-notify] telegram ${sent ? 'gönderildi' : 'BAŞARISIZ'} (${toSend.length} coin${toSend.length > MAX_LIST ? ', özet' : ''}): ${toSend.map(x => x.c.symbol).join(', ')}`);

  // 6) signal_snapshots kaydı (source_type='teknik_takip', sadece kayıt — trade guard'ları hariç tutar)
  await runCollector(snapshotCand, 'tech-notify');
}

module.exports = { run, categorize, buildMessage };
