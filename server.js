const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Veritabanı bağlantısı
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// API: Son veri çekim tarihindeki en yüksek hacim artışı
app.get("/top-gainers", (req, res) => {
      console.log("🟢 /top-gainers isteği alındı"); // ← Bu satırı en üste ekle

    pool.query(`SELECT MAX(timestamp) as max_time FROM volume_data`, (err, result) => {
    if (err) return console.error("Max timestamp hatası:", err);
    console.log("⏱️ En son timestamp:", result[0].max_time);
  });

  pool.query(`
    SELECT 
      t1.symbol,
      t1.price,
      t1.volume AS last_volume,
      t2.volume AS volume_4h_ago,
      t3.volume AS volume_8h_ago,
      ROUND(((t1.volume - t2.volume) / t2.volume) * 100, 2) AS volume_change_percent,
      t1.slug,
      t1.timestamp
    FROM volume_data t1
    LEFT JOIN volume_data t2 ON t1.symbol = t2.symbol AND t2.timestamp = (
      SELECT MAX(timestamp) FROM volume_data WHERE timestamp < t1.timestamp
    )
    LEFT JOIN volume_data t3 ON t1.symbol = t3.symbol AND t3.timestamp = (
      SELECT MAX(timestamp) FROM volume_data WHERE timestamp < (
        SELECT MAX(timestamp) FROM volume_data WHERE timestamp < t1.timestamp
      )
    )
    WHERE t1.timestamp = (SELECT MAX(timestamp) FROM volume_data)
    ORDER BY volume_change_percent DESC
    LIMIT 10
  `, (err, results) => {
    if (err) {
      console.error("Veri çekme hatası:", err);
      return res.status(500).json({ error: "Veri alınamadı" });
    }

    console.log("Sorgu Sonucu:", results); // ← Burada log var
    res.json(results);
  });
});

// Sunucu başlatma
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
