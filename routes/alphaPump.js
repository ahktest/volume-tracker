// Alpha–Futures Pump Dashboard endpoint'leri (handoff spec §9). Public.
// server.js: app.use('/api/pump', require('./routes/alphaPump')(pool));
const express = require('express');
const binance = require('../lib/binance');
const refresh = require('../lib/refresh');
const live = require('../lib/live');
const cfg = require('../lib/config');
const { computeRsi } = require('../lib/rsi');

module.exports = (pool) => {
  const router = express.Router();

  // ── GET /coins : coin_metrics + pump_events özet (filtreli) ──
  router.get('/coins', async (req, res) => {
    try {
      const where = [];
      const params = [];
      const q = req.query;
      if (q.sleeping === '1')      where.push('cm.is_sleeping = 1');
      if (q.min_cons_days)         { where.push('cm.consolidation_days >= ?'); params.push(+q.min_cons_days); }
      if (q.max_dist_lo7)          { where.push('cm.dist_lo7 <= ?'); params.push(+q.max_dist_lo7); }
      if (q.min_mcap)              { where.push('cm.mcap_usd >= ?'); params.push(+q.min_mcap); }
      if (q.max_mcap)              { where.push('cm.mcap_usd <= ?'); params.push(+q.max_mcap); }
      for (const v of ['is_upbit', 'is_bybit', 'is_spot', 'is_verified']) {
        if (q[v] === '1') where.push(`cm.${v} = 1`);
      }
      if (q.has_pump === '1')      where.push('pe.event_count > 0');
      if (q.min_magnitude)         { where.push('pe.max_magnitude >= ?'); params.push(+q.min_magnitude); }

      // sıralama (whitelist)
      const SORTABLE = new Set(['consolidation_days','dist_lo7','mcap_usd','ret7d','ret30d',
                                'fut_ath_age_days','max_magnitude','event_count','symbol','last_updated_at']);
      const sort = SORTABLE.has(q.sort) ? q.sort : 'consolidation_days';
      const sortCol = ['max_magnitude','event_count'].includes(sort) ? `pe.${sort}` : `cm.${sort}`;
      const dir = (q.dir || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

      const [rows] = await pool.query(`
        SELECT cm.*,
          COALESCE(pe.event_count, 0)        AS event_count,
          pe.max_magnitude,
          pe.max_fut_mag, pe.max_alpha_mag,
          COALESCE(pe.listing_pumps, 0)      AS listing_pumps,
          COALESCE(pe.non_listing_pumps, 0)  AS non_listing_pumps,
          pe.min_magnitude, pe.sum_magnitude,
          pe.first_pump_date, pe.last_pump_date,
          cmc.cmc_slug, cmc.cmc_id
        FROM coin_metrics cm
        LEFT JOIN (
          SELECT symbol,
            COUNT(*)                                        AS event_count,
            MAX(magnitude_x)                                AS max_magnitude,
            MIN(magnitude_x)                                AS min_magnitude,
            SUM(magnitude_x)                                AS sum_magnitude,
            MAX(CASE WHEN market='futures' THEN magnitude_x END) AS max_fut_mag,
            MAX(CASE WHEN market='alpha'   THEN magnitude_x END) AS max_alpha_mag,
            SUM(is_listing_pump)                            AS listing_pumps,
            SUM(1 - is_listing_pump)                        AS non_listing_pumps,
            MIN(trough_date)                                AS first_pump_date,
            MAX(peak_date)                                  AS last_pump_date
          FROM pump_events GROUP BY symbol
        ) pe ON pe.symbol = cm.symbol
        LEFT JOIN (
          SELECT base_asset, MAX(cmc_slug) AS cmc_slug, MAX(cmc_id) AS cmc_id
          FROM binance_futures_tracking WHERE is_delist = 0 GROUP BY base_asset
        ) cmc ON cmc.base_asset = cm.symbol
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY ${sortCol} IS NULL, ${sortCol} ${dir}
      `, params);
      res.json(rows);
    } catch (err) {
      console.error('[pump/coins] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /tech : çoklu zaman dilimi teknik sinyalleri (1d/4h/1w) + eşik meta'sı ──
  // Tüm dilimler tek çağrıda döner; frontend seçiciyi client-side değiştirir.
  router.get('/tech', async (req, res) => {
    try {
      // Evren = tüm TRADING futures. coin_metrics (alpha∩futures) LEFT JOIN — alpha
      // olmayan coinlerde pump/konsolidasyon alanları null gelir, sekme yine çalışır.
      const [rows] = await pool.query(`
        SELECT t.symbol, t.timeframe, t.rsi14, t.rsi_ma, t.rsi_cross_bars_ago,
               t.ma50, t.ma200, t.ma_cross_bars_ago, t.ma_source,
               t.macd, t.macd_signal, t.macd_hist, t.macd_cross_bars_ago, t.updated_at,
               cm.dist_lo7, cm.ret7d, cm.ret30d, cm.consolidation_days, cm.last_price,
               cm.is_sleeping, cm.fut_ath_age_days,
               (cm.symbol IS NOT NULL) AS in_metrics,
               bft.mcap_usd, bft.cmc_slug,
               COALESCE(ec.is_alpha,0) AS is_alpha, COALESCE(ec.is_fut,0) AS is_fut,
               COALESCE(ec.is_spot,0)  AS is_spot,  COALESCE(ec.is_upbit,0) AS is_upbit,
               COALESCE(ec.is_bybit,0) AS is_bybit,
               pe.max_magnitude, COALESCE(pe.event_count, 0) AS event_count
          FROM coin_tech_signals t
          LEFT JOIN coin_metrics cm ON cm.symbol = t.symbol
          LEFT JOIN (
            SELECT base_asset, MAX(mcap_usd) AS mcap_usd, MAX(cmc_slug) AS cmc_slug
            FROM binance_futures_tracking WHERE is_delist = 0 GROUP BY base_asset
          ) bft ON bft.base_asset = t.symbol
          LEFT JOIN (
            SELECT symbol,
              MAX(source='binance_alpha')   AS is_alpha, MAX(source='binance_futures') AS is_fut,
              MAX(source='binance_spot')    AS is_spot,  MAX(source='upbit')           AS is_upbit,
              MAX(source='bybit_futures')   AS is_bybit
            FROM exchangecoins GROUP BY symbol
          ) ec ON ec.symbol = t.symbol
          LEFT JOIN (
            SELECT symbol, MAX(magnitude_x) AS max_magnitude, COUNT(*) AS event_count
            FROM pump_events GROUP BY symbol
          ) pe ON pe.symbol = t.symbol
      `);
      res.json({
        meta: {
          timeframes: cfg.TIMEFRAMES,
          default: cfg.DEFAULT_TIMEFRAME,
          rsi_oversold: cfg.RSI_OVERSOLD,
        },
        rows,
      });
    } catch (err) {
      console.error('[pump/tech] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /live : ucuz batch ticker + funding + breakout (lib/live) ──
  router.get('/live', async (req, res) => {
    try {
      res.json(await live.computeLive(pool));
    } catch (err) {
      console.error('[pump/live] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /tg-test : telegram bağlantısını test et (tek mesaj) ──
  router.get('/tg-test', async (req, res) => {
    const ok = await require('../lib/telegram').sendMessage('✅ Pump dashboard telegram testi çalışıyor.');
    res.json({ sent: ok });
  });

  // ── GET /tech-tg-test : Teknik Takip grubuna örnek mesaj (aynı ipv4-safe sendMessage) ──
  // ?n=3 detaylı örnek | ?n=8 özet örnek. Örnek mesajı revize etmek için buradaki SAMPLE'ı düzenle.
  router.get('/tech-tg-test', async (req, res) => {
    const tg = require('../lib/telegram');
    const { buildMessage } = require('../lib/techNotify');
    const n = Math.max(1, Math.min(20, +req.query.n || 3));
    // örnek adaylar (gerçek run ile aynı {c,cat,repeat} şekli)
    const SAMPLE = [
      { c: { symbol: 'SOON',  rsi14: 38.5, rsi_cross_days_ago: 0, dist_lo7: 3.2,  last_price: 0.1234 }, cat: 'TAM',      repeat: false },
      { c: { symbol: 'PONKE', rsi14: 41.0, rsi_cross_days_ago: 1, dist_lo7: 8.1,  last_price: 1.2345 }, cat: 'RSI+MACD', repeat: true  },
      { c: { symbol: 'ZORA',  rsi14: 33.4, rsi_cross_days_ago: 2, dist_lo7: 1.0,  last_price: 0.0456 }, cat: 'RSI+GC',   repeat: false },
      { c: { symbol: 'AVAX',  rsi14: 44.2, rsi_cross_days_ago: 1, dist_lo7: 5.5,  last_price: 22.34  }, cat: 'RSI+MACD', repeat: false },
      { c: { symbol: 'HYPE',  rsi14: 39.9, rsi_cross_days_ago: 0, dist_lo7: 2.1,  last_price: 12.34  }, cat: 'TAM',      repeat: false },
      { c: { symbol: 'WIF',   rsi14: 42.7, rsi_cross_days_ago: 2, dist_lo7: 9.0,  last_price: 0.9876 }, cat: 'RSI+GC',   repeat: true  },
      { c: { symbol: 'ENA',   rsi14: 36.1, rsi_cross_days_ago: 1, dist_lo7: 4.4,  last_price: 0.5432 }, cat: 'RSI+MACD', repeat: false },
      { c: { symbol: 'PENGU', rsi14: 40.3, rsi_cross_days_ago: 0, dist_lo7: 6.7,  last_price: 0.0321 }, cat: 'TAM',      repeat: false },
    ];
    const sample = Array.from({ length: n }, (_, i) => SAMPLE[i % SAMPLE.length]);
    const text = buildMessage(sample);
    const sent = await tg.sendMessage(text, { chat_id: cfg.TECH_TG_CHAT_ID, message_thread_id: cfg.TECH_TG_THREAD_ID });
    res.json({ sent, n, preview: text });
  });

  // ── POST /refresh : 258 coin STORE taraması (async job) ──
  router.post('/refresh', async (req, res) => {
    try {
      const r = await refresh.startAll(pool);
      res.json(r);
    } catch (err) {
      console.error('[pump/refresh] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /refresh/status : progress bar ──
  router.get('/refresh/status', (req, res) => res.json(refresh.status()));

  // ── POST /tech-refresh : Teknik Takip taraması (TÜM TRADING futures, ~500) ──
  // Pump refresh'ten ayrıdır; o alpha∩futures (222) evreninde çalışır.
  router.post('/tech-refresh', (req, res) => {
    try { res.json(require('../lib/techScan').start(pool)); }
    catch (err) {
      console.error('[pump/tech-refresh] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /tech-refresh/status : teknik tarama ilerlemesi ──
  router.get('/tech-refresh/status', (req, res) => res.json(require('../lib/techScan').status()));

  // ── POST /refresh/:symbol : tek coin yeniden hesapla ──
  router.post('/refresh/:symbol', async (req, res) => {
    try {
      const result = await refresh.refreshOne(pool, req.params.symbol.toUpperCase());
      res.json(result);
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // ── GET /coin/:symbol : detay (metrics + events + klines) ──
  router.get('/coin/:symbol', async (req, res) => {
    try {
      const symbol = req.params.symbol.toUpperCase();
      const [[metrics]] = await pool.query(`
        SELECT cm.*, cmc.cmc_slug, cmc.cmc_id, cmc.cmc_symbol
        FROM coin_metrics cm
        LEFT JOIN (
          SELECT base_asset, MAX(cmc_slug) AS cmc_slug, MAX(cmc_id) AS cmc_id, MAX(cmc_symbol) AS cmc_symbol
          FROM binance_futures_tracking WHERE is_delist = 0 GROUP BY base_asset
        ) cmc ON cmc.base_asset = cm.symbol
        WHERE cm.symbol = ?`, [symbol]);
      // coin_metrics'te yoksa (alpha∩futures dışı, Teknik Takip evreninden gelen coin)
      // 404 verme — tech-only moda düş: futures meta + teknik sinyaller yeterli.
      let techOnly = false;
      let m = metrics;
      if (!m) {
        const [[fut]] = await pool.query(
          `SELECT base_asset, mcap_usd, status, contract_type, cmc_slug, cmc_id
             FROM binance_futures_tracking
            WHERE base_asset = ? AND is_delist = 0 AND status = 'TRADING'
            ORDER BY (contract_type='PERPETUAL') DESC LIMIT 1`, [symbol]);
        if (!fut) return res.status(404).json({ error: 'not_found' });
        techOnly = true;
        m = { symbol, mcap_usd: fut.mcap_usd, status: fut.status, contract_type: fut.contract_type,
              cmc_slug: fut.cmc_slug, cmc_id: fut.cmc_id, is_fut: 1, alpha_id: null };
      }
      const metricsOut = m;
      const [events] = techOnly ? [[]] : await pool.query(
        'SELECT * FROM pump_events WHERE symbol = ? ORDER BY trough_date ASC', [symbol]);
      let klines = [];
      try {
        const raw = await binance.futuresKlines(symbol, cfg.KLINE_INTERVAL, 365);
        klines = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4] }));
      } catch (e) { /* grafik yoksa boş */ }
      // alpha serisi (futures ile aynı grafikte overlay + lead-lag analizi için)
      let alphaKlines = [];
      if (metricsOut.alpha_id) {
        try {
          const raw = await binance.alphaKlines(metricsOut.alpha_id, cfg.KLINE_INTERVAL, 365);
          alphaKlines = raw.map(k => ({ t: +k[0], c: +k[4] }));
        } catch (e) { /* alpha yoksa boş */ }
      }
      // RSI(14) + ortalaması (grafik alt-paneli) — futures kapanışlarından, klines ile hizalı
      let rsi = [], rsiMa = [];
      if (klines.length) {
        const r = computeRsi(klines.map(k => k.c));
        rsi = r.rsi; rsiMa = r.ma;
      }
      // Çoklu dilim teknik sinyalleri (bu coin için) — tech-only modda ana içerik
      let techRows = [];
      try {
        [techRows] = await pool.query(
          'SELECT * FROM coin_tech_signals WHERE symbol = ?', [symbol]);
      } catch (e) { /* tablo yoksa boş */ }
      res.json({ metrics: metricsOut, techOnly, events, klines, alphaKlines, rsi, rsiMa, techRows });
    } catch (err) {
      console.error('[pump/coin] hata:', err);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
