// Holder dağılımı — Chainbase API.
//
// Neden Chainbase: Etherscan `tokenholderlist` PRO-only (~$200/ay); explorer sayfası scrape'i
// denendi ve TERK EDİLDİ (sunucunun Frankfurt datacenter IP'si Cloudflare bot doğrulamasına
// takılıyor, 4/4 explorer 403 — ev IP'sinden 200 dönüyordu, yani ayarla çözülmez). Eski
// scrape kodu commit 5b30704'te. Chainbase düzgün bir API, Cloudflare sorunu yok.
//
// CRON YOK: coin sayfasındaki admin butonu tetikler → coin_holders'a yazılır → veri varsa
// herkese görünür ve AI yorumuna beslenir.
//
// Veri akışı (her biri bağımsız; zenginleştirme başarısız olursa çekirdek yine çalışır):
//   1. Binance alpha listesi  → kontrat adresi, zincir, totalSupply/circulatingSupply (payda)
//   2. Chainbase top-holders  → ilk 100 cüzdan (adres + miktar + USD)          [ÇEKİRDEK]
//   3. DexScreener            → LP havuz adresleri (key'siz)                    [best-effort]
//   4. Chainbase labels       → ilk N cüzdanın etiketi (adres başına 1 çağrı)   [best-effort]
const axios = require('axios');
const cfg = require('./config');

// ── Frenler (aiComment.js deseni) ──
let busy = false;                   // aynı anda tek çekim
const inFlight = new Set();         // sembol bazlı kilit
const errorCooldown = new Map();    // symbol -> ts

const apiKey = () => String(process.env.CHAINBASE_API_KEY || '').trim();

// ── Alpha token listesi (kontrat adresi + zincir + arz kaynağı) ──
let alphaCache = { at: 0, bySymbol: new Map(), byAlphaId: new Map() };

async function loadAlphaList() {
  if (Date.now() - alphaCache.at < cfg.ALPHA_LIST_CACHE_MS && alphaCache.bySymbol.size) return alphaCache;

  const res = await axios.get(cfg.ALPHA_TOKEN_LIST_URL, { timeout: cfg.HTTP_TIMEOUT_MS });
  const rows = (res.data && res.data.data) || [];
  if (!rows.length) throw new Error('alpha token listesi boş döndü');

  // NOT: fullyDelisted'a göre FİLTRELEME YOK — alpha ticaretinden çıkmış coin de zincirde duruyor
  // ve evrenimizin 89'u bu durumda (filtrelenirse evren 223 → 136'ya düşer).
  const bySymbol = new Map(), byAlphaId = new Map();
  for (const t of rows) {
    if (t.alphaId) byAlphaId.set(String(t.alphaId).toUpperCase(), t);
    const s = String(t.symbol || '').toUpperCase();
    if (!s) continue;
    const prev = bySymbol.get(s);
    if (!prev || Number(t.marketCap || 0) > Number(prev.marketCap || 0)) bySymbol.set(s, t);
  }
  alphaCache = { at: Date.now(), bySymbol, byAlphaId };
  return alphaCache;
}

// symbol → { chain, chainId, contract, alphaId, explorer, explorerUrl, canFetch, supply... }
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
  const chainId = cfg.HOLDER_CHAIN_IDS[chain] || null;

  return {
    symbol, chain, chainId, contract: ca,
    alphaId: t.alphaId || null,
    totalSupply: Number(t.totalSupply || 0),
    circulatingSupply: Number(t.circulatingSupply || 0),
    // Chainbase'in usd_value'su CANLI TESTTE hep 0.000000 geldi → USD'yi biz hesaplıyoruz
    price: Number(t.price || 0),
    explorer: exp ? exp.name : null,
    explorerUrl: (exp && ca) ? exp.url.replace('{ca}', ca) : null,
    // Chainbase yalnız EVM; Solana/Sui/TRON link-only kalır
    canFetch: !!(chainId && ca),
  };
}

// ── 1) Chainbase: ilk 100 cüzdan ──
async function chainbaseGet(path, params) {
  const key = apiKey();
  if (!key) { const e = new Error('CHAINBASE_API_KEY tanımlı değil (.env)'); e.status = 500; throw e; }

  let lastErr = null;
  for (let i = 0; i <= cfg.CHAINBASE_RETRIES; i++) {
    try {
      const res = await axios.get(`${cfg.CHAINBASE_BASE}${path}`, {
        params, timeout: cfg.CHAINBASE_TIMEOUT_MS,
        headers: { 'x-api-key': key, 'Accept': 'application/json' },
        validateStatus: () => true,
      });
      if (res.status === 200 && res.data && Number(res.data.code) === 0) return res.data;

      // Chainbase HTTP 200 içinde de hata kodu döndürebiliyor → ikisini de yakala
      const msg = (res.data && (res.data.message || res.data.error)) || `HTTP ${res.status}`;
      lastErr = new Error(`Chainbase ${path}: ${msg}`);
      // 401/403 = key sorunu, 429 = kota — tekrar denemek anlamsız/zararlı
      if (res.status === 401 || res.status === 403) { lastErr.status = 502; break; }
      if (res.status === 429) { lastErr.status = 429; break; }
    } catch (e) { lastErr = e; }
    if (i < cfg.CHAINBASE_RETRIES) await new Promise(r => setTimeout(r, 700 * (i + 1)));
  }
  throw lastErr || new Error(`Chainbase ${path}: bilinmeyen hata`);
}

async function fetchTopHolders(tok) {
  const j = await chainbaseGet('/v1/token/top-holders', {
    chain_id: tok.chainId, contract_address: tok.contract,
    page: 1, limit: cfg.CHAINBASE_LIMIT,
  });
  const rows = Array.isArray(j.data) ? j.data : [];
  if (!rows.length) throw new Error('Chainbase holder listesi boş (kontrat/zincir yanlış olabilir)');
  return { rows, count: Number(j.count) || null };
}

// ── 2) DexScreener: LP havuz adresleri (key yok, best-effort) ──
// Havuzlar cüzdan değildir; ilk sıralarda görünüp konsantrasyonu yapay şişirirler.
async function fetchPoolAddresses(contract) {
  const set = new Set();
  try {
    const res = await axios.get(cfg.DEXSCREENER_TOKENS_URL.replace('{ca}', contract),
      { timeout: cfg.HTTP_TIMEOUT_MS });
    for (const p of (res.data && res.data.pairs) || []) {
      if (p.pairAddress) set.add(String(p.pairAddress).toLowerCase());
    }
  } catch (e) {
    console.error('[holders] DexScreener havuz adresleri alınamadı:', e.message);
  }
  return set;
}

// ── 3) Chainbase labels: adres BAŞINA 1 çağrı → sadece ilk N (best-effort) ──
async function fetchLabels(tok, addresses) {
  const map = new Map();
  for (const addr of addresses) {
    try {
      const j = await chainbaseGet('/v1/address/labels', { chain_id: tok.chainId, address: addr });
      // Şema belirsiz ({data:{address:[{category,tags}]}}) → ne gelirse tüm metinleri topla
      const txt = [];
      const walk = v => {
        if (v == null) return;
        if (typeof v === 'string') { txt.push(v); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(j.data);
      if (txt.length) map.set(addr.toLowerCase(), txt.join(' '));
    } catch (e) {
      // Etiket zenginleştirmesi ASLA çekirdeği düşürmez — logla ve devam et
      console.error(`[holders] etiket alınamadı ${addr.slice(0, 10)}…: ${e.message}`);
    }
  }
  return map;
}

// ── Sınıflandırma ──
function labelKind(address, label, poolSet) {
  const addr = String(address || '').toLowerCase();
  if (cfg.HOLDER_BURN_ADDRS.includes(addr)) return 'burn';
  if (poolSet && poolSet.has(addr)) return 'pool';          // DexScreener LP havuzu — kesin bilgi

  const l = String(label || '').toLowerCase().trim();
  if (!l) return null;
  if (/burn|null address/.test(l)) return 'burn';
  if (cfg.HOLDER_CEX_LABELS.some(k => l.includes(k))) return 'cex';
  if (cfg.HOLDER_POOL_LABELS.some(k => l.includes(k))) return 'pool';
  // ENS/isim servisi adı → şahsi cüzdan, etiketsiz say
  if (cfg.HOLDER_NAME_SUFFIXES.some(sfx => l.endsWith(sfx))) return null;
  return 'other';   // etiketli ama sınıflandırılamadı — perakende saymayız
}

// ── Kohortlar (donut) ──
// Payda = totalSupply (Binance alpha listesi). circulatingSupply DEĞİL: dolaşım rakamı
// beyana dayalı ve oynak; toplam arz zincirden gelir ve explorer'ların gösterdiğiyle uyumlu.
// Kilitli arzın etkisi ayrıca circ_ratio + "kilitli_arz" bayrağıyla anlatılır.
const COHORTS = [
  ['Top 1-5',      0,   5, '#004FEE'],
  ['Top 6-10',     5,  10, '#37D1FE'],
  ['Top 11-25',   10,  25, '#FF7C62'],
  ['Top 26-50',   25,  50, '#5E93FF'],
  ['Top 51-100',  50, 100, '#A967FF'],
];

const fmtUsd = v => {
  v = Number(v) || 0;
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + ' B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(2) + ' M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(2) + ' K';
  return '$' + v.toFixed(2);
};

// Chainbase satırlarını tek tip holder nesnesine çevirir.
// AYRI FONKSİYON olmasının sebebi: bu dikiş bir kez bozuldu (nesne `quantity` ile kuruluyor
// ama kohort hesabı `amount` okuyordu → NaN → JSON'da null → donut boş, "Pay —"). Testin
// üretimle AYNI kurulumu çalıştırabilmesi için dışa açık.
function buildHolders(rows, tok, labelMap = new Map(), poolSet = new Set()) {
  // Aynı adres birden fazla satırda gelirse bakiyesi iki kez sayılır ve kohortlar şişer
  // (ilk 100 toplamının %100'ü aşması bu şekilde olur). Aynı adresleri birleştir.
  const merged = [];
  const seen = new Map();   // lower(addr) -> merged[] indeksi
  for (const r of rows) {
    const key = String(r.wallet_address || '').toLowerCase();
    const amt = Number(r.amount) || 0;
    const usd = Number(r.usd_value) || 0;
    if (seen.has(key)) {
      const t = merged[seen.get(key)];
      t.amount += amt; t.usdRaw += usd; t.dupes++;
      continue;
    }
    seen.set(key, merged.length);
    merged.push({ wallet_address: r.wallet_address, amount: amt, usdRaw: usd, dupes: 0 });
  }
  // Birleştirme sırayı bozabilir (iki parçalı bir cüzdan yukarı çıkabilir) → yeniden sırala
  merged.sort((a, b) => b.amount - a.amount);

  return merged.map((r, i) => {
    const addr = String(r.wallet_address || '');
    const amount = r.amount;
    const label = labelMap.get(addr.toLowerCase()) || null;
    // USD: Chainbase'in usd_value alanı canlı testte hep 0 geldi (CYS/BSC, 100/100 satır).
    // Dolu gelirse ona güven, gelmezse alpha listesindeki anlık fiyattan hesapla.
    const usdRaw = r.usdRaw;
    return {
      rank: i + 1, address: addr, label,
      kind: labelKind(addr, label, poolSet),
      quantity: String(amount),
      amount,
      usd: usdRaw > 0 ? usdRaw : (tok.price > 0 ? amount * tok.price : null),
      pct: tok.totalSupply > 0 ? (amount / tok.totalSupply) * 100 : 0,
      dupes: r.dupes || 0,   // >0 ise bu adres API'den birden fazla satırda gelmişti
    };
  });
}

// Kohortlar `pct` üzerinden toplanır — TEK doğruluk kaynağı. (Eskiden ayrıca ham `amount`
// toplanıp arza bölünüyordu; iki kaynak olunca biri sessizce NaN üretti.)
function computeCohorts(holders) {
  const out = [];
  for (const [name, from, to, color] of COHORTS) {
    const slice = holders.slice(from, to);
    if (!slice.length) continue;
    // USD hiç bilinmiyorsa (fiyat yok) 0 yazıp "$0.00" göstermek yanıltıcı olur → null/"—"
    const known = slice.some(h => h.usd != null && h.usd > 0);
    const usd = known ? slice.reduce((s, h) => s + (h.usd || 0), 0) : null;
    out.push({
      name, color,
      value: slice.reduce((s, h) => s + (Number(h.pct) || 0), 0),
      amountUsd: usd, amountLabel: usd == null ? '—' : fmtUsd(usd),
    });
  }
  // "Outside 100": arzın ilk 100'de olmayan kısmı. Arz verisi tutarsızsa (ilk 100 > %100)
  // negatife düşer → 0'a kırp; tutarsızlık ayrıca `arz_tutarsiz` bayrağıyla bildirilir.
  const top100 = holders.slice(0, 100).reduce((s, h) => s + (Number(h.pct) || 0), 0);
  const rest = Math.max(0, 100 - top100);
  if (rest > 0.0001) out.push({ name: 'Outside 100', value: rest, color: '#DDE2E6', amountUsd: null, amountLabel: '—' });
  return out;
}

function computeRisk(clean5, holders, walletsOver1k, tok) {
  const flags = [];
  let level;
  if (clean5 == null)                            level = null;
  else if (clean5 >= cfg.HOLDER_RISK_VERY_HIGH)  level = 'cok_yuksek';
  else if (clean5 >= cfg.HOLDER_RISK_HIGH)       level = 'yuksek';
  else if (clean5 >= cfg.HOLDER_RISK_MED)        level = 'orta';
  else                                           level = 'dusuk';

  // Tek bağımsız cüzdan tek başına baskınsa bir kademe yükselt: pay 5 cüzdana yayıldığında
  // ortalama görünse de tek elde toplanması daha riskli.
  const top = holders.filter(h => !h.kind)[0];
  if (top && top.pct != null && top.pct >= cfg.HOLDER_DOMINANT_WALLET) {
    flags.push('tek_cuzdan_hakim');
    const order = ['dusuk', 'orta', 'yuksek', 'cok_yuksek'];
    const i = order.indexOf(level);
    if (i >= 0 && i < order.length - 1) level = order[i + 1];
  }

  if (walletsOver1k != null && walletsOver1k < cfg.HOLDER_MIN_REAL_WALLETS)
    flags.push('az_gercek_holder');

  const ratio = tok.totalSupply > 0 ? tok.circulatingSupply / tok.totalSupply : null;
  if (ratio != null && ratio > 0 && ratio < cfg.HOLDER_LOW_CIRC_RATIO) flags.push('kilitli_arz');

  return { level, flags, circRatio: ratio };
}

// ── Ana akış: tek sembolü çek + coin_holders'a yaz ──
async function refreshOne(pool, symbol) {
  if (inFlight.has(symbol)) { const e = new Error('Bu coin için çekim zaten sürüyor'); e.status = 409; throw e; }
  const cd = errorCooldown.get(symbol);
  if (cd && Date.now() < cd) { const e = new Error('Hata sonrası bekleme süresi'); e.status = 429; throw e; }
  if (busy) { const e = new Error('Başka bir holder çekimi sürüyor, birazdan tekrar dene'); e.status = 429; throw e; }

  // Bayrakları await'lerden ÖNCE set et (yoksa iki istek aynı anda geçebilir)
  busy = true; inFlight.add(symbol);
  try {
    const tok = await resolveToken(pool, symbol);
    if (!tok) { const e = new Error('Kontrat adresi bulunamadı (alpha listesinde yok)'); e.status = 404; throw e; }
    if (!tok.canFetch) {
      const e = new Error(`${tok.chain} zincirinde otomatik çekim yok — explorer'dan bak`);
      e.status = 400; e.explorerUrl = tok.explorerUrl; e.chain = tok.chain;
      throw e;
    }
    if (!(tok.totalSupply > 0)) {
      const e = new Error('Toplam arz bilinmiyor — yüzdeler hesaplanamaz');
      e.status = 422; throw e;
    }

    // Tazeleme aralığı freni (kredi tasarrufu)
    const [[prev]] = await pool.query(
      `SELECT fetched_at, TIMESTAMPDIFF(MINUTE, fetched_at, UTC_TIMESTAMP()) AS mins
         FROM coin_holders WHERE symbol = ?`, [symbol]);
    if (prev && prev.fetched_at != null && prev.mins < cfg.HOLDERS_MIN_REFETCH_MIN) {
      const e = new Error(`Çok sık: ${cfg.HOLDERS_MIN_REFETCH_MIN - prev.mins} dk sonra tekrar dene`);
      e.status = 429; throw e;
    }

    // ── Çekirdek ──
    const { rows, count } = await fetchTopHolders(tok);

    // ── Zenginleştirme (paralel; hata çekirdeği düşürmez) ──
    const poolSet = await fetchPoolAddresses(tok.contract);
    const labelMap = await fetchLabels(tok, rows.slice(0, cfg.CHAINBASE_LABEL_TOP_N)
      .map(r => r.wallet_address).filter(Boolean));

    const holders = buildHolders(rows, tok, labelMap, poolSet);
    const cohorts = computeCohorts(holders);
    const cum = n => holders.slice(0, n).reduce((s, h) => s + h.pct, 0);

    // "Temiz" konsantrasyon: etiketli adresleri (CEX/havuz/burn/kurumsal) at,
    // kalan en büyük 5 bağımsız cüzdanın payı. Payda aynı → top5_pct ile kıyaslanabilir.
    const unlabeled = holders.filter(h => !h.kind);
    const clean5 = unlabeled.length ? unlabeled.slice(0, 5).reduce((s, h) => s + h.pct, 0) : null;
    const cexPool = holders.filter(h => h.kind).reduce((s, h) => s + h.pct, 0);

    // $1.000 üstü cüzdan sayısı — yalnız ilk 100 içinden sayılabiliyor; 100 çıkarsa
    // gerçek sayı daha yüksek demektir (tavan), bayrak ona göre kurulur.
    // Fiyat yoksa USD hesaplanamaz → null (yoksa her coin yanlışlıkla "az gerçek holder" olur).
    const hasUsd = holders.some(h => h.usd != null && h.usd > 0);
    const over1k = hasUsd ? holders.filter(h => (h.usd || 0) >= 1000).length : null;
    const capped = over1k != null && over1k >= holders.length;

    const risk = computeRisk(clean5, holders, capped ? null : over1k, tok);
    if (unlabeled.length < 5) risk.flags.push('temiz_top5_eksik');
    // İlk 100 toplam arzı aşıyorsa payda (Binance listesindeki totalSupply) bayat/yanlış
    // demektir → TÜM yüzdeler şişkin. Sessizce kırpmak sorunu gizler, bayrakla görünür yap.
    if (cum(100) > 100.5) risk.flags.push('arz_tutarsiz');
    const dupes = holders.reduce((s, h) => s + (h.dupes || 0), 0);
    if (dupes) {
      risk.flags.push('yinelenen_adres');
      console.warn(`[holders] ${symbol}: Chainbase ${dupes} yinelenen adres satırı döndürdü, birleştirildi`);
    }
    // Hiçbir cüzdan sınıflandırılamadıysa "temiz" oran ham orana eşittir — bunu sakla.
    // (poolSet dolu ama hiçbiri ilk 100'de değilse de etiket YOK demektir.)
    if (!holders.some(h => h.kind)) risk.flags.push('etiket_yok');

    // Chainbase'in `count` alanı sayfa boyutuyla aynıysa toplam holder DEĞİL, sayfa
    // sayısıdır → yanıltmamak için yalnız limitten büyükse toplam kabul et.
    const holdersTotal = (count && count > cfg.CHAINBASE_LIMIT) ? count : null;

    const r4 = v => (v == null ? null : Math.round(v * 10000) / 10000);
    await pool.query(
      `INSERT INTO coin_holders
         (symbol, chain, contract_address, alpha_id, explorer, explorer_url, scrapable,
          top5_pct, top10_pct, top25_pct, top50_pct, top100_pct,
          clean_top5_pct, cex_pool_pct, holders_total,
          total_supply, circulating_supply, circ_ratio, wallets_over_1k, holders_capped,
          concentration_json, tiers_json, depth_json, top_holders_json,
          risk_level, risk_flags, fetched_at, source)
       VALUES (?,?,?,?,?,?,1, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,NULL,NULL,?, ?,?, UTC_TIMESTAMP(), 'chainbase')
       ON DUPLICATE KEY UPDATE
         chain=VALUES(chain), contract_address=VALUES(contract_address), alpha_id=VALUES(alpha_id),
         explorer=VALUES(explorer), explorer_url=VALUES(explorer_url), scrapable=1,
         top5_pct=VALUES(top5_pct), top10_pct=VALUES(top10_pct), top25_pct=VALUES(top25_pct),
         top50_pct=VALUES(top50_pct), top100_pct=VALUES(top100_pct),
         clean_top5_pct=VALUES(clean_top5_pct), cex_pool_pct=VALUES(cex_pool_pct),
         holders_total=VALUES(holders_total), total_supply=VALUES(total_supply),
         circulating_supply=VALUES(circulating_supply), circ_ratio=VALUES(circ_ratio),
         wallets_over_1k=VALUES(wallets_over_1k), holders_capped=VALUES(holders_capped),
         concentration_json=VALUES(concentration_json), top_holders_json=VALUES(top_holders_json),
         risk_level=VALUES(risk_level), risk_flags=VALUES(risk_flags),
         fetched_at=VALUES(fetched_at), source=VALUES(source)`,
      [symbol, tok.chain, tok.contract, tok.alphaId, tok.explorer, tok.explorerUrl,
       r4(cum(5)), r4(cum(10)), r4(cum(25)), r4(cum(50)), r4(cum(100)),
       r4(clean5), r4(cexPool), holdersTotal,
       tok.totalSupply || null, tok.circulatingSupply || null, r4(risk.circRatio),
       over1k, capped ? 1 : 0,
       JSON.stringify(cohorts), JSON.stringify(holders),
       risk.level, risk.flags.join(',') || null]);

    console.log(`[holders] ${symbol} (${tok.chain}/chainbase) cüzdan=${holders.length} ` +
      `top5=%${r4(cum(5))} temiz5=%${r4(clean5)} etiketli=${holders.filter(h => h.kind).length} risk=${risk.level}`);
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

// ── Okuma ──
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
    tiers: parse(row.tiers_json),      // Chainbase top-100'den hesaplanamaz → null
    depth: parse(row.depth_json),      // aynı sebeple null
    topHolders: parse(row.top_holders_json),
    concentration_json: undefined, tiers_json: undefined,
    depth_json: undefined, top_holders_json: undefined,
  };
}

// Coin sayfası için: veri varsa onu, yoksa en azından zincir + explorer linkini döndür.
async function getForCoin(pool, symbol) {
  let row = null;
  try { row = await getOne(pool, symbol); }
  catch (e) { /* coin_holders tablosu yoksa veri yok say */ }

  let tok = null;
  try { tok = await resolveToken(pool, symbol); } catch (e) { /* alpha listesi yoksa link yok */ }

  return {
    data: row,
    chain: (row && row.chain) || (tok && tok.chain) || null,
    canFetch: tok ? tok.canFetch : false,
    explorerUrl: (tok && tok.explorerUrl) || (row && row.explorer_url) || null,
  };
}

module.exports = {
  refreshOne, getOne, getForCoin, resolveToken,
  // tanı scripti + testler için (buildHolders üretimle aynı kurulumu verir)
  fetchTopHolders, fetchPoolAddresses, fetchLabels, labelKind, buildHolders, computeCohorts,
};
