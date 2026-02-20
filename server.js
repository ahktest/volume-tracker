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


// ✅ Basit güvenlik: dashboard API'leri için header key kontrolü
const DASH_KEY = "ahktest";
function requireDashKey(req, res, next) {
  const k = req.headers['x-dash-key'];
  if (k !== DASH_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.get("/ping", (req, res) => res.send("pong"));

/**
 * helpers: where builder (since_days)
 */
function buildWhereSinceDays(since_days) {
  const params = [];
  let where = "status = 'CLOSED' AND pnl IS NOT NULL AND date2 IS NOT NULL";

  const n = Number(since_days);
  if (!Number.isNaN(n) && n > 0) {
    where += " AND date2 >= (UTC_TIMESTAMP() - INTERVAL ? DAY)";
    params.push(n);
  }

  return { where, params };
}

/**
 * GET /api/futures-pnl?since_days=30
 * daily pnl + stats (win/loss)
 * pnl formula: pnl - funding_fee - commission
 */
app.get('/api/futures-pnl', requireDashKey, async (req, res) => {
  try {
    const { since_days = '30' } = req.query;
    const { where, params } = buildWhereSinceDays(since_days);

    const dailySql = `
      SELECT
        DATE(date2) AS date,
        SUM(
          pnl
          - IFNULL(funding_fee, 0)
          - IFNULL(commission, 0)
        ) AS pnl
      FROM futures_positions
      WHERE ${where}
      GROUP BY DATE(date2)
      ORDER BY DATE(date2) ASC
    `;

    const wlSql = `
      SELECT
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) < 0 THEN 1 ELSE 0 END) AS losses,
        COUNT(*) AS total,
        SUM(pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) AS totalPnl
      FROM futures_positions
      WHERE ${where}
    `;

    const [dailyRows] = await pool.query(dailySql, params);
    const [[wl]] = await pool.query(wlSql, params);

    const daily = dailyRows.map(r => ({
      date: r.date,
      pnl: Number(r.pnl || 0),
    }));

    const wins   = Number(wl.wins || 0);
    const losses = Number(wl.losses || 0);
    const total  = Number(wl.total || 0);
    const totalPnl = Number(wl.totalPnl || 0);
    const winRate = total > 0 ? (wins / total) * 100 : 0;

    res.json({
      daily,
      stats: {
        wins,
        losses,
        total,
        totalPnl: Number(totalPnl.toFixed(8)),
        winRate: Number(winRate.toFixed(2)),
      },
    });
  } catch (err) {
    console.error('[/api/futures-pnl] Hata:', err);
    res.status(500).json({ error: 'PNL verisi alınamadı' });
  }
});

/**
 * GET /api/futures-summary?since_days=30
 * source=normal vs funding ayrı özet:
 * wins, losses, winRate, pnl
 */
app.get('/api/futures-summary', requireDashKey, async (req, res) => {
  try {
    const { since_days = '30' } = req.query;
    const { where, params } = buildWhereSinceDays(since_days);

    const sql = `
      SELECT
        source,
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) < 0 THEN 1 ELSE 0 END) AS losses,
        COUNT(*) AS total,
        SUM(pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) AS pnl
      FROM futures_positions
      WHERE ${where}
      GROUP BY source
    `;

    const [rows] = await pool.query(sql, params);

    const bySource = {};
    for (const r of rows) {
      const wins = Number(r.wins || 0);
      const losses = Number(r.losses || 0);
      const total = Number(r.total || 0);
      const pnl = Number(r.pnl || 0);
      const winRate = total > 0 ? (wins / total) * 100 : 0;

      bySource[r.source] = {
        wins,
        losses,
        total,
        pnl: Number(pnl.toFixed(8)),
        winRate: Number(winRate.toFixed(2)),
      };
    }

    // kaynak yoksa default objeler
    if (!bySource.normal) bySource.normal = { wins:0, losses:0, total:0, pnl:0, winRate:0 };
    if (!bySource.funding) bySource.funding = { wins:0, losses:0, total:0, pnl:0, winRate:0 };

    res.json({ bySource });
  } catch (err) {
    console.error('[/api/futures-summary] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});

/**
 * GET /api/futures-daily?limit=14
 * Günlük W/L + PNL (son N gün, DESC)
 */
app.get('/api/futures-daily', requireDashKey, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit || 14) || 14, 60);

    const sql = `
      SELECT
        DATE(date2) AS date,
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) > 0 THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN (pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) < 0 THEN 1 ELSE 0 END) AS losses,
        SUM(pnl - IFNULL(funding_fee,0) - IFNULL(commission,0)) AS pnl
      FROM futures_positions
      WHERE status='CLOSED' AND pnl IS NOT NULL AND date2 IS NOT NULL
      GROUP BY DATE(date2)
      ORDER BY DATE(date2) DESC
      LIMIT ?
    `;

    const [rows] = await pool.query(sql, [limit]);
    res.json(rows.map(r => ({
      date: r.date,
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      pnl: Number(r.pnl || 0),
    })));
  } catch (err) {
    console.error('[/api/futures-daily] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});

/**
 * GET /api/futures-balance-changes
 * total_futures_balance değişimi:
 * - 7d / 30d / YTD
 *
 * Not: total_futures_balance "CLOSED" satırlarda dolu olmalı.
 */
app.get('/api/futures-balance-changes', requireDashKey, async (req, res) => {
  try {
    const sql = `
      SELECT
        (
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND date2 >= UTC_TIMESTAMP() - INTERVAL 7 DAY
           ORDER BY date2 DESC
           LIMIT 1)
          -
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND date2 >= UTC_TIMESTAMP() - INTERVAL 7 DAY
           ORDER BY date2 ASC
           LIMIT 1)
        ) AS diff_7d,

        (
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND date2 >= UTC_TIMESTAMP() - INTERVAL 30 DAY
           ORDER BY date2 DESC
           LIMIT 1)
          -
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND date2 >= UTC_TIMESTAMP() - INTERVAL 30 DAY
           ORDER BY date2 ASC
           LIMIT 1)
        ) AS diff_30d,

        (
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND YEAR(date2) = YEAR(UTC_TIMESTAMP())
           ORDER BY date2 DESC
           LIMIT 1)
          -
          (SELECT total_futures_balance
           FROM futures_positions
           WHERE status='CLOSED' AND total_futures_balance IS NOT NULL
             AND YEAR(date2) = YEAR(UTC_TIMESTAMP())
           ORDER BY date2 ASC
           LIMIT 1)
        ) AS diff_ytd
    `;

    const [[row]] = await pool.query(sql);

    res.json({
      diff_7d: Number(row.diff_7d || 0),
      diff_30d: Number(row.diff_30d || 0),
      diff_ytd: Number(row.diff_ytd || 0),
    });
  } catch (err) {
    console.error('[/api/futures-balance-changes] Hata:', err);
    res.status(500).json({ error: 'Veri alınamadı' });
  }
});

/**
 * GET /api/futures-balance-history
 * total_futures_balance zaman serisi (CLOSED)
 */
app.get('/api/futures-balance-history', requireDashKey, async (req, res) => {
  try {
    const sql = `
      SELECT
        DATE(date2) AS date,
        MAX(total_futures_balance) AS balance
      FROM futures_positions
      WHERE status='CLOSED'
        AND total_futures_balance IS NOT NULL
        AND date2 IS NOT NULL
      GROUP BY DATE(date2)
      ORDER BY DATE(date2) ASC
    `;

    const [rows] = await pool.query(sql);

    res.json(rows.map(r => ({
      date: r.date,
      balance: Number(r.balance || 0),
    })));
  } catch (err) {
    console.error('[/api/futures-balance-history] Hata:', err);
    res.status(500).json({ error: 'Balance verisi alınamadı' });
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


/** ────────────────────────────────────────────
 *  SIGNAL SCORES API (anomali-signal-resolv)
 *  ──────────────────────────────────────────── */

/**
 * GET /api/signals/scores
 * Tum skorlari listele (snapshot + score JOIN)
 * En yeniden eskiye, manual_direction_ok veya manual_result bos olanlar uste
 */
app.get('/api/signals/scores', requireDashKey, async (req, res) => {
  try {
    const sql = `
      SELECT
        sc.id,
        sc.symbol,
        sc.score,
        sc.direction,
        sc.confidence,
        sc.tp1,
        sc.tp2,
        sc.sl,
        sc.manual_direction_ok,
        sc.manual_result,
        sc.exception_applied,
        sc.created_at,
        sn.source_type,
        sn.entry_price,
        sn.funding_fee,
        sn.volume_change,
        sn.price_change
      FROM signal_scores sc
      LEFT JOIN signal_snapshots sn ON sn.id = sc.signal_snapshot_id
      ORDER BY
        (sc.manual_direction_ok IS NULL OR sc.manual_result IS NULL) DESC,
        sc.created_at DESC
      LIMIT 200
    `;
    const [rows] = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error('[/api/signals/scores] Hata:', err);
    res.status(500).json({ error: 'Veri alinamadi' });
  }
});

/**
 * PATCH /api/signals/scores/:id
 * Manuel degerlendirme guncelle
 * Body: { manual_direction_ok: 1|0|null, manual_result: 'tp1'|'tp2'|'sl'|null }
 */
app.patch('/api/signals/scores/:id', requireDashKey, async (req, res) => {
  try {
    const { id } = req.params;
    const { manual_direction_ok, manual_result } = req.body;

    // Validate
    if (manual_direction_ok !== null && manual_direction_ok !== 0 && manual_direction_ok !== 1) {
      return res.status(400).json({ error: 'manual_direction_ok: 0, 1 veya null olmali' });
    }
    const validResults = ['tp1', 'tp2', 'sl', null];
    if (!validResults.includes(manual_result)) {
      return res.status(400).json({ error: 'manual_result: tp1, tp2, sl veya null olmali' });
    }

    const [result] = await pool.execute(
      `UPDATE signal_scores
       SET manual_direction_ok = ?, manual_result = ?, updated_at = NOW()
       WHERE id = ?`,
      [manual_direction_ok, manual_result, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kayit bulunamadi' });
    }

    res.json({ ok: true, id: Number(id) });
  } catch (err) {
    console.error('[PATCH /api/signals/scores] Hata:', err);
    res.status(500).json({ error: 'Guncelleme hatasi' });
  }
});

/**
 * GET /api/signals/stats
 * Dashboard istatistikleri:
 * - totals: toplam, degerlendirilmis, yon basarisi, tp1/tp2/sl sayilari
 * - by_source: source_type bazli kirilim
 * - daily: gunluk detay (son 30 gun)
 */
app.get('/api/signals/stats', requireDashKey, async (req, res) => {
  try {
    // 1. Genel toplamlar
    const [[totals]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN manual_direction_ok IS NOT NULL AND manual_result IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
        SUM(CASE WHEN manual_direction_ok IS NULL OR manual_result IS NULL THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN manual_direction_ok = 1 THEN 1 ELSE 0 END) AS direction_correct,
        SUM(CASE WHEN manual_result = 'tp1' THEN 1 ELSE 0 END) AS tp1_count,
        SUM(CASE WHEN manual_result = 'tp2' THEN 1 ELSE 0 END) AS tp2_count,
        SUM(CASE WHEN manual_result = 'sl' THEN 1 ELSE 0 END) AS sl_count
      FROM signal_scores
    `);

    // 2. Source type bazli kirilim
    const [bySourceRows] = await pool.query(`
      SELECT
        COALESCE(sn.source_type, 'unknown') AS source_type,
        COUNT(*) AS total,
        SUM(CASE WHEN sc.manual_direction_ok IS NOT NULL AND sc.manual_result IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
        SUM(CASE WHEN sc.manual_direction_ok = 1 THEN 1 ELSE 0 END) AS direction_correct,
        SUM(CASE WHEN sc.manual_result = 'tp1' THEN 1 ELSE 0 END) AS tp1_count,
        SUM(CASE WHEN sc.manual_result = 'tp2' THEN 1 ELSE 0 END) AS tp2_count,
        SUM(CASE WHEN sc.manual_result = 'sl' THEN 1 ELSE 0 END) AS sl_count
      FROM signal_scores sc
      LEFT JOIN signal_snapshots sn ON sn.id = sc.signal_snapshot_id
      GROUP BY COALESCE(sn.source_type, 'unknown')
    `);

    const by_source = {};
    for (const r of bySourceRows) {
      by_source[r.source_type] = {
        total: Number(r.total),
        reviewed: Number(r.reviewed),
        direction_correct: Number(r.direction_correct),
        tp1_count: Number(r.tp1_count),
        tp2_count: Number(r.tp2_count),
        sl_count: Number(r.sl_count),
      };
    }

    // 3. Gunluk detay (son 30 gun)
    const [dailyRows] = await pool.query(`
      SELECT
        DATE(sc.created_at) AS date,
        COUNT(*) AS total,
        SUM(CASE WHEN sc.manual_direction_ok IS NOT NULL AND sc.manual_result IS NOT NULL THEN 1 ELSE 0 END) AS reviewed,
        SUM(CASE WHEN sc.manual_direction_ok = 1 THEN 1 ELSE 0 END) AS direction_correct,
        SUM(CASE WHEN sc.manual_result = 'tp1' THEN 1 ELSE 0 END) AS tp1_count,
        SUM(CASE WHEN sc.manual_result = 'tp2' THEN 1 ELSE 0 END) AS tp2_count,
        SUM(CASE WHEN sc.manual_result = 'sl' THEN 1 ELSE 0 END) AS sl_count
      FROM signal_scores sc
      WHERE sc.created_at >= NOW() - INTERVAL 30 DAY
      GROUP BY DATE(sc.created_at)
      ORDER BY DATE(sc.created_at) DESC
    `);

    const daily = dailyRows.map(r => ({
      date: r.date,
      total: Number(r.total),
      reviewed: Number(r.reviewed),
      direction_correct: Number(r.direction_correct),
      tp1_count: Number(r.tp1_count),
      tp2_count: Number(r.tp2_count),
      sl_count: Number(r.sl_count),
    }));

    res.json({
      totals: {
        total: Number(totals.total),
        reviewed: Number(totals.reviewed),
        pending: Number(totals.pending),
        direction_correct: Number(totals.direction_correct),
        tp1_count: Number(totals.tp1_count),
        tp2_count: Number(totals.tp2_count),
        sl_count: Number(totals.sl_count),
      },
      by_source,
      daily,
    });
  } catch (err) {
    console.error('[/api/signals/stats] Hata:', err);
    res.status(500).json({ error: 'Istatistik alinamadi' });
  }
});


// Sunucu baslatma
app.listen(PORT, () => {
  console.log(`Sunucu calisiyor: http://localhost:${PORT}`);
});
