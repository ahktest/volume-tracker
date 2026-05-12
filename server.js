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
    const limit  = Math.min(Math.max(Number(req.query.limit)  || 100, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const date   = req.query.date;       // YYYY-MM-DD
    const filter = req.query.filter;     // certain | uncertain | open | completed | null

    const where = [];
    const params = [];

    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      where.push('DATE(sc.created_at) = ?');
      params.push(date);
    }
    if (filter === 'certain')   where.push("sc.direction IN ('LONG','SHORT')");
    if (filter === 'uncertain') where.push("sc.direction = 'UNCERTAIN'");
    if (filter === 'open')      where.push('(so.is_completed = 0 OR so.is_completed IS NULL)');
    if (filter === 'completed') where.push('so.is_completed = 1');

    const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total
       FROM signal_scores sc
       LEFT JOIN signal_outcomes so ON so.signal_score_id = sc.id
       ${whereSql}`,
      params
    );

    const [rows] = await pool.query(`
      SELECT
        sc.id,
        sc.symbol,
        sc.score,
        sc.direction,
        sc.confidence,
        sc.tp1,
        sc.tp2,
        sc.sl,
        sc.exception_applied,
        sc.created_at,
        sn.source_type,
        sn.entry_price,
        sn.funding_fee,
        sn.volume_change,
        sn.price_change,
        sn.listing_type,
        so.direction_correct,
        so.final_result,
        so.final_state,
        so.exit_reason,
        so.realized_pnl_pct,
        so.is_completed,
        so.tp1_hit_ever,
        so.tp2_hit_ever,
        so.sl_hit_ever,
        so.max_win_pct,
        so.max_loss_pct,
        so.tp1_hit_at
      FROM signal_scores sc
      LEFT JOIN signal_snapshots sn ON sn.id = sc.signal_snapshot_id
      LEFT JOIN signal_outcomes so ON so.signal_score_id = sc.id
      ${whereSql}
      ORDER BY sc.created_at DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]);

    res.json({ rows, total: Number(total), limit, offset });
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
    /**
     * Sonuclar artik signal_outcomes tablosundan geliyor.
     * Iki ana grup:
     *  - CERTAIN: direction IN ('LONG','SHORT')  -> direction_correct anlamli
     *  - UNCERTAIN: direction = 'UNCERTAIN'      -> sadece pnl ve seviye gecisleri
     */

    const certainWhere = `so.direction IN ('LONG','SHORT')`;
    const uncertainWhere = `so.direction = 'UNCERTAIN'`;

    // Win/loss/neutral kategorileri final_result uzerinden:
    //   WIN     = dir_correct_tp1, dir_correct_tp2
    //   LOSS    = dir_correct_sl, dir_wrong_tp1, dir_wrong_sl
    //   NEUTRAL = neutral
    const winExpr  = `so.final_result IN ('dir_correct_tp1','dir_correct_tp2')`;
    const lossExpr = `so.final_result IN ('dir_correct_sl','dir_wrong_tp1','dir_wrong_sl')`;
    const neuExpr  = `so.final_result = 'neutral'`;

    // --- 1. CERTAIN totals ---
    const [[certainTotals]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(so.is_completed = 1) AS completed,
        SUM(so.is_completed = 0) AS pending,
        SUM(so.direction_correct = 1) AS direction_correct,
        SUM(${winExpr})  AS wins,
        SUM(${lossExpr}) AS losses,
        SUM(${neuExpr})  AS neutrals,
        SUM(so.tp1_hit_ever = 1) AS tp1_hit,
        SUM(so.tp2_hit_ever = 1) AS tp2_hit,
        SUM(so.sl_hit_ever  = 1) AS sl_hit,
        AVG(so.realized_pnl_pct) AS avg_pnl,
        SUM(so.realized_pnl_pct) AS total_pnl
      FROM signal_outcomes so
      WHERE ${certainWhere}
    `);

    // --- 2. UNCERTAIN totals ---
    const [[uncertainTotals]] = await pool.query(`
      SELECT
        COUNT(*) AS total,
        SUM(so.is_completed = 1) AS completed,
        SUM(so.is_completed = 0) AS pending,
        SUM(so.tp1_hit_ever = 1) AS tp1_hit,
        SUM(so.tp2_hit_ever = 1) AS tp2_hit,
        SUM(so.sl_hit_ever  = 1) AS sl_hit,
        AVG(so.realized_pnl_pct) AS avg_pnl,
        SUM(so.realized_pnl_pct) AS total_pnl
      FROM signal_outcomes so
      WHERE ${uncertainWhere}
    `);

    // --- 3. final_result dagilimi (sadece certain) ---
    const [finalResultRows] = await pool.query(`
      SELECT
        COALESCE(so.final_result, 'pending') AS final_result,
        COUNT(*) AS count
      FROM signal_outcomes so
      WHERE ${certainWhere}
      GROUP BY COALESCE(so.final_result, 'pending')
    `);
    const by_final_result = {};
    for (const r of finalResultRows) {
      by_final_result[r.final_result] = Number(r.count);
    }

    // --- 4. Source type bazli (certain + uncertain ayri) ---
    const [bySourceRows] = await pool.query(`
      SELECT
        COALESCE(sn.source_type, 'unknown') AS source_type,
        SUM(so.direction IN ('LONG','SHORT')) AS certain_total,
        SUM(so.direction IN ('LONG','SHORT') AND so.direction_correct = 1) AS certain_dir_correct,
        SUM(so.direction IN ('LONG','SHORT') AND ${winExpr}) AS certain_wins,
        SUM(so.direction IN ('LONG','SHORT') AND ${lossExpr}) AS certain_losses,
        SUM(so.direction IN ('LONG','SHORT') AND so.tp1_hit_ever = 1) AS certain_tp1,
        SUM(so.direction IN ('LONG','SHORT') AND so.tp2_hit_ever = 1) AS certain_tp2,
        SUM(so.direction IN ('LONG','SHORT') AND so.sl_hit_ever  = 1) AS certain_sl,
        AVG(CASE WHEN so.direction IN ('LONG','SHORT') THEN so.realized_pnl_pct END) AS certain_avg_pnl,
        SUM(so.direction = 'UNCERTAIN') AS uncertain_total,
        AVG(CASE WHEN so.direction = 'UNCERTAIN' THEN so.realized_pnl_pct END) AS uncertain_avg_pnl
      FROM signal_outcomes so
      JOIN signal_scores sc ON sc.id = so.signal_score_id
      LEFT JOIN signal_snapshots sn ON sn.id = sc.signal_snapshot_id
      GROUP BY COALESCE(sn.source_type, 'unknown')
    `);
    const by_source = {};
    for (const r of bySourceRows) {
      by_source[r.source_type] = {
        certain_total: Number(r.certain_total || 0),
        certain_dir_correct: Number(r.certain_dir_correct || 0),
        certain_wins: Number(r.certain_wins || 0),
        certain_losses: Number(r.certain_losses || 0),
        certain_tp1: Number(r.certain_tp1 || 0),
        certain_tp2: Number(r.certain_tp2 || 0),
        certain_sl: Number(r.certain_sl || 0),
        certain_avg_pnl: r.certain_avg_pnl == null ? null : Number(Number(r.certain_avg_pnl).toFixed(2)),
        uncertain_total: Number(r.uncertain_total || 0),
        uncertain_avg_pnl: r.uncertain_avg_pnl == null ? null : Number(Number(r.uncertain_avg_pnl).toFixed(2)),
      };
    }

    // --- 5. Direction bazli (LONG vs SHORT) ---
    const [byDirRows] = await pool.query(`
      SELECT
        so.direction,
        COUNT(*) AS total,
        SUM(so.is_completed = 1) AS completed,
        SUM(so.direction_correct = 1) AS direction_correct,
        SUM(${winExpr})  AS wins,
        SUM(${lossExpr}) AS losses,
        SUM(so.tp1_hit_ever = 1) AS tp1_hit,
        SUM(so.tp2_hit_ever = 1) AS tp2_hit,
        SUM(so.sl_hit_ever  = 1) AS sl_hit,
        AVG(so.realized_pnl_pct) AS avg_pnl,
        SUM(so.realized_pnl_pct) AS total_pnl
      FROM signal_outcomes so
      WHERE ${certainWhere}
      GROUP BY so.direction
    `);
    const by_direction = {};
    for (const r of byDirRows) {
      by_direction[r.direction] = {
        total: Number(r.total),
        completed: Number(r.completed || 0),
        direction_correct: Number(r.direction_correct || 0),
        wins: Number(r.wins || 0),
        losses: Number(r.losses || 0),
        tp1_hit: Number(r.tp1_hit || 0),
        tp2_hit: Number(r.tp2_hit || 0),
        sl_hit: Number(r.sl_hit || 0),
        avg_pnl: r.avg_pnl == null ? null : Number(Number(r.avg_pnl).toFixed(2)),
        total_pnl: r.total_pnl == null ? null : Number(Number(r.total_pnl).toFixed(2)),
      };
    }

    // --- 6. Listing type bazli (certain only) ---
    const [byListingRows] = await pool.query(`
      SELECT
        COALESCE(sn.listing_type, 'unknown') AS listing_type,
        COUNT(*) AS total,
        SUM(so.direction_correct = 1) AS direction_correct,
        SUM(${winExpr})  AS wins,
        SUM(${lossExpr}) AS losses,
        SUM(so.tp1_hit_ever = 1) AS tp1_hit,
        SUM(so.tp2_hit_ever = 1) AS tp2_hit,
        SUM(so.sl_hit_ever  = 1) AS sl_hit,
        AVG(so.realized_pnl_pct) AS avg_pnl
      FROM signal_outcomes so
      JOIN signal_scores sc ON sc.id = so.signal_score_id
      LEFT JOIN signal_snapshots sn ON sn.id = sc.signal_snapshot_id
      WHERE ${certainWhere}
      GROUP BY COALESCE(sn.listing_type, 'unknown')
    `);
    const by_listing = {};
    for (const r of byListingRows) {
      by_listing[r.listing_type] = {
        total: Number(r.total),
        direction_correct: Number(r.direction_correct || 0),
        wins: Number(r.wins || 0),
        losses: Number(r.losses || 0),
        tp1_hit: Number(r.tp1_hit || 0),
        tp2_hit: Number(r.tp2_hit || 0),
        sl_hit: Number(r.sl_hit || 0),
        avg_pnl: r.avg_pnl == null ? null : Number(Number(r.avg_pnl).toFixed(2)),
      };
    }

    // --- 7. Gunluk detay (son 30 gun) ---
    const [dailyRows] = await pool.query(`
      SELECT
        DATE(so.created_at) AS date,
        COUNT(*) AS total,
        SUM(so.direction IN ('LONG','SHORT')) AS certain_total,
        SUM(so.direction = 'UNCERTAIN') AS uncertain_total,
        SUM(so.is_completed = 1) AS completed,
        SUM(so.direction IN ('LONG','SHORT') AND so.direction_correct = 1) AS direction_correct,
        SUM(so.direction IN ('LONG','SHORT') AND ${winExpr}) AS wins,
        SUM(so.direction IN ('LONG','SHORT') AND ${lossExpr}) AS losses,
        SUM(so.tp1_hit_ever = 1) AS tp1_hit,
        SUM(so.tp2_hit_ever = 1) AS tp2_hit,
        SUM(so.sl_hit_ever  = 1) AS sl_hit,
        AVG(so.realized_pnl_pct) AS avg_pnl
      FROM signal_outcomes so
      WHERE so.created_at >= NOW() - INTERVAL 30 DAY
      GROUP BY DATE(so.created_at)
      ORDER BY DATE(so.created_at) DESC
    `);
    const daily = dailyRows.map(r => ({
      date: r.date,
      total: Number(r.total),
      certain_total: Number(r.certain_total || 0),
      uncertain_total: Number(r.uncertain_total || 0),
      completed: Number(r.completed || 0),
      direction_correct: Number(r.direction_correct || 0),
      wins: Number(r.wins || 0),
      losses: Number(r.losses || 0),
      tp1_hit: Number(r.tp1_hit || 0),
      tp2_hit: Number(r.tp2_hit || 0),
      sl_hit: Number(r.sl_hit || 0),
      avg_pnl: r.avg_pnl == null ? null : Number(Number(r.avg_pnl).toFixed(2)),
    }));

    const num = (v) => Number(v || 0);
    const round = (v) => v == null ? null : Number(Number(v).toFixed(2));

    res.json({
      certain: {
        total: num(certainTotals.total),
        completed: num(certainTotals.completed),
        pending: num(certainTotals.pending),
        direction_correct: num(certainTotals.direction_correct),
        wins: num(certainTotals.wins),
        losses: num(certainTotals.losses),
        neutrals: num(certainTotals.neutrals),
        tp1_hit: num(certainTotals.tp1_hit),
        tp2_hit: num(certainTotals.tp2_hit),
        sl_hit: num(certainTotals.sl_hit),
        avg_pnl: round(certainTotals.avg_pnl),
        total_pnl: round(certainTotals.total_pnl),
      },
      uncertain: {
        total: num(uncertainTotals.total),
        completed: num(uncertainTotals.completed),
        pending: num(uncertainTotals.pending),
        tp1_hit: num(uncertainTotals.tp1_hit),
        tp2_hit: num(uncertainTotals.tp2_hit),
        sl_hit: num(uncertainTotals.sl_hit),
        avg_pnl: round(uncertainTotals.avg_pnl),
        total_pnl: round(uncertainTotals.total_pnl),
      },
      by_final_result,
      by_source,
      by_direction,
      by_listing,
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
