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
// Adres başına 1 çağrı → Chainbase free tier'ın hız limitine çabuk takılıyor.
// Çağrılar arasında bekle; arka arkaya birkaç 429 gelirse bu coin için etiketten vazgeç
// (etiket zaten opsiyonel zenginleştirme; kotayı tüketip yavaşlatmasına değmez).
async function fetchLabels(tok, addresses) {
  const map = new Map();
  let strike = 0;
  for (const addr of addresses) {
    if (strike >= cfg.CHAINBASE_LABEL_MAX_STRIKES) {
      console.warn(`[holders] ${tok.symbol}: hız limiti — etiket çekimi bu coin için durduruldu`);
      break;
    }
    try {
      const j = await chainbaseGet('/v1/address/labels', { chain_id: tok.chainId, address: addr });
      strike = 0;
      // Şekil: { data: { "<adres>": [ {category, tags:[...]}, ... ] } }
      const entries = [];
      for (const v of Object.values((j && j.data) || {})) {
        if (Array.isArray(v)) for (const e of v) if (e && e.category) entries.push(e);
      }
      // Gürültü kategorilerini at — yoksa sıradan bir cüzdan "Early X Holder" yüzünden
      // etiketli sayılıp temiz orandan düşer ve tablo olduğundan iyi görünür.
      const useful = entries.filter(e => !cfg.HOLDER_LABEL_IGNORE_CATEGORIES.includes(e.category));
      if (useful.length) {
        map.set(addr.toLowerCase(),
          useful.map(e => `${e.category} ${(e.tags || []).join(' ')}`).join(' '));
      }
    } catch (e) {
      // Etiket zenginleştirmesi ASLA çekirdeği düşürmez
      if (e.status === 429 || /too many requests/i.test(e.message)) strike++;
      else console.error(`[holders] etiket alınamadı ${addr.slice(0, 10)}…: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, cfg.CHAINBASE_LABEL_DELAY_MS));
  }
  return map;
}

// ── Zincirden bakiye doğrulama ──
// Chainbase'in indeksi derin sıralarda BAYAT: canlı ölçümde #1/#2 zincirle birebir tutarken
// #50 ve #100'ün zincirde bakiyesi 0'dı (cüzdanlar satmış, indeks güncellenmemiş). Bayat
// satırlar birikince ilk 100 toplamı arzı aşıyordu (%108). Bu yüzden Chainbase'i yalnızca
// ADAY LİSTESİ olarak kullanıp bakiyeleri zincirden okuyoruz — RPC'den holder listesi
// çekilemez, ama verilen adresin bakiyesi kesin okunur.
// Public RPC'ler batch'i kısmen reddedebiliyor (hız limiti / 5xx). Sessizce "okunamadı"
// saymak yanıltıcı: bir kez tüm 100 çağrı düşmesine rağmen doğrulama "başarılı" göründü.
// Bu yüzden her parça yeniden denenir ve gerçekten okunamayan sayısı geri bildirilir.
async function rpcBatch(rpc, calls) {
  const out = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += cfg.RPC_BATCH_SIZE) {
    const chunk = calls.slice(i, i + cfg.RPC_BATCH_SIZE);
    const body = chunk.map((c, k) => ({ jsonrpc: '2.0', id: i + k, method: 'eth_call', params: [c, 'latest'] }));
    for (let attempt = 0; attempt <= cfg.RPC_RETRIES; attempt++) {
      try {
        const res = await axios.post(rpc, body, { timeout: cfg.RPC_TIMEOUT_MS });
        let got = 0;
        for (const r of (Array.isArray(res.data) ? res.data : [])) {
          if (r && typeof r.id === 'number' && typeof r.result === 'string') { out[r.id] = r.result; got++; }
        }
        if (got) break;                       // en az bir sonuç geldiyse parça tamam
      } catch (e) { /* aşağıda tekrar denenecek */ }
      if (attempt < cfg.RPC_RETRIES) await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
    }
    if (i + cfg.RPC_BATCH_SIZE < calls.length) await new Promise(r => setTimeout(r, cfg.RPC_CHUNK_DELAY_MS));
  }
  return out;
}

const hexToNum = (hex, dec) => {
  if (!hex || hex === '0x' || hex.length < 3) return null;
  try { return Number(BigInt(hex)) / Math.pow(10, dec); } catch { return null; }
};

// Chainbase satırlarını zincirdeki gerçek bakiyelerle değiştirir.
// Dönen: { rows, decimals, checked, corrected, dropped } — hata olursa rows aynen geri gelir.
async function verifyOnChain(tok, rows) {
  const rpc = cfg.HOLDER_RPC[tok.chain];
  if (!rpc) return { rows, verified: false, reason: 'rpc_yok' };
  try {
    // decimals() + totalSupply() — ikisi de BU kontrattan.
    // totalSupply KRİTİK: Binance alpha listesi köprülenmiş tokenlarda GLOBAL arzı veriyor,
    // oysa cüzdanlar sadece bu zincirdeki kontratın arzını tutar. Global arza bölünce
    // "ilk 100 = %0.5" gibi anlamsız sonuçlar çıkıyordu (0G, ACU, AIGENSYN...).
    const [decHex, supHex] = await rpcBatch(rpc, [
      { to: tok.contract, data: '0x313ce567' },
      { to: tok.contract, data: '0x18160ddd' },
    ]);
    const dec = decHex ? Number(BigInt(decHex)) : 18;
    const chainSupply = hexToNum(supHex, dec);

    const calls = rows.map(r => ({
      to: tok.contract,
      data: '0x70a08231' + String(r.wallet_address || '').replace(/^0x/, '').toLowerCase().padStart(64, '0'),
    }));
    const res = await rpcBatch(rpc, calls);

    let corrected = 0, dropped = 0, unknown = 0;
    const fixed = [];
    for (let i = 0; i < rows.length; i++) {
      const onchain = hexToNum(res[i], dec);
      if (onchain == null) {           // çağrı başarısız → Chainbase değerini koru
        unknown++; fixed.push(rows[i]); continue;
      }
      const cb = Number(rows[i].amount) || 0;
      if (onchain <= 0) { dropped++; continue; }               // artık holder değil
      if (Math.abs(onchain - cb) > Math.max(1, cb * 0.001)) corrected++;
      fixed.push({ ...rows[i], amount: String(onchain) });
    }
    // Çoğunluk okunamadıysa "doğrulandı" demek yanıltıcı olur (bir kez 100/100 okunamazken
    // başarılı görünmüştü) → yarısından fazlası okunamadıysa doğrulanmamış say.
    if (unknown > rows.length / 2)
      return { rows, verified: false, reason: `okunamayan ${unknown}/${rows.length}`, unknown };
    return { rows: fixed, verified: true, decimals: dec, chainSupply, corrected, dropped, unknown };
  } catch (e) {
    console.error(`[holders] ${tok.symbol} zincir doğrulaması yapılamadı: ${e.message}`);
    return { rows, verified: false, reason: e.message };
  }
}

// ── Çok zincirli arz dağılımı ──
// Alpha listesi tek zincir veriyor; token başka zincirlerde de olabilir. CoinGecko'nun
// platform listesi (key'siz, tek çağrı) kontrat adresinden tüm zincirleri veriyor,
// arz ise her zincirden `totalSupply()` ile okunuyor.
let cgCache = { at: 0, byAddr: new Map() };

async function loadCoinGecko() {
  if (Date.now() - cgCache.at < cfg.COINGECKO_CACHE_MS && cgCache.byAddr.size) return cgCache;
  const res = await axios.get(cfg.COINGECKO_LIST_URL, { timeout: 60000 });
  const rows = Array.isArray(res.data) ? res.data : [];
  if (!rows.length) throw new Error('CoinGecko listesi boş');

  // adres → coin (adresler zincirler arası aynı olabilir, o yüzden adres anahtarı yeterli)
  const byAddr = new Map();
  for (const c of rows) {
    const plats = c.platforms || {};
    for (const [p, addr] of Object.entries(plats)) {
      if (!addr) continue;
      byAddr.set(String(addr).toLowerCase(), c);
    }
  }
  cgCache = { at: Date.now(), byAddr };
  console.log(`[holders] CoinGecko platform listesi yüklendi: ${rows.length} coin, ${byAddr.size} adres`);
  return cgCache;
}

// tok → [{chain, contract, supply, supplyPct, supported, explorer, explorerUrl}] arza göre azalan
async function resolveChains(tok) {
  const self = {
    chain: tok.chain, contract: tok.contract,
    supported: !!cfg.HOLDER_CHAIN_IDS[tok.chain],
  };
  let plats = { [tok.chain]: tok.contract };

  try {
    const { byAddr } = await loadCoinGecko();
    const coin = byAddr.get(String(tok.contract || '').toLowerCase());
    if (coin && coin.platforms) {
      for (const [p, addr] of Object.entries(coin.platforms)) {
        const name = cfg.CG_PLATFORM_MAP[p];
        if (name && addr) plats[name] = addr;
      }
    }
  } catch (e) {
    console.error(`[holders] ${tok.symbol} CoinGecko zincir listesi alınamadı: ${e.message}`);
  }

  // Arzı okuyabildiğimiz her zincirden totalSupply çek (EVM; RPC'si olanlar)
  const out = [];
  for (const [chain, contract] of Object.entries(plats)) {
    const rpc = cfg.HOLDER_RPC[chain];
    const exp = cfg.HOLDER_EXPLORERS[chain];
    const row = {
      chain, contract,
      supply: null, supplyPct: null,
      supported: !!cfg.HOLDER_CHAIN_IDS[chain],
      explorer: exp ? exp.name : null,
      explorerUrl: exp ? exp.url.replace('{ca}', contract) : null,
    };
    if (rpc) {
      try {
        const [decHex, supHex] = await rpcBatch(rpc, [
          { to: contract, data: '0x313ce567' },
          { to: contract, data: '0x18160ddd' },
        ]);
        const dec = decHex ? Number(BigInt(decHex)) : 18;
        row.supply = hexToNum(supHex, dec);
        row.decimals = dec;
      } catch (e) { /* okunamadı → supply null */ }
    }
    out.push(row);
  }

  // NOT: zincirlerin toplamı "global arz" DEĞİLDİR — kilitle-bas köprülerde orijindeki
  // kilitli tokenlar hem orada hem hedefte sayılır. Yine de payların KIYASI doğru:
  // hangi zincirin ağırlıklı olduğunu güvenle söyler. Bu yüzden "pay" diyoruz, "arz" değil.
  const total = out.reduce((s, r) => s + (r.supply || 0), 0);
  for (const r of out) r.supplyPct = total > 0 && r.supply != null ? (r.supply / total) * 100 : null;
  out.sort((a, b) => (b.supply || 0) - (a.supply || 0));
  return out;
}

// ── Sınıflandırma ──
function labelKind(address, label, poolSet) {
  const addr = String(address || '').toLowerCase();
  if (cfg.HOLDER_BURN_ADDRS.includes(addr)) return 'burn';
  const known = cfg.HOLDER_KNOWN_ADDRESSES[addr];
  if (known) return known.kind;                             // elle bakımlı altyapı listesi
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
    const known = cfg.HOLDER_KNOWN_ADDRESSES[addr.toLowerCase()];
    const label = (known && known.label) || labelMap.get(addr.toLowerCase()) || null;
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

  // Dolaşım oranı: dolaşım GLOBAL (Binance), payda ise bu zincirdeki kontratın arzı.
  // Köprülenmiş tokenlarda oran 1'i aşabilir — o zaman anlamsızdır, null bırak.
  let ratio = tok.totalSupply > 0 ? tok.circulatingSupply / tok.totalSupply : null;
  if (ratio != null && (ratio <= 0 || ratio > 1)) ratio = null;
  if (ratio != null && ratio < cfg.HOLDER_LOW_CIRC_RATIO) flags.push('kilitli_arz');

  return { level, flags, circRatio: ratio };
}

// ── Tek zincir taraması (DB'ye YAZMAZ) ──
// Chainbase adayları → zincirden bakiye doğrulaması → kohort/risk metrikleri.
// refreshOne (birincil zincir) ve refreshChains (tüm zincirler) bunu ortak kullanır.
async function scanChain(tok) {
  const { rows: rawRows, count } = await fetchTopHolders(tok);
  const chk = await verifyOnChain(tok, rawRows);
  const rows = chk.rows;

  // PAYDA: zincirdeki kontratın kendi totalSupply'ı. Binance'inki köprülenmiş tokenlarda
  // global arzı verdiği için yüzdeleri anlamsızlaştırıyordu (ör. 0G: ilk 100 = %0.5).
  const binanceSupply = tok.totalSupply;
  if (chk.chainSupply > 0) tok.totalSupply = chk.chainSupply;
  const bridged = binanceSupply > 0 && chk.chainSupply > 0 &&
    Math.abs(chk.chainSupply - binanceSupply) / binanceSupply > 0.05;

  if (chk.verified) {
    console.log(`[holders] ${tok.symbol}/${tok.chain} doğrulama: ${rawRows.length} aday → ` +
      `${rows.length} geçerli (düzeltilen ${chk.corrected}, sıfırlanmış ${chk.dropped}, okunamayan ${chk.unknown})`);
  } else {
    console.warn(`[holders] ${tok.symbol}/${tok.chain} zincir doğrulanamadı (${chk.reason}) — Chainbase verisi korundu`);
  }

  // ── Zenginleştirme (hata çekirdeği düşürmez) ──
  const poolSet = await fetchPoolAddresses(tok.contract);
  const labelMap = await fetchLabels(tok, rows.slice(0, cfg.CHAINBASE_LABEL_TOP_N)
    .map(r => r.wallet_address).filter(Boolean));

  const holders = buildHolders(rows, tok, labelMap, poolSet);
  const cohorts = computeCohorts(holders);
  const cum = n => holders.slice(0, n).reduce((s, h) => s + h.pct, 0);

  // "Temiz" konsantrasyon: etiketli adresleri (CEX/havuz/burn/kurumsal) at, kalan en büyük
  // 5 bağımsız cüzdanın payı. Payda aynı → top5_pct ile doğrudan kıyaslanabilir.
  const unlabeled = holders.filter(h => !h.kind);
  const clean5 = unlabeled.length ? unlabeled.slice(0, 5).reduce((s, h) => s + h.pct, 0) : null;
  const cexPool = holders.filter(h => h.kind).reduce((s, h) => s + h.pct, 0);

  // $1.000 üstü cüzdan — yalnız ilk 100 içinden sayılabiliyor; tavana dayanırsa "en az" demek.
  // Fiyat yoksa USD hesaplanamaz → null (yoksa her coin yanlışlıkla "az gerçek holder" olur).
  const hasUsd = holders.some(h => h.usd != null && h.usd > 0);
  const over1k = hasUsd ? holders.filter(h => (h.usd || 0) >= 1000).length : null;
  const capped = over1k != null && over1k >= holders.length;

  const risk = computeRisk(clean5, holders, capped ? null : over1k, tok);
  if (unlabeled.length < 5) risk.flags.push('temiz_top5_eksik');
  if (cum(100) > 100.5) risk.flags.push('arz_tutarsiz');
  if (!chk.verified) risk.flags.push('zincir_dogrulanmadi');
  if (bridged) risk.flags.push('kopru_arz');
  const dupes = holders.reduce((s, h) => s + (h.dupes || 0), 0);
  if (dupes) {
    risk.flags.push('yinelenen_adres');
    console.warn(`[holders] ${tok.symbol}/${tok.chain}: ${dupes} yinelenen adres birleştirildi`);
  }
  if (!holders.some(h => h.kind)) risk.flags.push('etiket_yok');

  // Chainbase `count` sayfa boyutuyla aynıysa toplam holder DEĞİLDİR → yalnız limitten
  // büyükse toplam kabul et. (Bu sayı bakiyesi sıfırlanmışları da içerir, şişkin okunmalı.)
  const holdersTotal = (count && count > cfg.CHAINBASE_LIMIT) ? count : null;
  const r4 = v => (v == null ? null : Math.round(v * 10000) / 10000);

  console.log(`[holders] ${tok.symbol}/${tok.chain} cüzdan=${holders.length} ` +
    `top5=%${r4(cum(5))} temiz5=%${r4(clean5)} etiketli=${holders.filter(h => h.kind).length} risk=${risk.level}`);

  return {
    holders, cohorts, holdersTotal, over1k, capped,
    top5: r4(cum(5)), top10: r4(cum(10)), top25: r4(cum(25)),
    top50: r4(cum(50)), top100: r4(cum(100)),
    clean5: r4(clean5), cexPool: r4(cexPool),
    chainSupply: chk.chainSupply || null,
    circRatio: r4(risk.circRatio),
    riskLevel: risk.level, riskFlags: risk.flags.join(',') || null,
  };
}

// coin_chain_holders'a tek zincirin sonucunu yaz
async function saveChainRow(pool, symbol, ch, m) {
  await pool.query(
    `INSERT INTO coin_chain_holders
       (symbol, chain, contract_address, explorer, explorer_url, total_supply, supply_pct,
        top5_pct, top10_pct, top25_pct, top50_pct, top100_pct, clean_top5_pct, cex_pool_pct,
        holders_total, wallets_over_1k, holders_capped,
        concentration_json, top_holders_json, risk_level, risk_flags, fetched_at, source)
     VALUES (?,?,?,?,?,?,?, ?,?,?,?,?,?,?, ?,?,?, ?,?,?,?, UTC_TIMESTAMP(), 'chainbase')
     ON DUPLICATE KEY UPDATE
       contract_address=VALUES(contract_address), explorer=VALUES(explorer),
       explorer_url=VALUES(explorer_url), total_supply=VALUES(total_supply),
       supply_pct=VALUES(supply_pct),
       top5_pct=VALUES(top5_pct), top10_pct=VALUES(top10_pct), top25_pct=VALUES(top25_pct),
       top50_pct=VALUES(top50_pct), top100_pct=VALUES(top100_pct),
       clean_top5_pct=VALUES(clean_top5_pct), cex_pool_pct=VALUES(cex_pool_pct),
       holders_total=VALUES(holders_total), wallets_over_1k=VALUES(wallets_over_1k),
       holders_capped=VALUES(holders_capped), concentration_json=VALUES(concentration_json),
       top_holders_json=VALUES(top_holders_json), risk_level=VALUES(risk_level),
       risk_flags=VALUES(risk_flags), fetched_at=VALUES(fetched_at), source=VALUES(source)`,
    [symbol, ch.chain, ch.contract, ch.explorer, ch.explorerUrl,
     m.chainSupply ?? ch.supply ?? null, ch.supplyPct ?? null,
     m.top5, m.top10, m.top25, m.top50, m.top100, m.clean5, m.cexPool,
     m.holdersTotal, m.over1k, m.capped ? 1 : 0,
     JSON.stringify(m.cohorts), JSON.stringify(m.holders), m.riskLevel, m.riskFlags]);
}

// ── Ana akış: zincir dağılımı + BİRİNCİL zincirin holder'ları → coin_holders ──
async function refreshOne(pool, symbol, opts = {}) {
  if (inFlight.has(symbol)) { const e = new Error('Bu coin için çekim zaten sürüyor'); e.status = 409; throw e; }
  if (!opts.force) {
    const cd = errorCooldown.get(symbol);
    if (cd && Date.now() < cd) { const e = new Error('Hata sonrası bekleme süresi'); e.status = 429; throw e; }
    if (busy) { const e = new Error('Başka bir holder çekimi sürüyor, birazdan tekrar dene'); e.status = 429; throw e; }
  }

  // Bayrakları await'lerden ÖNCE set et (yoksa iki istek aynı anda geçebilir)
  busy = true; inFlight.add(symbol);
  try {
    const tok = await resolveToken(pool, symbol);
    if (!tok) { const e = new Error('Kontrat adresi bulunamadı (alpha listesinde yok)'); e.status = 404; throw e; }

    // Tazeleme aralığı freni (kredi tasarrufu)
    if (!opts.force) {
      const [[prev]] = await pool.query(
        `SELECT fetched_at, TIMESTAMPDIFF(MINUTE, fetched_at, UTC_TIMESTAMP()) AS mins
           FROM coin_holders WHERE symbol = ?`, [symbol]);
      if (prev && prev.fetched_at != null && prev.mins < cfg.HOLDERS_MIN_REFETCH_MIN) {
        const e = new Error(`Çok sık: ${cfg.HOLDERS_MIN_REFETCH_MIN - prev.mins} dk sonra tekrar dene`);
        e.status = 429; throw e;
      }
    }

    // ── FAZ 1: zincir dağılımı (her zaman) ──
    // Tek zincire bakmak köprülenmiş tokenlarda yanıltıyor; hangi zincirin ağırlıklı
    // olduğunu bilmeden oranlar yorumlanamaz.
    const chains = await resolveChains(tok);
    const primary = chains[0] || null;                       // en yüksek arzlı zincir
    const scanTarget = chains.find(c => c.supported) || null; // holder çekilebilen en yüksek arzlı
    console.log(`[holders] ${symbol} zincirler: ` +
      chains.map(c => `${c.chain} %${c.supplyPct == null ? '?' : c.supplyPct.toFixed(1)}`).join(' · '));

    if (!scanTarget) {
      const e = new Error(`${tok.chain} zincirinde otomatik çekim yok — explorer'dan bak`);
      e.status = 400; e.explorerUrl = (primary && primary.explorerUrl) || tok.explorerUrl;
      e.chain = tok.chain; throw e;
    }

    // Birincil zincirin holder'ları — coin_holders özeti bunu temsil eder
    const chainTok = {
      ...tok, chain: scanTarget.chain, contract: scanTarget.contract,
      chainId: cfg.HOLDER_CHAIN_IDS[scanTarget.chain],
      explorer: scanTarget.explorer, explorerUrl: scanTarget.explorerUrl,
    };
    const m = await scanChain(chainTok);
    await saveChainRow(pool, symbol, scanTarget, m);

    await pool.query(
      `INSERT INTO coin_holders
         (symbol, chain, contract_address, alpha_id, explorer, explorer_url, scrapable,
          top5_pct, top10_pct, top25_pct, top50_pct, top100_pct,
          clean_top5_pct, cex_pool_pct, holders_total,
          total_supply, circulating_supply, circ_ratio, wallets_over_1k, holders_capped,
          concentration_json, tiers_json, depth_json, top_holders_json,
          risk_level, risk_flags, chains_json, primary_chain, chain_count, supply_pct,
          fetched_at, source)
       VALUES (?,?,?,?,?,?,1, ?,?,?,?,?, ?,?,?, ?,?,?,?,?, ?,NULL,NULL,?, ?,?, ?,?,?,?, UTC_TIMESTAMP(), 'chainbase')
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
         chains_json=VALUES(chains_json), primary_chain=VALUES(primary_chain),
         chain_count=VALUES(chain_count), supply_pct=VALUES(supply_pct),
         fetched_at=VALUES(fetched_at), source=VALUES(source)`,
      [symbol, scanTarget.chain, scanTarget.contract, tok.alphaId, scanTarget.explorer, scanTarget.explorerUrl,
       m.top5, m.top10, m.top25, m.top50, m.top100,
       m.clean5, m.cexPool, m.holdersTotal,
       m.chainSupply || null, tok.circulatingSupply || null, m.circRatio,
       m.over1k, m.capped ? 1 : 0,
       JSON.stringify(m.cohorts), JSON.stringify(m.holders),
       m.riskLevel, m.riskFlags,
       JSON.stringify(chains), primary ? primary.chain : null, chains.length,
       scanTarget.supplyPct == null ? null : Math.round(scanTarget.supplyPct * 10000) / 10000]);

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

// ── Tüm zincirlerin holder'ları ("Tüm ağları çek" butonu) ──
// Zincir başına bağımsız: biri patlarsa diğerleri yazılır. Sonuç coin_chain_holders'a
// gider, UI sekmeleri oradan beslenir.
async function refreshChains(pool, symbol, opts = {}) {
  if (inFlight.has(symbol)) { const e = new Error('Bu coin için çekim zaten sürüyor'); e.status = 409; throw e; }
  if (!opts.force && busy) { const e = new Error('Başka bir çekim sürüyor'); e.status = 429; throw e; }

  busy = true; inFlight.add(symbol);
  try {
    const tok = await resolveToken(pool, symbol);
    if (!tok) { const e = new Error('Kontrat adresi bulunamadı'); e.status = 404; throw e; }

    const chains = await resolveChains(tok);
    const targets = chains.filter(c => c.supported);
    if (!targets.length) {
      const e = new Error('Hiçbir zincirde otomatik çekim yok'); e.status = 400;
      e.explorerUrl = chains[0] && chains[0].explorerUrl; throw e;
    }

    const done = [], failed = [];
    for (const ch of targets) {
      try {
        const m = await scanChain({
          ...tok, chain: ch.chain, contract: ch.contract,
          chainId: cfg.HOLDER_CHAIN_IDS[ch.chain],
          explorer: ch.explorer, explorerUrl: ch.explorerUrl,
        });
        await saveChainRow(pool, symbol, ch, m);
        done.push(ch.chain);
      } catch (e) {
        console.error(`[holders] ${symbol}/${ch.chain} çekilemedi: ${e.message}`);
        failed.push({ chain: ch.chain, error: e.message });
      }
    }

    // Zincir dağılımını da tazele (arz değişmiş olabilir)
    const primary = chains[0] || null;
    await pool.query(
      `UPDATE coin_holders SET chains_json=?, primary_chain=?, chain_count=? WHERE symbol=?`,
      [JSON.stringify(chains), primary ? primary.chain : null, chains.length, symbol]);

    console.log(`[holders] ${symbol} tüm zincirler: ok=${done.join(',') || '—'} hata=${failed.length}`);
    return { chains, done, failed, ...(await getAllChains(pool, symbol)) };
  } catch (err) {
    if (!err.status) err.status = 502;
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
    chains: parse(row.chains_json),     // zincir başına arz dağılımı (arza göre sıralı)
    concentration_json: undefined, tiers_json: undefined,
    depth_json: undefined, top_holders_json: undefined, chains_json: undefined,
  };
}

// Zincir sekmeleri: coin_chain_holders satırları, ARZA GÖRE azalan (varsayılan sekme = ilk).
async function getAllChains(pool, symbol) {
  let rows = [];
  try {
    [rows] = await pool.query(
      `SELECT * FROM coin_chain_holders WHERE symbol = ?
        ORDER BY supply_pct IS NULL, supply_pct DESC, total_supply DESC`, [symbol]);
  } catch (e) { /* tablo yoksa boş */ }
  const parse = s => {
    if (s == null) return null;
    if (typeof s !== 'string') return s;
    try { return JSON.parse(s); } catch { return null; }
  };
  return {
    chainRows: rows.map(r => ({
      ...r,
      concentration: parse(r.concentration_json),
      topHolders: parse(r.top_holders_json),
      concentration_json: undefined, top_holders_json: undefined,
    })),
  };
}

// Coin sayfası için: özet + zincir dağılımı + zincir başına holder verisi.
// `chains` holder verisi OLMASA DA dolu gelir (arz dağılımı faz 1'de her zaman çekilir),
// böylece sekmeler ve "en yüksek arzlı zincirin explorer linki" veri gelmeden de çalışır.
async function getForCoin(pool, symbol) {
  let row = null;
  try { row = await getOne(pool, symbol); }
  catch (e) { /* coin_holders tablosu yoksa veri yok say */ }

  let tok = null;
  try { tok = await resolveToken(pool, symbol); } catch (e) { /* alpha listesi yoksa link yok */ }

  const { chainRows } = await getAllChains(pool, symbol);
  const chains = (row && row.chains) || null;
  // Explorer linki EN YÜKSEK ARZLI zincirin olmalı (chains zaten arza göre sıralı)
  const top = chains && chains.length ? chains[0] : null;

  return {
    data: row,
    chain: (row && row.chain) || (tok && tok.chain) || null,
    canFetch: tok ? tok.canFetch : false,
    explorerUrl: (top && top.explorerUrl) || (tok && tok.explorerUrl) || (row && row.explorer_url) || null,
    chains: chains || (tok ? [{
      chain: tok.chain, contract: tok.contract, supply: null, supplyPct: null,
      supported: tok.canFetch, explorer: tok.explorer, explorerUrl: tok.explorerUrl,
    }] : []),
    chainRows,
    alphaChain: tok ? tok.chain : null,   // Binance Alpha'nın işlem gördüğü zincir
  };
}

module.exports = {
  refreshOne, refreshChains, getOne, getForCoin, getAllChains, resolveToken, resolveChains,
  // tanı scripti + testler için (buildHolders üretimle aynı kurulumu verir)
  fetchTopHolders, fetchPoolAddresses, fetchLabels, labelKind, buildHolders, computeCohorts,
  verifyOnChain, scanChain,
};
