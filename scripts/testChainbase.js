// Chainbase tanı aracı — kod canlıya alınmadan önce API sözleşmesini doğrular.
// Bu makinede node olmadığı için holders.js canlı test EDİLEMEDİ; bu script o boşluğu kapatır.
//
// Çalıştır:  node scripts/testChainbase.js            (BSC'den CYS ile dener)
//            node scripts/testChainbase.js FLUID      (tek sembol; kontratı alpha listesinden çözer)
//
// Doğruladıkları:
//   · CHAINBASE_API_KEY okunuyor mu, yetkili mi
//   · /v1/token/top-holders yanıt şekli (wallet_address/amount/usd_value) ve limit=100 çalışıyor mu
//   · `count` alanı TOPLAM holder mı yoksa sayfa boyutu mu  ← koddaki tek varsayım buydu
//   · /v1/address/labels gerçekten ne döndürüyor (şema dokümanda belirsiz)
//   · DexScreener havuz adresleri
//   · Yüzde hesabı tutarlı mı (ilk 100 toplamı <= %100 olmalı)
require('dotenv').config({ path: __dirname + '/../.env' });
const axios = require('axios');
const cfg = require('../lib/config');

const KEY = String(process.env.CHAINBASE_API_KEY || '').trim();
const mask = k => k ? `${k.slice(0, 4)}…${k.slice(-4)} (${k.length} karakter)` : 'YOK';

async function cb(path, params) {
  const res = await axios.get(`${cfg.CHAINBASE_BASE}${path}`, {
    params, timeout: cfg.CHAINBASE_TIMEOUT_MS,
    headers: { 'x-api-key': KEY, 'Accept': 'application/json' },
    validateStatus: () => true,
  });
  return res;
}

(async () => {
  console.log('Chainbase tanı');
  console.log('API key:', mask(KEY));
  if (!KEY) { console.error('\n.env içinde CHAINBASE_API_KEY yok — durduruldu.'); process.exit(1); }

  // ── Kontrat adresini alpha listesinden çöz ──
  const arg = (process.argv[2] || 'CYS').toUpperCase();
  const list = await axios.get(cfg.ALPHA_TOKEN_LIST_URL, { timeout: cfg.HTTP_TIMEOUT_MS });
  const t = ((list.data && list.data.data) || [])
    .filter(x => String(x.symbol || '').toUpperCase() === arg)
    .sort((a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0))[0];
  if (!t) { console.error(`\n${arg} alpha listesinde yok.`); process.exit(1); }

  const chainId = cfg.HOLDER_CHAIN_IDS[t.chainName];
  const total = Number(t.totalSupply || 0);
  console.log(`\nToken : ${arg} · ${t.chainName} (chain_id=${chainId || 'DESTEKLENMİYOR'})`);
  console.log(`Kontrat: ${t.contractAddress}`);
  console.log(`Arz   : toplam=${total.toLocaleString('tr-TR')} dolaşım=${Number(t.circulatingSupply || 0).toLocaleString('tr-TR')}`);
  if (!chainId) { console.error('\nBu zincir Chainbase kapsamında değil (link-only kalmalı).'); process.exit(1); }
  if (!(total > 0)) console.error('UYARI: toplam arz 0/boş — yüzdeler hesaplanamaz!');

  // ── 1) top-holders ──
  console.log('\n── /v1/token/top-holders ──');
  const r = await cb('/v1/token/top-holders',
    { chain_id: chainId, contract_address: t.contractAddress, page: 1, limit: cfg.CHAINBASE_LIMIT });
  console.log(`HTTP ${r.status} · code=${r.data && r.data.code} · message=${r.data && r.data.message}`);
  if (r.status !== 200 || !r.data || Number(r.data.code) !== 0) {
    console.error('Gövde:', JSON.stringify(r.data).slice(0, 400));
    if (r.status === 401 || r.status === 403) console.error('→ API key geçersiz/yetkisiz.');
    if (r.status === 429) console.error('→ Kota/hız limiti.');
    process.exit(1);
  }
  const rows = r.data.data || [];
  console.log(`dönen satır: ${rows.length} (istenen limit ${cfg.CHAINBASE_LIMIT})`);
  console.log(`count=${r.data.count}  next_page=${r.data.next_page}`);
  console.log(`  → count ${Number(r.data.count) > cfg.CHAINBASE_LIMIT
    ? 'limitten BÜYÜK: toplam holder sayısı olarak kullanılabilir ✓'
    : 'limite eşit/küçük: TOPLAM DEĞİL, holders_total null bırakılacak'}`);
  console.log('alanlar:', Object.keys(rows[0] || {}));
  const price = Number(t.price || 0);
  const usdOf = x => (Number(x.usd_value) || 0) > 0 ? Number(x.usd_value) : (price > 0 ? Number(x.amount) * price : null);
  console.log('ilk 3:');
  for (const x of rows.slice(0, 3)) {
    console.log(`  ${x.wallet_address}  amount=${x.amount}  usd_value=${x.usd_value}  → kullanılan USD=${usdOf(x) == null ? 'YOK' : '$' + Math.round(usdOf(x)).toLocaleString('tr-TR')}`);
  }
  // Chainbase'in usd_value'su boş gelebiliyor (CYS/BSC'de 100/100 sıfırdı) → fiyattan hesaplanır
  const zeros = rows.filter(x => !(Number(x.usd_value) > 0)).length;
  console.log(`\nusd_value boş/sıfır: ${zeros}/${rows.length}` +
    (zeros ? `  → alpha listesi fiyatından hesaplanacak (price=${price || 'YOK'})` : ''));
  const over1k = rows.filter(x => (usdOf(x) || 0) >= 1000).length;
  console.log(`$1.000+ cüzdan (ilk ${rows.length} içinde): ${over1k}${over1k >= rows.length ? ' (tavan)' : ''}`);
  if (!price && zeros) console.log('  ✗ fiyat da yok → wallets_over_1k null kalır, bayrak basılmaz');

  // ── YİNELENEN ADRES KONTROLÜ ──
  // Aynı cüzdan iki satırda gelirse bakiyesi iki kez sayılır → derin kohortlar şişer ve
  // ilk 100 toplamı %100'ü aşabilir. buildHolders bunları birleştiriyor; burada teşhis edilir.
  const byAddr = new Map();
  for (const x of rows) {
    const k = String(x.wallet_address || '').toLowerCase();
    byAddr.set(k, (byAddr.get(k) || 0) + 1);
  }
  const dupAddrs = [...byAddr.entries()].filter(([, n]) => n > 1);
  console.log(`\n── yinelenen adres ──`);
  console.log(`benzersiz adres: ${byAddr.size}/${rows.length}` +
    (dupAddrs.length ? `  ✗ ${dupAddrs.length} adres tekrar ediyor` : '  ✓ tekrar yok'));
  for (const [a, n] of dupAddrs.slice(0, 5)) console.log(`   ${a} ×${n}`);

  // ── Yüzde tutarlılığı ──
  const amtOf = x => Number(x.amount) || 0;
  const sum = rows.reduce((s, x) => s + amtOf(x), 0);
  // Birleştirilmiş (yinelenensiz) hâli — üretimde kullanılan değer bu
  const uniq = new Map();
  for (const x of rows) {
    const k = String(x.wallet_address || '').toLowerCase();
    uniq.set(k, (uniq.get(k) || 0) + amtOf(x));
  }
  const uniqAmts = [...uniq.values()].sort((a, b) => b - a);
  const cumU = n => uniqAmts.slice(0, n).reduce((s, v) => s + v, 0) / total * 100;
  const pct = total > 0 ? (sum / total) * 100 : NaN;

  console.log(`\n── kohortlar (payda: toplam arz ${total.toLocaleString('tr-TR')}) ──`);
  console.log(`               ham        birleştirilmiş`);
  for (const n of [5, 10, 25, 50, 100]) {
    const raw = rows.slice(0, n).reduce((s, x) => s + amtOf(x), 0) / total * 100;
    console.log(`  ilk ${String(n).padEnd(4)} %${raw.toFixed(2).padStart(7)}   %${cumU(n).toFixed(2).padStart(7)}`);
  }
  console.log(cumU(100) <= 100.5
    ? '  ✓ tutarlı (birleştirilmiş ilk 100 toplam arzı aşmıyor)'
    : '  ✗ HÂLÂ TUTARSIZ: yinelenen adres sebep değil → totalSupply bayat ya da amount ölçeği farklı');

  // ── BscScan ile karşılaştırma (elle girilen referans) ──
  // Kullanım: BSCSCAN_TOP5=68.81 BSCSCAN_TOP10=80.19 BSCSCAN_TOP100=96.20 node scripts/testChainbase.js SEMBOL
  const ref = { 5: Number(process.env.BSCSCAN_TOP5), 10: Number(process.env.BSCSCAN_TOP10), 100: Number(process.env.BSCSCAN_TOP100) };
  if (Object.values(ref).some(v => v > 0)) {
    console.log('\n── explorer referansıyla fark ──');
    for (const n of [5, 10, 100]) {
      if (!(ref[n] > 0)) continue;
      const bizim = cumU(n), d = bizim - ref[n];
      console.log(`  ilk ${String(n).padEnd(3)} explorer=%${ref[n].toFixed(2)}  bizim=%${bizim.toFixed(2)}  fark=${d >= 0 ? '+' : ''}${d.toFixed(2)}  oran=${(bizim / ref[n]).toFixed(4)}`);
    }
    console.log('  Oranlar BİRBİRİNE YAKINSA payda (totalSupply) hatalı; AYRIŞIYORSA holder seti farklı.');
  } else {
    console.log('\n(explorer karşılaştırması için: BSCSCAN_TOP5=.. BSCSCAN_TOP10=.. BSCSCAN_TOP100=.. ile çalıştır)');
  }

  // ── 2) labels ──
  // CANLI TESTTE 3/3 boş (`data:{}`) döndü → cfg.CHAINBASE_LABEL_TOP_N=0 ile kapatıldı.
  // Burada yine de yoklanır: bir gün dolu gelmeye başlarsa ayarı açmak yeterli.
  console.log(`\n── /v1/address/labels (ilk 3 cüzdan) · üretimde ${cfg.CHAINBASE_LABEL_TOP_N ? 'AÇIK' : 'KAPALI'} ──`);
  let labelHit = 0;
  for (const x of rows.slice(0, 3)) {
    const lr = await cb('/v1/address/labels', { chain_id: chainId, address: x.wallet_address });
    const d = lr.data && lr.data.data;
    const empty = !d || (typeof d === 'object' && !Object.keys(d).length);
    if (!empty) labelHit++;
    console.log(`${x.wallet_address.slice(0, 10)}… HTTP ${lr.status} code=${lr.data && lr.data.code} ${empty ? '(BOŞ)' : ''}`);
    console.log(`   data: ${JSON.stringify(d).slice(0, 220)}`);
    await new Promise(s => setTimeout(s, 400));
  }
  if (labelHit && !cfg.CHAINBASE_LABEL_TOP_N)
    console.log(`  → ${labelHit}/3 etiket DOLU geldi: config'de CHAINBASE_LABEL_TOP_N=10 yapmaya değer.`);

  // ── 3) DexScreener havuzları ──
  console.log('\n── DexScreener havuz adresleri ──');
  try {
    const d = await axios.get(cfg.DEXSCREENER_TOKENS_URL.replace('{ca}', t.contractAddress),
      { timeout: cfg.HTTP_TIMEOUT_MS });
    const pairs = (d.data && d.data.pairs) || [];
    console.log(`${pairs.length} havuz bulundu`);
    const addrs = new Set(pairs.map(p => String(p.pairAddress || '').toLowerCase()));
    for (const p of pairs.slice(0, 4)) console.log(`  ${p.dexId} ${p.pairAddress} likidite=$${Math.round((p.liquidity || {}).usd || 0).toLocaleString('tr-TR')}`);
    const hit = rows.filter(x => addrs.has(String(x.wallet_address || '').toLowerCase()));
    console.log(`ilk ${rows.length} cüzdanın ${hit.length} tanesi havuz adresi ${hit.length ? '✓ (temiz orandan düşülecek)' : ''}`);
  } catch (e) { console.log('DexScreener alınamadı:', e.message); }

  console.log('\nBitti. Yukarıda ✗ yoksa holders.js canlıda çalışmalı.');
})().catch(e => { console.error('\nBEKLENMEYEN HATA:', e.message); process.exit(1); });
