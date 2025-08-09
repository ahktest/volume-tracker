// server.js
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
app.use(cors());

const db = mysql.createPool({
  host: '127.0.0.1',
  user: 'ahktest',
  password: '123',
  database: 'volume_tracker',
  waitForConnections: true,
  connectionLimit: 5,
});

// Özet: her pozisyon için adet ve ort. PnL
app.get('/api/sim/summary', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT position,
             COUNT(*) AS count,
             ROUND(AVG(pnl), 2) AS avg_pnl
      FROM simulasyon
      WHERE position IS NOT NULL
      GROUP BY position
      ORDER BY position
    `);
    res.json(rows);
  } catch (e) {
    console.error('summary err:', e);
    res.status(500).json({ error: 'db' });
  }
});

// Pozisyon listesi (UI'da dropdown istersek)
app.get('/api/sim/positions', async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT DISTINCT position
      FROM simulasyon
      WHERE position IS NOT NULL
      ORDER BY position
    `);
    res.json(rows.map(r => r.position));
  } catch (e) {
    console.error('positions err:', e);
    res.status(500).json({ error: 'db' });
  }
});

// Detay liste: ?position=long&limit=200&order=desc
app.get('/api/sim/list', async (req, res) => {
  const position = req.query.position || 'long';
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 1000);
  const order = (req.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  try {
    const [rows] = await db.query(`
      SELECT id, timestamp, coin, price, nprice, pnl, position
      FROM simulasyon
      WHERE position = ?
      ORDER BY timestamp ${order}
      LIMIT ?
    `, [position, limit]);
    res.json(rows);
  } catch (e) {
    console.error('list err:', e);
    res.status(500).json({ error: 'db' });
  }
});

const PORT = process.env.PORT || 3020;
app.listen(PORT, () => console.log(`sim-api ${PORT} portunda`));