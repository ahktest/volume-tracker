// server.js  (CommonJS)
// Çalıştırma: pm2 restart sim-api  (veya node server.js)

const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// .env yoksa varsayılanları kullan
const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_USER = process.env.DB_USER || 'ahktest';
const DB_PASS = process.env.DB_PASS || '123';
const DB_NAME = process.env.DB_NAME || 'volume_tracker';
const PORT    = process.env.SIM_API_PORT || 3020;

// DECIMAL’ları number döndürmesi için: decimalNumbers: true
const pool = mysql.createPool({
  host: DB_HOST,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  decimalNumbers: true, // <-- kritik
});

app.get('/health', (_req, res) => res.send('ok'));

/**
 * Özet endpoint:
 * avg_pnl ve total_pnl FRONTEND'e number olarak gitsin diye
 * CAST(... AS DOUBLE) ile garanti altına aldık.
 */
app.get('/api/sim/summary', async (_req, res) => {
  let conn;
  try {
    conn = await pool.getConnection();
    const [rows] = await conn.query(`
      SELECT
        position,
        COUNT(*) AS trades,
        CAST(ROUND(AVG(pnl), 2) AS DOUBLE)  AS avg_pnl,
        CAST(ROUND(SUM(pnl), 2) AS DOUBLE)  AS total_pnl
      FROM simulasyon
      WHERE pnl IS NOT NULL AND timestamp > '2025-09-16 16:46:11'
      GROUP BY position
      ORDER BY trades DESC, position ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/sim/summary hata:', err);
    res.status(500).json({ error: 'summary_error' });
  } finally {
    if (conn) conn.release();
  }
});

/**
 * Liste endpoint (opsiyonel): /api/sim/list?position=long
 * Tablo sayfası için verileri döner.
 */
app.get('/api/sim/list', async (req, res) => {
  const { position } = req.query; // ör: 'long', 'potansiyel long', 'short', ...
  let conn;
  try {
    conn = await pool.getConnection();

    let sql = `
      SELECT
        id,
        timestamp,
        coin,
        coinslug,
        CAST(price  AS DOUBLE) AS price,
        position,
        CAST(volume_percent AS DOUBLE) AS volume_percent,
        CAST(nprice AS DOUBLE) AS nprice,
        CAST(pnl    AS DOUBLE) AS pnl
      FROM simulasyon
    `;
    const params = [];

    if (position) {
      sql += ` WHERE position = ?`;
      params.push(position);
    }

    sql += ` ORDER BY timestamp DESC LIMIT 500`;

    const [rows] = await conn.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('❌ /api/sim/list hata:', err);
    res.status(500).json({ error: 'list_error' });
  } finally {
    if (conn) conn.release();
  }
});

app.listen(PORT, () => {
  console.log(`✅ sim-api hazır: http://127.0.0.1:${PORT}`);
});