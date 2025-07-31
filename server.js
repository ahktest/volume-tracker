const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
require("dotenv").config();
//require("dotenv").config();
console.log("ENV test ->", process.env.DB_USER, process.env.DB_PASSWORD);


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

app.get("/ping", (req, res) => {
  console.log("🟢 /ping çalıştı");
  res.send("pong");
});

// API: Son veri çekim tarihindeki en yüksek hacim artışı
app.get("/top-gainers", (req, res) => {
  console.log("🟢 /top-gainers isteği alındı");

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
      console.error("❌ SQL HATASI:", err.sqlMessage || err.message || err);
      return res.status(500).json({ error: "Veri alınamadı", detay: err.sqlMessage || err.message || err });
    }

    console.log("✅ Sorgu Sonucu:", results);
    res.json(results);
  });
});


// Sunucu başlatma
app.listen(PORT, () => {
  console.log(`Sunucu çalışıyor: http://localhost:${PORT}`);
});
