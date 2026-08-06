// Alpha–Futures Pump Dashboard — sabitler (handoff spec §2 + breakout eşikleri)
module.exports = {
  // ── Pump tespiti ──
  PUMP_X:         9.0,   // dipten >= +800% (ratio = high/low, üst sınır yok)
  PUMP_WINDOW:    60,    // dip -> tepe en fazla 60 gün (slow-burn pumpları da yakalar, ör. SOON)
  PUMP_CLUSTER_GAP: 5,   // bu kadar gün arayla flag'lenen mumlar tek olaya kümelenir
  SPEED_FAST_MAX: 7,     // <=7 gün: GUCLU
  SPEED_MED_MAX:  30,    // 8-30 gün: YAVAS | 31-60 gün: SLOW

  // ── Konsolidasyon ──
  CONS_BAND:      0.30,  // +-%30 salınım (medyan referanslı)
  CONS_MIN_DAYS:  45,    // bu kadar gün banttaysa "uyuyor" (is_sleeping)

  // ── Listeleme pump ayrımı ──
  LISTING_PUMP_DAYS: 3,  // trough_date, ilk mumdan <= bu kadar gün sonraysa day-1 pump

  // ── Klines ──
  KLINE_INTERVAL: '1d',
  KLINE_LIMIT:    1500,  // futures/spot tek çağrıda ~4 yıl günlük

  // Wick-clamp: low, mum gövde tabanının (min(open,close)) bu katından düşükse
  // bozuk print/listeleme wick'i say -> gövde tabanına çek. 0.1 = >%90 wick'leri temizler.
  // (ENSO listeleme mumu low=0.001 vs gövde 3.128 -> 3579× sahte pump'ı engeller)
  LOW_WICK_FLOOR: 0.1,

  // ── Getiriler / low pencereleri (gün) ──
  RET_WINDOWS:  { ret3d: 3, ret7d: 7, ret30d: 30 },
  LOW_WINDOWS:  { low_7d: 7, low_30d: 30, low_90d: 90 },
  DIST_LO_WINDOW: 7,     // dist_lo7 hangi low'a göre
  VOL_BASE_WINDOW: 30,   // vol_base = son N günün medyan günlük quote hacmi (fallback)

  // ── Breakout tetiği (canlı, "hareket başladı" sekmesi) ──
  BREAKOUT_VOL_MULT:    3.0,   // 24h quote hacim > vol_base * bu -> hacim spike
  BREAKOUT_CHG_PCT:     15.0,  // 24h_change % bu değerin üstünde -> yak
  // band-break: last_price > cons_mid * (1 + CONS_BAND) (üst bandı kırdı)

  // ── Hacim kuruması & volatilite sıkışması (squeeze) — futures serisinden ──
  VOL_DRYUP_SHORT:  7,     // kısa pencere (gün)
  VOL_DRYUP_LONG:   90,    // uzun/baz pencere (gün); <90g geçmiş -> ratio & bbw NULL
  VOL_DRYUP_THRESH: 0.40,  // hacim, 90g rolling ort.'nın bu katı altındaysa "kuru" gün
  BB_PERIOD:        20,    // Bollinger periyodu (kapanış SMA/std)
  BBW_LOOKBACK:     180,   // BBW yüzdelik sırası penceresi (gün)
  BAND_TOP_WINDOW:  20,    // band_top_20d = son N gün en yüksek kapanış
  VOL_AVG_WINDOW:   20,    // vol_avg_20d = son N gün ort. günlük hacim

  // ── Kırılım (LIVE, DB'ye yazılmaz) ──
  KIRILIM_PRICE_MULT: 1.01, // guncel_fiyat > band_top_20d * bu
  KIRILIM_VOL_MULT:   1.5,  // hacim_24h > vol_avg_20d * bu

  // ── RSI teknik takip (günlük kapanışlardan) ──
  RSI_PERIOD:         14,   // RSI periyodu (Wilder smoothing)
  RSI_MA_PERIOD:      14,   // RSI'nin hareketli ortalaması (SMA) periyodu — grafikteki sarı çizgi
  RSI_OVERSOLD:       20,   // kesişim bu değerin ÜZERİNDEyken olmalı (alt taban; altı "düşen bıçak")
  RSI_CROSS_MAX_DAYS: 2,    // günlük (1d) için "son N bar içinde yukarı kesmiş" — bildirim + varsayılan filtre

  // ── Hareketli ortalama (golden/death cross) ──
  MA_FAST:            50,    // hızlı SMA
  MA_SLOW:            200,   // yavaş SMA (golden cross = MA50 yukarı MA200'ü keser)
  MA_CROSS_RECENT_DAYS: 2,   // golden/death cross ancak bu kadar gün içindeyse "pozitif" sayılır

  // ── MACD (klasik 12/26/9, EMA) ──
  MACD_FAST:          12,
  MACD_SLOW:          26,
  MACD_SIGNAL:        9,     // MACD çizgisi 0'ın üzerinde (macd>0) = pozitif/boğa

  // ── Stochastic RSI (StochRSI 14/14/3/3) ──
  STOCH_RSI_PERIOD:   14,    // önce RSI(14)
  STOCH_LEN:          14,    // sonra RSI'nın son 14 barındaki stoch normalizasyonu
  STOCH_K:            3,     // %K = StochRSI SMA(3)
  STOCH_D:            3,     // %D = %K SMA(3)
  STOCH_OS:           10,    // aşırı satım (alım bölgesi) — kesişim bunun altında olmalı
  STOCH_OB:           90,    // aşırı alım (satım bölgesi)

  // ── SuperTrend (ATR tabanlı trend takibi) ──
  // Klasik varsayılan 10/3. Kısa periyot/düşük çarpan daha çok sinyal ama daha çok testere;
  // kripto volatilitesinde 10/3 makul bir denge.
  ST_PERIOD: 10,   // ATR periyodu (Wilder)
  ST_MULT:   3,    // bant çarpanı

  // ── Zaman dilimleri (Teknik Takip) — hepsinde RSI+MA+MACD hesaplanır ──
  // Eşikler BAR cinsinden: 1d→1 bar=1 gün, 4h→6 bar=1 gün, 1w→1 bar=1 hafta.
  // limit: MA200 için yeterli geçmiş (4h: 600 bar≈100g, 1w: 400 bar≈7.7yıl mevcut olduğu kadar).
  // limit: MA200(200 bar) + RSI/MACD için yeterli olan en küçük pencere (ağırlık düşsün).
  // Pump/ATH geçmişi için gereken 1500 bar KLINE_LIMIT'te kalır, o pump taramasının işi.
  TIMEFRAMES: {
    '1d': { label: 'Günlük', interval: '1d', limit: 400, rsiCrossMaxBars: 2,  maCrossRecentBars: 2  },
    '4h': { label: '4 Saat', interval: '4h', limit: 600, rsiCrossMaxBars: 12, maCrossRecentBars: 12 },
    '1w': { label: 'Haftalık', interval: '1w', limit: 400, rsiCrossMaxBars: 2, maCrossRecentBars: 2  },
  },
  DEFAULT_TIMEFRAME: '1d',
  // Teknik Takip evreni = TÜM TRADING futures (alpha∩futures değil). Pump tarafı etkilenmez.
  TECH_SCAN_DELAY_MS: 60,   // sadece fapi'ye vurur (alpha bapi yok) → daha düşük throttle

  // ── AI Yorum (Claude Code CLI headless — Messages API DEĞİL) ──
  // Faturalandırma kullanıcının Claude aboneliğinden düşer, ayrı API faturası çıkmaz.
  // NOT: --bare KULLANILMAZ; o flag kayıtlı oturumu da atlayıp "Not logged in" verir.
  // Keşif yükü bunun yerine boş temp cwd + --strict-mcp-config ile kısılır.
  CLAUDE_BIN:          process.env.CLAUDE_BIN || '/usr/bin/claude',
  AI_HOME:             process.env.AI_HOME || '/root',  // pm2'de HOME boş kalabilir → ~/.claude bulunamaz
  AI_MODEL:            'opus',      // CLI alias → claude-opus-4-8 (sonnet'ten daha güçlü, ~2× pahalı)
  AI_ALLOWED_TOOLS:    'WebSearch,WebFetch',
  // On-chain arama zinciri (kontrat→holder→transfer) prompt'tan kaldırıldı; holder verisi
  // artık coin_holders'tan hazır geliyor. Kalan tek iş proje+haber araması → tur bütçesi düştü.
  AI_MAX_TURNS:        8,
  AI_TIMEOUT_MS:       240000,   // 240 sn sonra SIGKILL (daha fazla arama = daha uzun)
  AI_DAILY_PER_COIN:   2,        // coin başına günlük yorum (Istanbul takvim günü)
  AI_DAILY_GLOBAL_CAP: 10,        // günlük toplam üretim (patlama freni)
  AI_MONTHLY_BUDGET_USD: 12,     // aylık harcama tavanı — $20'lık havuzdan kendi işine pay bırakır
  AI_ERROR_COOLDOWN_MS: 60000,   // hata sonrası aynı coin için bekleme

  // ── Telegram bildirim + zamanlama ──
  DASH_URL:            'https://thorasan.xyz',  // mesaj linkleri için

  // Teknik Takip telegram hedefi — KAYITLI, henüz kullanılmıyor (koşullar netleşince bağlanacak).
  // sendMessage(text, { chat_id: TECH_TG_CHAT_ID, message_thread_id: TECH_TG_THREAD_ID }) ile gönderilir.
  TECH_TG_CHAT_ID:     '-1002514746853',   // supergroup
  TECH_TG_THREAD_ID:   6328,               // topic (konu) id

  TG_ALERT_COOLDOWN_H: 10,          // aynı coin için tekrar uyarı arası (saat)
  CRON_TZ:             'Europe/Istanbul',       // cron saat dilimi (UTC+3, sabit; sunucu UTC 0)
  CRON_NIGHTLY:        '0 4 * * *',             // (eski) gece 04:00 — artık CRON_REFRESH kullanılıyor
  CRON_REFRESH:        '0 0,7,13,19 * * *',     // günde 4× tam refresh (00/07/13/19 UTC+3) → teknik takip bildirimi
  CRON_BREAKOUT:       '*/15 * * * *',          // 15 dk breakout kontrol

  // ── Rate-limit / throttle (alpha bapi yavaş) ──
  SCAN_DELAY_MS:   150,  // coinler arası bekleme (refresh döngüsü)
  HTTP_TIMEOUT_MS: 20000,
  HTTP_RETRIES:    3,

  // ── Holder dağılımı (Chainbase API) ──
  // Explorer scrape'i denendi ve TERK EDİLDİ: sunucunun çıkış IP'si (Frankfurt datacenter)
  // Cloudflare bot doğrulamasına takılıyor, 4/4 explorer 403 döndü. Kod commit 5b30704'te.
  // Artık kaynak Chainbase: GET /v1/token/top-holders (x-api-key header, .env'de
  // CHAINBASE_API_KEY). CRON YOK — coin sayfasındaki admin butonu tetikler.
  CHAINBASE_BASE:        'https://api.chainbase.online',
  CHAINBASE_TIMEOUT_MS:  25000,
  CHAINBASE_RETRIES:     2,
  CHAINBASE_LIMIT:       100,   // top-holders sayfa boyutu — API'nin izin verdiği MAKSİMUM
  // /v1/address/labels adres BAŞINA 1 çağrı → sadece ilk N cüzdan. İlk testte 3/3 boş
  // görünmüştü ama ikinci tokende 2/3 DOLU geldi (`contract-deployer` gibi işe yarar
  // kategoriler) → açıldı.
  CHAINBASE_LABEL_TOP_N: 10,
  // Free tier hız limiti adres-başına-1-çağrıyı zorluyor ("Too many requests" — toplu çekimde
  // coin başına 2-5 çağrı boşa gidiyordu) → araya bekleme koy; arka arkaya bu kadar 429
  // gelirse o coin için etiketten vazgeç (opsiyonel zenginleştirme, kotayı yakmasın).
  CHAINBASE_LABEL_DELAY_MS:    350,
  CHAINBASE_LABEL_MAX_STRIKES: 3,
  // Etiket kategorisi filtresi: `early-token-holder` gibi kategoriler gürültü ("Early NFP
  // Holder"). Bunlar sayılırsa sıradan bir perakende cüzdan "etiketli" olup temiz orandan
  // düşülür — yani gerçeği OLDUĞUNDAN İYİ gösterir. Sadece kurumsal/altyapı anlamı taşıyanları al.
  HOLDER_LABEL_IGNORE_CATEGORIES: [
    'early-token-holder', 'nft-holder', 'social', 'ens', 'donation', 'gaming', 'airdrop-hunter',
  ],

  // Etiket API'sinin TANIMADIĞI ama kritik olan altyapı adresleri (hepsi küçük harf).
  // Örnek: Binance Alpha router'ı bir tokende arzın %38'ini tutuyordu ve etiket ucu {} döndü;
  // bağımsız cüzdan sayılınca "temiz ilk 5" olduğundan çok yüksek çıkıyordu.
  HOLDER_KNOWN_ADDRESSES: {
    '0x73d8bd54f7cf5fab43fe4ef40a62d390644946db': { kind: 'cex', label: 'Binance: Alpha 2.0 Router Proxy' },
  },

  // Zincir RPC'leri (key'siz public uçlar).
  // ÜRETİMDE KULLANILIYOR: Chainbase'in top-holders listesi KEŞİF için, bakiyeler ise
  // zincirden doğrulanıyor. Sebep (canlı ölçüm, 我踏马来了/BSC): Chainbase'in ilk 2 satırı
  // zincirle birebir tutarken #50 ve #100'ün zincirde bakiyesi 0'dı — o cüzdanlar satmış,
  // indeks bayat kalmış. Bayat satırlar birikince ilk 100 toplamı %108'e çıkıyordu.
  // Uçlar ÖLÇÜLEREK seçildi (10'luk batch testi): eth.llamarpc 0/10, eth.drpc 0/10,
  // mainnet.base.org 5/10 (sonra 0/5) → toplu çekimde 34 coin "zincir_dogrulanmadi"
  // almıştı. publicnode ikisinde de 10/10 verdi.
  // Hepsi eth_chainId ile doğrulandı. Arz okuması (totalSupply) bu listedeki HER zincirde
  // yapılabilir; holder listesi ise yalnız HOLDER_CHAIN_IDS'teki zincirlerde (Chainbase).
  HOLDER_RPC: {
    BSC:       'https://bsc-dataseed.bnbchain.org',
    Ethereum:  'https://ethereum-rpc.publicnode.com',
    Base:      'https://base-rpc.publicnode.com',
    Arbitrum:  'https://arb1.arbitrum.io/rpc',
    Polygon:   'https://polygon-bor-rpc.publicnode.com',
    Optimism:  'https://optimism-rpc.publicnode.com',
    Avalanche: 'https://avalanche-c-chain-rpc.publicnode.com',
    Linea:     'https://linea-rpc.publicnode.com',
    Sonic:     'https://sonic-rpc.publicnode.com',
    Scroll:    'https://scroll-rpc.publicnode.com',
    Mantle:    'https://mantle-rpc.publicnode.com',
    Blast:     'https://blast-rpc.publicnode.com',
    Berachain: 'https://berachain-rpc.publicnode.com',
    Unichain:  'https://unichain-rpc.publicnode.com',
  },

  // ── Çok zincirli arz dağılımı ──
  // Köprülenmiş tokenlarda tek zincire bakmak yanıltıyor: ölçümde CARV'ın BSC'de arzın
  // %0.98'i, Base'de %75.6'sı vardı — "BSC top5=%24" tokenin %1'lik dilimini anlatıyordu.
  // Zincir listesi CoinGecko'dan (key'siz, tek çağrı, ~2.9 MB), arz her zincirden RPC ile.
  COINGECKO_LIST_URL: 'https://api.coingecko.com/api/v3/coins/list?include_platform=true',
  COINGECKO_CACHE_MS: 6 * 60 * 60 * 1000,   // 6 saat (liste yavaş değişir, indirmesi ağır)
  // CoinGecko platform kimliği → bizim zincir adımız
  CG_PLATFORM_MAP: {
    'ethereum': 'Ethereum', 'binance-smart-chain': 'BSC', 'base': 'Base',
    'arbitrum-one': 'Arbitrum', 'polygon-pos': 'Polygon', 'optimistic-ethereum': 'Optimism',
    'avalanche': 'Avalanche', 'linea': 'Linea', 'sonic': 'Sonic', 'scroll': 'Scroll',
    'mantle': 'Mantle', 'blast': 'Blast', 'berachain': 'Berachain', 'unichain': 'Unichain',
    'solana': 'Solana', 'sui': 'Sui', 'tron': 'TRON',
  },
  // 10: base.org "maximum 10 calls in 1 batch" diyor ve 20'lik batch'i TOPTAN reddediyordu
  // (bu yüzden tüm Base coinlerinde "okunamayan 100/100" çıktı).
  RPC_BATCH_SIZE:     10,
  RPC_TIMEOUT_MS:     20000,
  RPC_RETRIES:        2,      // parça başına yeniden deneme (kısmi batch reddi sık)
  RPC_CHUNK_DELAY_MS: 250,    // parçalar arası bekleme

  // Chainbase EVM chain_id'leri. Burada OLMAYAN zincir (Solana/Sui/TRON) link-only kalır.
  // Linea BURADA YOK: Chainbase "unsupported network" döndürüyor (toplu çekimde tek hata
  // oydu) → link-only kalsın, boşuna hata üretmesin.
  HOLDER_CHAIN_IDS: {
    Ethereum: 1, BSC: 56, Base: 8453, Arbitrum: 42161,
    // Chainbase bunları da destekliyor olabilir; desteklemezse o zincir sekmesi
    // "holder verisi yok" kalır, diğerleri etkilenmez (hata zincir başına yutulur).
    Polygon: 137, Optimism: 10, Avalanche: 43114,
  },

  // LP havuzu adresleri — DexScreener'dan bedava (key yok). Havuzlar "cüzdan" değildir,
  // konsantrasyonu yapay şişirirler; bu yüzden temiz orandan düşülür.
  DEXSCREENER_TOKENS_URL: 'https://api.dexscreener.com/latest/dex/tokens/{ca}',

  HOLDERS_MIN_REFETCH_MIN:   30,     // aynı sembolü bu süreden önce tekrar çekme (kredi freni)
  HOLDERS_ERROR_COOLDOWN_MS: 60000,  // hata sonrası aynı sembol için bekleme

  // Etiket sınıflandırma — Chainbase label'ları + DexScreener havuz adresleri üzerinde çalışır.
  // Amaç: "bağımsız perakende cüzdanı" ile "borsa/protokol/proje kontrolündeki adres" ayrımı.
  HOLDER_CEX_LABELS: [
    'binance', 'bitget', 'mexc', 'okx', 'okex', 'gate', 'kucoin', 'bybit', 'coinbase',
    'kraken', 'huobi', 'htx', 'bitfinex', 'crypto.com', 'bingx', 'lbank', 'upbit', 'bithumb',
    'robinhood', 'bitmart', 'bitstamp', 'gemini', 'backpack', 'weex', 'phemex', 'coinw',
    'xt.com', 'toobit', 'bitunix', 'ourbit', 'kcex', 'bitvavo', 'exchange', 'cex',
  ],
  HOLDER_POOL_LABELS: [
    'pancakeswap', 'uniswap', 'aerodrome', 'camelot', 'sushiswap', 'curve', 'balancer',
    'vault', 'pool', 'lp ', 'liquidity', 'router', 'staking', 'timelock', 'vesting', 'locker',
    'treasury', 'foundation', 'team', 'reserve', 'deployer', 'bridge', 'multisig',
    'escrow', 'distributor', 'airdrop', 'rewards', 'farm', 'gauge', 'masterchef',
    'lockup', 'sablier', 'hedgey', 'streamflow', 'dex', 'amm', 'defi',
  ],
  // İsim servisi adları (luggis.eth gibi) etiket DEĞİL — gerçek şahsi cüzdanlar.
  HOLDER_NAME_SUFFIXES: ['.eth', '.bnb', '.sol', '.base', '.arb', '.crypto', '.x', '.id', '.lens'],
  HOLDER_BURN_ADDRS: [
    '0x0000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000dead',
    '0x0000000000000000000000000000000000000001',
  ],

  // Konsantrasyon risk eşikleri — clean_top5_pct (CEX/havuz/burn düşülmüş) üzerinden
  HOLDER_RISK_VERY_HIGH:   80,   // kullanıcının kuralı: %80+ ilk 5 bağımsız cüzdanda
  HOLDER_RISK_HIGH:        60,
  HOLDER_RISK_MED:         40,
  HOLDER_DOMINANT_WALLET:  50,   // tek bağımsız cüzdan bu payın üstündeyse seviye bir kademe artar
  HOLDER_MIN_REAL_WALLETS: 100,  // $1.000 üstü cüzdan sayısı bunun altındaysa bayrak
  HOLDER_LOW_CIRC_RATIO:   0.30, // dolaşım/toplam arz bunun altındaysa "kilitli arz" bayrağı

  ALPHA_TOKEN_LIST_URL:
    'https://www.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/cex/alpha/all/token/list',
  ALPHA_LIST_CACHE_MS:  10 * 60 * 1000,  // süreç içi alpha listesi cache'i (kontrat adresi kaynağı)

  // Zincir → holder sayfası linki ({ca} = kontrat adresi). Hepsi link-only.
  HOLDER_EXPLORERS: {
    BSC:      { name: 'bscscan',    url: 'https://bscscan.com/token/{ca}#balances'    },
    Ethereum: { name: 'etherscan',  url: 'https://etherscan.io/token/{ca}#balances'   },
    Base:     { name: 'basescan',   url: 'https://basescan.org/token/{ca}#balances'   },
    Arbitrum: { name: 'arbiscan',   url: 'https://arbiscan.io/token/{ca}#balances'    },
    Linea:    { name: 'lineascan',  url: 'https://lineascan.build/token/{ca}#balances'},
    Sonic:    { name: 'sonicscan',  url: 'https://sonicscan.org/token/{ca}#balances'  },
    Solana:   { name: 'solscan',    url: 'https://solscan.io/token/{ca}#holders'      },
    Sui:      { name: 'suiscan',    url: 'https://suiscan.xyz/mainnet/coin/{ca}/holders' },
    TRON:     { name: 'tronscan',   url: 'https://tronscan.org/#/token20/{ca}/holders' },
  },
};
