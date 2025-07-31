require('dotenv').config({ path: __dirname + '/.env' });
const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

app.get('/top-increase', async (req, res) => {
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
      SELECT * FROM your_table ORDER BY id DESC LIMIT 200
    ) AS latest
    JOIN (
      SELECT * FROM your_table ORDER BY id DESC LIMIT 200, 200
    ) AS t4 ON latest.symbol = t4.symbol
    JOIN (
      SELECT * FROM your_table ORDER BY id DESC LIMIT 400, 200
    ) AS t8 ON latest.symbol = t8.symbol
    ORDER BY yuzdelik DESC
    LIMIT 15
  `);
  res.json(rows);
});


// Sunucu başlatma
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
