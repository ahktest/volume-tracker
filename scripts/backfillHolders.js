// Holder dağılımı — TOPLU tek seferlik çekim (alpha ∩ futures evreni).
//
// Sunucudaki buton coin başına çalışır; bu script tüm evreni sırayla gezer. Cron DEĞİL,
// elle çalıştırılır. Kendi sürecinde sırayla çalıştığı için sunucunun 30 dk tazeleme
// frenini `force` ile atlar (o fren tek tek tıklamalar içindir).
//
// Çalıştır:
//   node scripts/backfillHolders.js                  # eksik/eski olanları çek
//   node scripts/backfillHolders.js --force          # hepsini yeniden çek
//   node scripts/backfillHolders.js --dry            # hiçbir şey çekme, planı göster
//   node scripts/backfillHolders.js --chain BSC      # tek zincir
//   node scripts/backfillHolders.js --only GRVT,CYS  # belirli semboller
//   node scripts/backfillHolders.js --limit 20       # ilk N coin (deneme için)
//   node scripts/backfillHolders.js --max-age 48     # bu saatten eski olanları tazele (varsayılan 24)
//   node scripts/backfillHolders.js --delay 1500     # coinler arası ms (varsayılan 800)
//   node scripts/backfillHolders.js --no-labels      # etiket çekme (2× hızlı, hız limiti yemez)
//
// Ctrl+C ile güvenle durdurulabilir: her coin tek tek DB'ye yazılır, tekrar çalıştırınca
// kaldığı yerden devam eder (--force verilmedikçe taze olanları atlar).
require('dotenv').config({ path: __dirname + '/../.env' });
const mysql = require('mysql2/promise');
const cfg = require('../lib/config');
const scan = require('../lib/scan');
const holders = require('../lib/holders');

// ── Argümanlar ──
const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OPT = {
  force:  has('--force'),
  dry:    has('--dry'),
  chain:  val('--chain', null),
  only:   val('--only', null),
  limit:  Number(val('--limit', 0)) || 0,
  maxAge: Number(val('--max-age', 24)),      // saat
  delay:  Number(val('--delay', 800)),       // ms
  noLabels: has('--no-labels'),
};

// Etiket çekimi coin başına 10 ekstra Chainbase çağrısı → hız limitine takılıyor ve süreyi
// ~2 katına çıkarıyor. Toplu çekimde kapatılabilsin (kohort/risk hesabı etkilenmez, yalnız
// "temiz ilk 5" ham orana eşitlenir ve `etiket_yok` bayrağı düşer).
if (OPT.noLabels) cfg.CHAINBASE_LABEL_TOP_N = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pad = (s, n) => String(s).padEnd(n);
const hhmm = sec => `${Math.floor(sec / 60)}dk ${Math.round(sec % 60)}sn`;

let stop = false;
process.on('SIGINT', () => {
  if (stop) process.exit(1);            // ikinci Ctrl+C = hemen çık
  stop = true;
  console.log('\n\n⏸  Durduruluyor — bu coin bitince çıkılacak (tekrar Ctrl+C = hemen çık)…');
});

(async () => {
  if (!String(process.env.CHAINBASE_API_KEY || '').trim()) {
    console.error('.env içinde CHAINBASE_API_KEY yok — durduruldu.');
    process.exit(1);
  }

  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
    connectionLimit: 4,
  });

  try {
    // ── Evren ──
    const universe = await scan.getUniverse(pool);
    console.log(`\nHolder verisi toplu çekim — evren: ${universe.length} coin (alpha ∩ TRADING futures)\n`);

    // Zincir/kontrat çözümü (alpha listesi süreç içinde cache'lenir → tek HTTP çağrısı)
    const resolved = [];
    for (const c of universe) {
      let tok = null;
      try { tok = await holders.resolveToken(pool, c.symbol); }
      catch (e) { /* alpha listesi hatası aşağıda raporlanır */ }
      resolved.push({ symbol: c.symbol, tok });
    }

    const supported = resolved.filter(r => r.tok && r.tok.canFetch);
    const linkOnly  = resolved.filter(r => r.tok && !r.tok.canFetch);
    const unknown   = resolved.filter(r => !r.tok);

    const byChain = arr => {
      const m = {};
      for (const r of arr) { const k = (r.tok && r.tok.chain) || '?'; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');
    };
    console.log(`  Chainbase kapsamında : ${pad(supported.length, 4)} ${byChain(supported)}`);
    console.log(`  link-only (atlanacak): ${pad(linkOnly.length, 4)} ${byChain(linkOnly)}`);
    if (unknown.length) console.log(`  kontrat çözülemedi   : ${pad(unknown.length, 4)} ${unknown.map(r => r.symbol).join(', ')}`);

    // ── Filtreler ──
    let list = supported;
    if (OPT.chain) list = list.filter(r => r.tok.chain === OPT.chain);
    if (OPT.only) {
      const want = new Set(OPT.only.toUpperCase().split(',').map(s => s.trim()));
      list = list.filter(r => want.has(r.symbol.toUpperCase()));
    }

    // Taze olanları atla (--force yoksa)
    let skippedFresh = 0;
    if (!OPT.force) {
      const [rows] = await pool.query(
        `SELECT symbol FROM coin_holders
          WHERE fetched_at IS NOT NULL
            AND TIMESTAMPDIFF(HOUR, fetched_at, UTC_TIMESTAMP()) < ?`, [OPT.maxAge]);
      const fresh = new Set(rows.map(r => r.symbol));
      const before = list.length;
      list = list.filter(r => !fresh.has(r.symbol));
      skippedFresh = before - list.length;
    }
    if (OPT.limit) list = list.slice(0, OPT.limit);

    console.log(`\n  çekilecek: ${list.length}` +
      (skippedFresh ? `  (son ${OPT.maxAge} saatte çekilmiş ${skippedFresh} coin atlandı — hepsini istiyorsan --force)` : '') +
      `\n  ayarlar  : gecikme ${OPT.delay}ms · etiket çağrısı ${cfg.CHAINBASE_LABEL_TOP_N}/coin` +
      `\n  tahmini Chainbase kredisi: ~${list.length * (1 + cfg.CHAINBASE_LABEL_TOP_N)} çağrı\n`);

    if (OPT.dry) {
      console.log('--dry: hiçbir şey çekilmedi. Çekilecekler:');
      for (const r of list) console.log(`  ${pad(r.symbol, 12)} ${r.tok.chain}`);
      await pool.end(); return;
    }
    if (!list.length) { console.log('Yapacak iş yok.'); await pool.end(); return; }

    // ── Döngü ──
    const t0 = Date.now();
    const okList = [], errList = [];
    for (let i = 0; i < list.length; i++) {
      if (stop) break;
      const { symbol, tok } = list[i];
      const head = `[${String(i + 1).padStart(3)}/${list.length}] ${pad(symbol, 12)} ${pad(tok.chain, 9)}`;
      const ts = Date.now();
      try {
        const row = await holders.refreshOne(pool, symbol, { force: true });
        const secs = ((Date.now() - ts) / 1000).toFixed(1);
        const f = row.risk_flags ? ` [${row.risk_flags}]` : '';
        console.log(`${head} top5=%${Number(row.top5_pct).toFixed(1)} ` +
          `temiz5=%${row.clean_top5_pct == null ? '—' : Number(row.clean_top5_pct).toFixed(1)} ` +
          `ilk100=%${Number(row.top100_pct).toFixed(1)} ${pad(row.risk_level || '—', 11)}${secs}sn${f}`);
        okList.push(row);
      } catch (e) {
        console.log(`${head} ✗ ${e.message}`);
        errList.push({ symbol, chain: tok.chain, error: e.message });
      }
      if (i < list.length - 1 && !stop) await sleep(OPT.delay);
    }

    // ── Özet ──
    const secs = (Date.now() - t0) / 1000;
    console.log(`\n${'─'.repeat(72)}`);
    console.log(`BİTTİ${stop ? ' (kullanıcı durdurdu)' : ''}  ok=${okList.length}  hata=${errList.length}  süre=${hhmm(secs)}`);

    if (errList.length) {
      console.log(`\nHatalar (${errList.length}):`);
      const groups = {};
      for (const e of errList) {
        const key = e.error.slice(0, 70);
        (groups[key] = groups[key] || []).push(e.symbol);
      }
      for (const [msg, syms] of Object.entries(groups)) {
        console.log(`  ${syms.length}×  ${msg}`);
        console.log(`       ${syms.slice(0, 12).join(', ')}${syms.length > 12 ? ` … +${syms.length - 12}` : ''}`);
      }
    }

    if (okList.length) {
      // Veri kalitesi — bayrakların dağılımı
      const flagCount = {};
      for (const r of okList) for (const f of String(r.risk_flags || '').split(',').filter(Boolean))
        flagCount[f] = (flagCount[f] || 0) + 1;
      if (Object.keys(flagCount).length) {
        console.log('\nBayraklar:');
        for (const [f, n] of Object.entries(flagCount).sort((a, b) => b[1] - a[1]))
          console.log(`  ${pad(f, 22)} ${n} coin`);
      }

      // En konsantre coinler — asıl aradığımız sinyal
      const ranked = okList.filter(r => r.clean_top5_pct != null)
        .sort((a, b) => Number(b.clean_top5_pct) - Number(a.clean_top5_pct));
      console.log(`\nEn yüksek konsantrasyon (temiz ilk 5 — CEX/havuz düşülmüş):`);
      for (const r of ranked.slice(0, 15)) {
        console.log(`  ${pad(r.symbol, 12)} ${pad(r.chain, 9)} temiz5=%${Number(r.clean_top5_pct).toFixed(1)}` +
          `  ham5=%${Number(r.top5_pct).toFixed(1)}  ${r.risk_level}`);
      }
      const lvl = {};
      for (const r of okList) lvl[r.risk_level || '—'] = (lvl[r.risk_level || '—'] || 0) + 1;
      console.log('\nRisk dağılımı: ' + Object.entries(lvl).map(([k, v]) => `${k}=${v}`).join(' · '));
    }

    // ── Kapsanamayan zincirler (bir sonraki adımın planı için) ──
    if (linkOnly.length) {
      const m = {};
      for (const r of linkOnly) (m[r.tok.chain] = m[r.tok.chain] || []).push(r.symbol);
      console.log(`\n${'─'.repeat(72)}`);
      console.log(`ÇEKİLEMEYEN ZİNCİRLER (${linkOnly.length} coin) — Chainbase EVM-only, bunlar link-only:`);
      for (const [chain, syms] of Object.entries(m).sort((a, b) => b[1].length - a[1].length)) {
        console.log(`  ${pad(chain, 10)} ${String(syms.length).padStart(3)} coin: ${syms.join(', ')}`);
      }
    }

    await pool.end();
  } catch (err) {
    console.error('\nBEKLENMEYEN HATA:', err.message);
    await pool.end();
    process.exit(1);
  }
})();
