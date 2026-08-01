// Holder dağılımı — Etherscan ailesi explorer sayfasından tek istekle çekilir.
//
// Neden scrape: Etherscan'in `tokenholderlist` API'si PRO-only (~$200/ay), GeckoTerminal'in
// top_holders ucu 401, Moralis Pro, Bitquery free 10 satır. Explorer sayfası ise key'siz açık.
//
// Neden dayanıklı: HTML tablosu PARSE EDİLMEZ. Sayfa dört hazır JSON bloğunu
// `const X = '[...]';` biçiminde gömüyor; tek regex ile alınıp JSON.parse ediliyor.
//   holdersConcentrationData  → Top 1-5 / 6-10 / 11-25 / 26-50 / 51-100 / Outside 100 (% + USD)
//   holdersTierDistributionData → Whale/Shark/Dolphin/Fish/Crab/Shrimp (holder sayısı + mcap payı)
//   holdersThresholdDepthData → >$10 … >$1M cüzdan sayıları
//   quickExportTokenHolerData → top 25: tam adres + etiket + miktar + USD  ("Holer" typo Etherscan'in)
//
// CRON YOK: coin sayfasındaki admin butonu tetikler. Ban riskine karşı sunucu tarafında
// tek-eşzamanlılık + sembol kilidi + tazeleme aralığı freni var (aiComment.js deseni).
const axios = require('axios');
const cfg = require('./config');

// ── Frenler ──
let busy = false;                   // aynı anda tek scrape
const inFlight = new Set();         // sembol bazlı kilit
const errorCooldown = new Map();    // symbol -> ts

// ── Alpha token listesi (kontrat adresi + zincir kaynağı) ──
let alphaCache = { at: 0, bySymbol: new Map(), byAlphaId: new Map() };

async function loadAlphaList() {
  if (Date.now() - alphaCache.at < cfg.ALPHA_LIST_CACHE_MS && alphaCache.bySymbol.size) return alphaCache;

  const res = await axios.get(cfg.ALPHA_TOKEN_LIST_URL, {
    timeout: cfg.HOLDERS_TIMEOUT_MS,
    headers: { 'User-Agent': cfg.HOLDERS_UA },
  });
  const rows = (res.data && res.data.data) || [];
  if (!rows.length) throw new Error('alpha token listesi boş döndü');

  // NOT: fullyDelisted'a göre FİLTRELEME YOK — alpha ticaretinden çıkmış coin de zincirde duruyor
  // ve evrenimizin 89'u bu durumda (filtrelenirse evren 223 → 136'ya düşer).
  const bySymbol = new Map(), byAlphaId = new Map();
  for (const t of rows) {
    if (t.alphaId) byAlphaId.set(String(t.alphaId).toUpperCase(), t);
    const s = String(t.symbol || '').toUpperCase();
    if (!s) continue;
    // aynı sembolden birden fazla kayıt olabilir → en yüksek marketCap kazanır
    const prev = bySymbol.get(s);
    if (!prev || Number(t.marketCap || 0) > Number(prev.marketCap || 0)) bySymbol.set(s, t);
  }
  alphaCache = { at: Date.now(), bySymbol, byAlphaId };
  return alphaCache;
}

// symbol → { chain, contract, alphaId, liquidity, marketCap } (+ explorer bilgisi)
async function resolveToken(pool, symbol) {
  const [[m]] = await pool.query('SELECT alpha_id FROM coin_metrics WHERE symbol = ?', [symbol]);
  const { bySymbol, byAlphaId } = await loadAlphaList();

  let t = null;
  if (m && m.alpha_id) t = byAlphaId.get(String(m.alpha_id).toUpperCase()) || null;
  if (!t) t = bySymbol.get(symbol.toUpperCase()) || null;
  if (!t) return null;

  const chain = t.chainName || null;
  const ca = t.contractAddress || null;
  const exp = cfg.HOLDER_EXPLORERS[chain] || null;
  const linkOnly = cfg.HOLDER_LINK_ONLY[chain] || null;

  return {
    symbol,
    chain,
    contract: ca,
    alphaId: t.alphaId || null,
    liquidity: Number(t.liquidity || 0),
    marketCap: Number(t.marketCap || 0),
    scrapable: !!(exp && ca),
    explorer: exp ? exp.name : null,
    explorerUrl: ca
      ? (exp ? `${exp.host}/token/${ca}#balances`
             : (linkOnly ? linkOnly.replace('{ca}', ca) : null))
      : null,
  };
}

// ── Sayfayı çek + 4 JSON bloğunu çıkar ──
const BLOCKS = [
  'holdersConcentrationData',
  'holdersTierDistributionData',
  'holdersThresholdDepthData',
  'quickExportTokenHolerData',
];

async function fetchAndParse(tok) {
  const host = cfg.HOLDER_EXPLORERS[tok.chain].host;
  const url = `${host}/token/generic-tokenholders2?m=normal&a=${tok.contract}&p=1`;

  let html = null, lastErr = null;
  for (let i = 0; i <= cfg.HOLDERS_RETRIES; i++) {
    try {
      const res = await axios.get(url, {
        timeout: cfg.HOLDERS_TIMEOUT_MS,
        headers: { 'User-Agent': cfg.HOLDERS_UA, 'Referer': `${host}/`, 'Accept': 'text/html' },
        // 403 Cloudflare gövdesini de görebilmek için status'u kendimiz değerlendiriyoruz
        validateStatus: () => true,
      });
      if (res.status === 200 && typeof res.data === 'string') { html = res.data; break; }
      lastErr = new Error(`explorer HTTP ${res.status}`);
    } catch (e) { lastErr = e; }
    if (i < cfg.HOLDERS_RETRIES) await new Promise(r => setTimeout(r, 800 * (i + 1)));
  }
  if (!html) throw new Error(`${tok.explorer} erişilemedi: ${lastErr ? lastErr.message : 'bilinmeyen'}`);
  if (/just a moment|cf-challenge|attention required/i.test(html))
    throw new Error(`${tok.explorer} Cloudflare doğrulaması istedi`);

  const out = {};
  for (const name of BLOCKS) {
    // const X = '[...]';  → tek tırnak içindeki JSON'u al
    const re = new RegExp(`(?:var|const|let)\\s+${name}\\s*=\\s*'(\\[[\\s\\S]*?\\])'\\s*;`);
    const m = html.match(re);
    if (!m) continue;
    try { out[name] = JSON.parse(m[1]); } catch (e) { /* bozuk blok → eksik say */ }
  }

  // Dördü birden zorunlu: kısmi veri DB'ye yazılmasın, sessiz bozulma yerine görünür hata olsun.
  const missing = BLOCKS.filter(b => !Array.isArray(out[b]));
  if (missing.length)
    throw new Error(`sayfa yapısı beklenenden farklı — eksik blok: ${missing.join(', ')}`);

  return out;
}

// ── Yardımcılar ──
const num = v => {
  const n = Number(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function labelKind(address, label) {
  const addr = String(address || '').toLowerCase();
  if (cfg.HOLDER_BURN_ADDRS.includes(addr)) return 'burn';
  const l = String(label || '').toLowerCase().trim();
  if (!l) return null;
  if (/burn|null address/.test(l)) return 'burn';
  if (cfg.HOLDER_CEX_LABELS.some(k => l.includes(k))) return 'cex';
  if (cfg.HOLDER_POOL_LABELS.some(k => l.includes(k))) return 'pool';
  // ENS/isim servisi adı → şahsi cüzdan, etiketsiz say (bkz. HOLDER_NAME_SUFFIXES)
  if (cfg.HOLDER_NAME_SUFFIXES.some(sfx => l.endsWith(sfx))) return null;
  return 'other';   // etiketli ama sınıflandırılamadı — perakende saymayız, clean5'ten düşer
}

// Explorer'ın yüzde kolonu bozuk geliyor (hep "0.0000%") → paylar USD'den hesaplanır.
//
// Payda neden top-25'in KENDİ toplamı: concentration bloğunun amountUsd'si ile top-25
// listesinin USD'si aynı değerlemeyi kullanmıyor (COLLECT'te concentration Top1-5=$125.41M
// iken listede rank1 tek başına $125.16M + rank2-5 $17.0M = $142.2M). concentration
// toplamına bölmek payları şişirip %104 gibi imkânsız sonuç veriyordu.
// Çözüm: her cüzdanın top-25 içindeki payını al, sonra top25_pct'e demirle. Böylece
// paylar tanım gereği toplamda top25_pct eder ve hiçbir zaman onu aşamaz.
function buildHolders(raw, top25Pct) {
  const sumUsd = raw.reduce((s, r) => s + num(r[5]), 0);
  return raw.map(r => {
    const usd = num(r[5]);
    return {
      rank: Number(r[0]) || null,
      address: String(r[1] || ''),
      label: r[2] || null,
      kind: labelKind(r[1], r[2]),
      quantity: String(r[3] || ''),
      usd,
      pct: sumUsd > 0 ? (usd / sumUsd) * top25Pct : null,
    };
  });
}

function computeRisk(clean5, holders, depth, tok) {
  const flags = [];
  let level;
  if (clean5 == null)                            level = null;
  else if (clean5 >= cfg.HOLDER_RISK_VERY_HIGH)  level = 'cok_yuksek';
  else if (clean5 >= cfg.HOLDER_RISK_HIGH)       level = 'yuksek';
  else if (clean5 >= cfg.HOLDER_RISK_MED)        level = 'orta';
  else                                           level = 'dusuk';

  // Tek etiketsiz cüzdan tek başına baskınsa seviyeyi bir kademe yükselt: clean_top5
  // 5 cüzdana yayıldığında ortalama görünse de, tek cüzdanda toplanması daha riskli.
  const top = holders.filter(h => !h.kind)[0];
  if (top && top.pct != null && top.pct >= cfg.HOLDER_DOMINANT_WALLET) {
    flags.push('tek_cuzdan_hakim');
    const order = ['dusuk', 'orta', 'yuksek', 'cok_yuksek'];
    const i = order.indexOf(level);
    if (i >= 0 && i < order.length - 1) level = order[i + 1];
  }

  const over1k = depth.find(d => /\$1k$/i.test(String(d.name || '')));
  const realWallets = over1k && over1k.custom ? Number(over1k.custom.rawCount) : null;
  if (realWallets != null && realWallets < cfg.HOLDER_MIN_REAL_WALLETS) flags.push('az_gercek_holder');

  if (tok.marketCap > 0 && tok.liquidity / tok.marketCap < cfg.HOLDER_LOW_LIQ_RATIO)
    flags.push('dusuk_likidite');

  return { level, flags, realWallets };
}

// ── Ana akış: tek sembolü çek + coin_holders'a yaz ──
async function scrapeOne(pool, symbol) {
  if (inFlight.has(symbol)) { const e = new Error('Bu coin için çekim zaten sürüyor'); e.status = 409; throw e; }
  const cd = errorCooldown.get(symbol);
  if (cd && Date.now() < cd) { const e = new Error('Hata sonrası bekleme süresi'); e.status = 429; throw e; }
  if (busy) { const e = new Error('Başka bir holder çekimi sürüyor, birazdan tekrar dene'); e.status = 429; throw e; }

  // Bayrakları await'lerden ÖNCE set et (aiComment.js'teki aynı yarış koşulu)
  busy = true; inFlight.add(symbol);
  try {
    const tok = await resolveToken(pool, symbol);
    if (!tok) { const e = new Error('Kontrat adresi bulunamadı (alpha listesinde yok)'); e.status = 404; throw e; }
    if (!tok.scrapable) {
      const e = new Error(`${tok.chain} zincirinde otomatik çekim yok — explorer'dan bak`);
      e.status = 400; e.explorerUrl = tok.explorerUrl; e.chain = tok.chain;
      throw e;
    }

    // Tazeleme aralığı freni (ban riski) — DB'deki son çekim zamanına bakar
    const [[prev]] = await pool.query(
      `SELECT fetched_at, TIMESTAMPDIFF(MINUTE, fetched_at, UTC_TIMESTAMP()) AS mins
         FROM coin_holders WHERE symbol = ?`, [symbol]);
    if (prev && prev.fetched_at != null && prev.mins < cfg.HOLDERS_MIN_REFETCH_MIN) {
      const e = new Error(`Çok sık: ${cfg.HOLDERS_MIN_REFETCH_MIN - prev.mins} dk sonra tekrar dene`);
      e.status = 429; throw e;
    }

    const b = await fetchAndParse(tok);
    const conc = b.holdersConcentrationData;
    const tiers = b.holdersTierDistributionData;
    const depth = b.holdersThresholdDepthData;

    const pctOf = n => {
      const row = conc.find(c => c.name === n);
      return row ? Number(row.value) : 0;
    };
    const top5 = pctOf('Top 1-5');
    const top10 = top5 + pctOf('Top 6-10');
    const top25 = top10 + pctOf('Top 11-25');

    const holders = buildHolders(b.quickExportTokenHolerData, top25);

    // "Temiz" konsantrasyon: ETİKETLİ adresleri (CEX / havuz / burn / diğer kurumsal) at,
    // kalan en büyük 5 etiketsiz cüzdanın payı. Payda top5_pct ile aynı (toplam arz) →
    // ikisi doğrudan kıyaslanabilir.
    const unlabeled = holders.filter(h => !h.kind);
    const clean5 = unlabeled.length
      ? unlabeled.slice(0, 5).reduce((s, h) => s + (h.pct || 0), 0)
      : null;
    // Etiketli TOPLAM pay — 'other' de dahil (ör. "InstaDApp: Treasury", "Robinhood 5":
    // borsa değil ama bağımsız perakende cüzdanı da değil). clean5 bunları zaten dışlıyor;
    // burada da saymazsak hiçbir kovada görünmezlerdi.
    const cexPool = holders
      .filter(h => h.kind)
      .reduce((s, h) => s + (h.pct || 0), 0);

    const holdersTotal = tiers.reduce(
      (s, t) => s + Number((t.custom && t.custom.holders) || 0), 0) || null;

    const risk = computeRisk(clean5, holders, depth, tok);
    if (unlabeled.length < 5) risk.flags.push('temiz_top5_eksik');  // top25'in çoğu etiketli

    const r4 = v => (v == null ? null : Math.round(v * 10000) / 10000);
    await pool.query(
      `INSERT INTO coin_holders
         (symbol, chain, contract_address, alpha_id, explorer, explorer_url, scrapable,
          top5_pct, top10_pct, top25_pct, clean_top5_pct, cex_pool_pct, holders_total,
          concentration_json, tiers_json, depth_json, top_holders_json,
          risk_level, risk_flags, fetched_at, source)
       VALUES (?,?,?,?,?,?,1, ?,?,?,?,?,?, ?,?,?,?, ?,?, UTC_TIMESTAMP(), ?)
       ON DUPLICATE KEY UPDATE
         chain=VALUES(chain), contract_address=VALUES(contract_address), alpha_id=VALUES(alpha_id),
         explorer=VALUES(explorer), explorer_url=VALUES(explorer_url), scrapable=1,
         top5_pct=VALUES(top5_pct), top10_pct=VALUES(top10_pct), top25_pct=VALUES(top25_pct),
         clean_top5_pct=VALUES(clean_top5_pct), cex_pool_pct=VALUES(cex_pool_pct),
         holders_total=VALUES(holders_total),
         concentration_json=VALUES(concentration_json), tiers_json=VALUES(tiers_json),
         depth_json=VALUES(depth_json), top_holders_json=VALUES(top_holders_json),
         risk_level=VALUES(risk_level), risk_flags=VALUES(risk_flags),
         fetched_at=VALUES(fetched_at), source=VALUES(source)`,
      [symbol, tok.chain, tok.contract, tok.alphaId, tok.explorer, tok.explorerUrl,
       r4(top5), r4(top10), r4(top25), r4(clean5), r4(cexPool), holdersTotal,
       JSON.stringify(conc), JSON.stringify(tiers), JSON.stringify(depth), JSON.stringify(holders),
       risk.level, risk.flags.join(',') || null, tok.explorer]);

    console.log(`[holders] ${symbol} (${tok.chain}/${tok.explorer}) top5=%${r4(top5)} temiz5=%${r4(clean5)} risk=${risk.level}`);
    return await getOne(pool, symbol);
  } catch (err) {
    if (!err.status || err.status >= 500) {
      errorCooldown.set(symbol, Date.now() + cfg.HOLDERS_ERROR_COOLDOWN_MS);
      if (!err.status) err.status = 502;
    }
    throw err;
  } finally {
    inFlight.delete(symbol); busy = false;
  }
}

// ── Okuma: DB satırı + (satır yoksa bile) zincir/link bilgisi ──
// JSON kolonları parse edilmiş hâlde döner; kolon LONGTEXT olduğu için sürücü string veriyor.
async function getOne(pool, symbol) {
  const [[row]] = await pool.query('SELECT * FROM coin_holders WHERE symbol = ?', [symbol]);
  if (!row) return null;
  const parse = s => {
    if (s == null) return null;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return null; }
  };
  return {
    ...row,
    concentration: parse(row.concentration_json),
    tiers: parse(row.tiers_json),
    depth: parse(row.depth_json),
    topHolders: parse(row.top_holders_json),
    concentration_json: undefined, tiers_json: undefined,
    depth_json: undefined, top_holders_json: undefined,
  };
}

// Coin sayfası için: veri varsa onu, yoksa en azından zincir + explorer linkini döndür.
// (link-only zincirlerde kart yalnız "Explorer'da aç" butonunu gösterir)
async function getForCoin(pool, symbol) {
  const row = await getOne(pool, symbol);
  let tok = null;
  try { tok = await resolveToken(pool, symbol); } catch (e) { /* alpha listesi yoksa link yok */ }
  return {
    data: row,
    chain: (row && row.chain) || (tok && tok.chain) || null,
    scrapable: tok ? tok.scrapable : !!(row && row.scrapable),
    explorerUrl: (tok && tok.explorerUrl) || (row && row.explorer_url) || null,
  };
}

module.exports = { scrapeOne, getOne, getForCoin, resolveToken, fetchAndParse, labelKind };
