require('dotenv').config({ path: __dirname + '/.env' });
const express = require("express");
//const mysql = require("mysql2");
const mysql = require('mysql2/promise');

const cors = require("cors");

//app.use(express.static('public'));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));


// Veritabanı bağlantısı
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
});

app.get("/ping", (req, res) => {
  console.log("🟢 /ping çalıştı");
  res.send("pong");
});

app.get('/api/top-increase', async (req, res) => {
  const [rows] = await pool.query(`
    SELECT
      latest.symbol,
      latest.slug,
      latest.price,
      latest.marketcap,
      latest.timestamp AS ltime,
      t4.timestamp AS ptime,
      latest.volume AS lvolume,
      t4.volume AS v4hvolume,
      t8.volume AS v8hvolume,
      (latest.volume - t4.volume) AS fark,
      ROUND(((latest.volume - t4.volume) / t4.volume) * 100, 2) AS yuzdelik
    FROM (
      SELECT * FROM volume_data ORDER BY id DESC LIMIT 200
    ) AS latest
    JOIN (
      SELECT * FROM volume_data ORDER BY id DESC LIMIT 200, 200
    ) AS t4 ON latest.symbol = t4.symbol
    JOIN (
      SELECT * FROM volume_data ORDER BY id DESC LIMIT 400, 200
    ) AS t8 ON latest.symbol = t8.symbol
    ORDER BY yuzdelik DESC
    LIMIT 15
  `);
  res.json(rows);
});

app.get('/api/top-decrease', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT
        latest.symbol,
        latest.slug,
        latest.price,
        latest.marketcap,
        latest.timestamp AS ltime,
        t4.timestamp AS ptime,
        latest.volume AS lvolume,
        t4.volume AS v4hvolume,
        t8.volume AS v8hvolume,
        (latest.volume - t4.volume) AS fark,
        ROUND(((latest.volume - t4.volume) / t4.volume) * 100, 2) AS yuzdelik
      FROM (
        SELECT * FROM volume_data ORDER BY id DESC LIMIT 200
      ) AS latest
      JOIN (
        SELECT * FROM volume_data ORDER BY id DESC LIMIT 200, 200
      ) AS t4 ON latest.symbol = t4.symbol
      JOIN (
        SELECT * FROM volume_data ORDER BY id DESC LIMIT 400, 200
      ) AS t8 ON latest.symbol = t8.symbol
      ORDER BY yuzdelik ASC
      LIMIT 15;
    `);
    res.json(rows);
  } catch (error) {
    console.error('Hata:', error);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});

app.get('/coin/:slug/history', async (req, res) => {
  const slug = req.params.slug;
  //console.log('verileri çekme isteği ==>:', slug);

  try {
    const [rows] = await pool.execute(
      `SELECT timestamp, price, volume, marketcap
       FROM volume_data
       WHERE slug = ?
         AND timestamp >= NOW() - INTERVAL 3 DAY
       ORDER BY timestamp ASC`,
      [slug]
    );

    res.json({
      slug,
      data: rows,
    });

  } catch (error) {
    console.error('Veri çekme hatası:', error);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});


app.get('/api/signals', async (req, res) => {
  try {
    const {
      symbol,
      result,
      since_hours = '72',
      limit = '100',
    } = req.query;

    const params = [];
    let where = '1=1';

    if (since_hours && Number(since_hours) > 0) {
      where += ' AND ss.ts >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)';
      params.push(Number(since_hours));
    }
    if (symbol) {
      where += ' AND ss.symbol = ?';
      params.push(String(symbol).toUpperCase());
    }
    if (result) {
      if (result === 'null') {
        where += ' AND ss.result IS NULL';
      } else {
        where += ' AND ss.result = ?';
        params.push(result);
      }
    }

    const sql = `
      SELECT
        ss.id, ss.ts, ss.symbol, ss.position, ss.entryprice, ss.tp1, ss.tp2, ss.sl,
        ss.result, ss.result_updated_at,
        EXISTS(SELECT 1 FROM fut_trades ft WHERE ft.source_signal_id = ss.id) AS traded
      FROM signals_simple ss
      WHERE ${where}
      ORDER BY ss.ts DESC
      LIMIT ?
    `;
    params.push(Math.min(Number(limit) || 100, 1000));

    const [rows] = await pool.query(sql, params);

    // yüzde farkları hesaplayıp ekleyelim + traded aynen geçir
    const withPct = rows.map(r => {
      const entry = Number(r.entryprice);
      const tp1 = Number(r.tp1);
      const tp2 = Number(r.tp2);
      const sl  = Number(r.sl);

      const pct = (a,b)=> (Number.isFinite(a)&&Number.isFinite(b)&&b!==0)?(((a-b)/b)*100):null;

      return {
        ...r,
        traded: !!r.traded, // 0/1 -> boolean
        tp1_pct: Number.isFinite(pct(tp1, entry)) ? Number(pct(tp1, entry).toFixed(2)) : null,
        tp2_pct: Number.isFinite(pct(tp2, entry)) ? Number(pct(tp2, entry).toFixed(2)) : null,
        sl_pct:  Number.isFinite(pct(sl,  entry)) ? Number(pct(sl,  entry).toFixed(2))  : null,
      };
    });

    res.json(withPct);
  } catch (err) {
    console.error('[/api/signals] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});


/** -------------------------------
 *  CMC ANALYZE API
 *  ------------------------------*/

/**
 * GET /api/cmc/ath
 * Query:
 *  - listing: 'spot' | 'alpha' | 'futures' | 'spot-futures' | ... (çoklu label içerir)
 *  - has_ath_price: '1' sadece ath_price_usd dolu olanlar
 *  - search: 'btc'  (symbol/slug/ binance_symbol içinde arar)
 *  - sort: 'ath_price_usd' | 'ath_price_date' | 'days_since_ath' | 'launch_date'
 *  - order: 'asc' | 'desc'
 *  - limit: default 100 (max 500)
 */
app.get('/api/cmc/ath', async (req, res) => {
  try {
    const {
      listing = '',            // içerir: 'futures' vs
      has_ath_price = '',      // '1' olursa sadece fiyatı olanlar
      search = '',
      sort = 'ath_price_usd',
      order = 'desc',
      limit = '100',
    } = req.query;

    const params = [];
    let where = '1=1';

    if (listing) {
      // varchar içinde arama: 'spot', 'alpha', 'futures' vb.
      where += ' AND binance_listing_type LIKE ?';
      params.push(`%${listing.toLowerCase()}%`);
    }
    if (has_ath_price === '1') {
      where += ' AND ath_price_usd IS NOT NULL AND ath_price_date IS NOT NULL';
    }
    if (search) {
      where += ' AND (cmc_symbol LIKE ? OR cmc_slug LIKE ? OR binance_symbol LIKE ?)';
      params.push(`%${search.toUpperCase()}%`, `%${search.toLowerCase()}%`, `%${search.toUpperCase()}%`);
    }

    // güvenli sıralama (whitelist)
    const SORT_ALLOW = new Set(['ath_price_usd', 'ath_price_date', 'days_since_ath', 'launch_date', 'cmc_symbol']);
    const ORDER_ALLOW = new Set(['asc', 'desc']);
    const sortCol = SORT_ALLOW.has(String(sort)) ? sort : 'ath_price_usd';
    const sortOrd = ORDER_ALLOW.has(String(order).toLowerCase()) ? order : 'desc';
    const lim = Math.min(Number(limit) || 100, 500);

    const sql = `
      SELECT
        cmc_id, cmc_slug, cmc_symbol,
        launch_date,
        ath_price_usd, ath_price_date,
        days_since_ath,
        binance_listing_type, binance_symbol,
        is_delist,
        JSON_EXTRACT(COALESCE(meta,'{}'), '$.ath_price_source') AS ath_price_source
      FROM cmc_analyze
      WHERE ${where}
      ORDER BY ${sortCol} ${sortOrd}
      LIMIT ?
    `;
    params.push(lim);

    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('[/api/cmc/ath] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});

/**
 * GET /api/cmc/:slug
 * Tek coin detayı
 */
app.get('/api/cmc/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const [rows] = await pool.query(
      `
      SELECT
        cmc_id, cmc_slug, cmc_symbol,
        launch_date,
        ath_price_usd, ath_price_date,
        days_since_ath,
        binance_listing_type, binance_symbol,
        is_delist,
        meta,
        fetched_at_utc
      FROM cmc_analyze
      WHERE cmc_slug = ?
      LIMIT 1
      `,
      [slug]
    );
    if (!rows.length) return res.status(404).json({ error: 'Bulunamadı' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[/api/cmc/:slug] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});


// Sunucu başlatma
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
