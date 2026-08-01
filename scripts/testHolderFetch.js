// Holder scrape tanı aracı — explorer'ın bu sunucuya NE döndürdüğünü gösterir.
// Sunucudan 403 alındığında sebebi ayırt etmek için: Cloudflare bot doğrulaması mı,
// yoksa IP itibarı (VPS/datacenter) engeli mi?
//
// Çalıştır:  node scripts/testHolderFetch.js
//            node scripts/testHolderFetch.js GRVT        (tek sembol, DB'den kontrat çözer)
//
// Sembol verilmezse dört explorer'ı da sabit referans tokenlarla dener — DB'ye hiç dokunmaz.
require('dotenv').config({ path: __dirname + '/../.env' });
const axios = require('axios');
const cfg = require('../lib/config');

// Her explorer'dan bilinen-çalışan bir token (bunlar Mac'ten 200 dönüyordu)
const SAMPLES = [
  ['BSC',      'CYS',   '0x0c69199c1562233640e0db5ce2c399a88eb507c7'],
  ['Ethereum', 'FLUID', '0x6f40d4a6237c257fff2db00fa0510deeecd303eb'],
  ['Base',     'AVNT',  '0x696f9436b67233384889472cd7cd58a6fb5df4f1'],
  ['Arbitrum', 'CHIP',  '0x0c1c1c109fe34733fca54b82d7b46b75cfb71f6e'],
];

const BLOCKS = ['holdersConcentrationData', 'holdersTierDistributionData',
                'holdersThresholdDepthData', 'quickExportTokenHolerData'];

function headers(host) {
  return {
    'User-Agent': cfg.HOLDERS_UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': `${host}/`,
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
  };
}

async function probe(chain, symbol, contract) {
  const exp = cfg.HOLDER_EXPLORERS[chain];
  const url = `${exp.host}/token/generic-tokenholders2?m=normal&a=${contract}&p=1`;
  process.stdout.write(`\n── ${chain} / ${symbol} (${exp.name}) ──\n   ${url}\n`);
  try {
    const res = await axios.get(url, {
      timeout: cfg.HOLDERS_TIMEOUT_MS, headers: headers(exp.host), validateStatus: () => true,
    });
    const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
    const cfRay = res.headers['cf-ray'] || null;
    const server = res.headers['server'] || null;
    console.log(`   HTTP ${res.status}  boyut=${body.length}  server=${server}  cf-ray=${cfRay || '—'}`);

    if (res.status !== 200) {
      const cf = /just a moment|cf-challenge|attention required|cloudflare|enable javascript/i.test(body);
      console.log(`   TEŞHİS: ${cf ? 'Cloudflare bot doğrulaması (challenge sayfası)'
                                   : 'Cloudflare challenge DEĞİL → büyük olasılıkla IP engeli'}`);
      console.log(`   gövde: ${body.replace(/\s+/g, ' ').slice(0, 300)}`);
      return false;
    }

    const found = BLOCKS.filter(n =>
      new RegExp(`(?:var|const|let)\\s+${n}\\s*=\\s*'\\[`).test(body));
    console.log(`   JSON blokları: ${found.length}/4  ${found.length === 4 ? '✓ TAMAM' : '✗ eksik: ' + BLOCKS.filter(b => !found.includes(b)).join(', ')}`);
    if (found.length === 4) {
      const m = body.match(/(?:var|const|let)\s+holdersConcentrationData\s*=\s*'(\[[\s\S]*?\])'\s*;/);
      if (m) {
        const top5 = JSON.parse(m[1]).find(c => c.name === 'Top 1-5');
        if (top5) console.log(`   Top 1-5 = %${Number(top5.value).toFixed(2)}`);
      }
    }
    return found.length === 4;
  } catch (e) {
    console.log(`   İSTEK HATASI: ${e.code || ''} ${e.message}`);
    return false;
  }
}

(async () => {
  console.log('Holder scrape tanı — explorer bu sunucuya ne döndürüyor?');
  try {
    const ip = await axios.get('https://api.ipify.org', { timeout: 8000 });
    console.log(`Bu sunucunun çıkış IP\'si: ${ip.data}`);
  } catch (e) { console.log('Çıkış IP\'si alınamadı.'); }

  const arg = (process.argv[2] || '').toUpperCase();
  let list = SAMPLES;

  if (arg) {
    // Tek sembol: kontratı canlı alpha listesinden çöz (DB'siz de çalışsın diye sembolle eşler)
    const res = await axios.get(cfg.ALPHA_TOKEN_LIST_URL,
      { timeout: cfg.HOLDERS_TIMEOUT_MS, headers: { 'User-Agent': cfg.HOLDERS_UA } });
    const rows = (res.data && res.data.data) || [];
    const t = rows.filter(x => String(x.symbol || '').toUpperCase() === arg)
                  .sort((a, b) => Number(b.marketCap || 0) - Number(a.marketCap || 0))[0];
    if (!t) { console.error(`\n${arg} alpha listesinde bulunamadı.`); process.exit(1); }
    if (!cfg.HOLDER_EXPLORERS[t.chainName]) {
      console.error(`\n${arg} → ${t.chainName} zinciri: otomatik çekim kapsamında değil (link-only).`);
      process.exit(1);
    }
    list = [[t.chainName, arg, t.contractAddress]];
  }

  let ok = 0;
  for (const [chain, sym, ca] of list) {
    if (await probe(chain, sym, ca)) ok++;
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\nSONUÇ: ${ok}/${list.length} explorer bu sunucudan erişilebilir.`);
  if (!ok) {
    console.log('\nHiçbiri geçmedi. Muhtemel sebep sırasıyla:');
    console.log('  1) VPS/datacenter IP itibarı — Cloudflare bu IP bloğunu peşinen engelliyor.');
    console.log('     Başlık ayarıyla çözülmez; proxy ya da farklı çıkış IP\'si gerekir.');
    console.log('  2) Cloudflare bot doğrulaması — yukarıdaki TEŞHİS satırı bunu söyler.');
    console.log('  Bu durumda Solana/Sui/Linea gibi tüm zincirleri link-only\'e almak makul.');
  }
})();
