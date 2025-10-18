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
      where += ' AND ts >= (UTC_TIMESTAMP() - INTERVAL ? HOUR)';
      params.push(Number(since_hours));
    }
    if (symbol) {
      where += ' AND symbol = ?';
      params.push(String(symbol).toUpperCase());
    }
    if (result) {
      if (result === 'null') {
        where += ' AND result IS NULL';
      } else {
        where += ' AND result = ?';
        params.push(result);
      }
    }

    const sql = `
      SELECT
        id, ts, symbol, position, entryprice, tp1, tp2, sl, result
      FROM signals_simple
      WHERE ${where}
      ORDER BY ts DESC
      LIMIT ?
    `;
    params.push(Math.min(Number(limit) || 100, 1000));

    const [rows] = await pool.query(sql, params);

    // yüzde farkları hesaplayıp ekleyelim (kullanışlı oluyor)
    const withPct = rows.map(r => {
      const entry = Number(r.entryprice);
      const tp1 = Number(r.tp1);
      const tp2 = Number(r.tp2);
      const sl  = Number(r.sl);

      const pct = (a,b)=> (Number.isFinite(a)&&Number.isFinite(b)&&b!==0)?(((a-b)/b)*100):null;

      return {
        ...r,
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


// Sunucu başlatma
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
