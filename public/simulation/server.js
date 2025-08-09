import express from 'express';
import mysql from 'mysql2/promise';
import path from 'path';
import url from 'url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const app = express();

// --- DB pool ---
const pool = mysql.createPool({
  host: '127.0.0.1',
  user: 'ahktest',
  password: '123',
  database: 'volume_tracker',
  waitForConnections: true,
  connectionLimit: 5,
});

// --- statik frontend ---
app.use('/simulation', express.static(path.join(__dirname, 'public')));

// Koşul adlarını normalize eden küçük yardımcı (URL -> DB'deki position değerleri)
function mapTypeToPositions(type) {
  switch (type) {
    case 'long': return ['long'];
    case 'potansiyel-long': return ['potansiyel long'];
    case 'short': return ['short'];
    case 'potansiyel-short': return ['potansiyel short'];
    case 'short-azalan': return ['short (azalan hacim)'];
    case 'potansiyel-short-azalan': return ['potansiyel short (azalan hacim)'];
    case 'potansiyel-long-azalan': return ['potansiyel long (azalan hacim)'];
    default: return []; // bilinmeyen
  }
}

// --- ÖZET: her koşul için win-rate, ort. pnl, adet ---
app.get('/simulation/api/summary', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT position,
             COUNT(*)           AS adet,
             AVG(pnl)           AS avg_pnl,
             SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)/COUNT(*)*100 AS win_rate
      FROM simulasyon
      WHERE position IS NOT NULL AND position <> ''
      GROUP BY position
      ORDER BY adet DESC
    `);

    // frontend kolay okusun diye anahtarları slug’a çevir
    const toSlug = s => s
      .toLowerCase()
      .replace(/\s+/g, '-')             // boşluk -> -
      .replace(/\(azalan-hacim\)/g, 'azalan') // isteğe göre kısaltma
      .replace(/[()]/g, '');

    const data = rows.map(r => ({
      key: toSlug(r.position),
      position: r.position,
      adet: Number(r.adet),
      avg_pnl: Number(r.avg_pnl?.toFixed(2) ?? 0),
      win_rate: Number(r.win_rate?.toFixed(2) ?? 0),
    }));

    res.json({ ok: true, data });
  } catch (e) {
    console.error('summary error:', e);
    res.status(500).json({ ok: false });
  }
});

// --- LİSTE: belirli koşul için satırlar (sıralama destekli) ---
app.get('/simulation/api/list', async (req, res) => {
  try {
    const { type, sort = 'timestamp', dir = 'desc', limit = '100' } = req.query;
    const positions = mapTypeToPositions(type);
    if (!positions.length) return res.json({ ok: true, data: [] });

    // güvenli sıralama alanları
    const allowedSort = new Set(['timestamp','coin','price','nprice','pnl']);
    const sortCol = allowedSort.has(String(sort)) ? sort : 'timestamp';
    const sortDir = String(dir).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const lim = Math.min(parseInt(limit,10) || 100, 500);

    const placeholders = positions.map(()=>'?').join(',');
    const [rows] = await pool.query(
      `
      SELECT id, timestamp, coin, price, position, nprice, pnl
      FROM simulasyon
      WHERE position IN (${placeholders})
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ?
      `,
      [...positions, lim]
    );

    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('list error:', e);
    res.status(500).json({ ok: false });
  }
});

const PORT = 3020;
app.listen(PORT, () => {
  console.log(`Simulation UI servis ayakta: http://localhost:${PORT}/simulation`);
});