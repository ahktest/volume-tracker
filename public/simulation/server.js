// public/simulation/server.js  (CommonJS)
const express = require('express');
const cors = require('cors');
const path = require('path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

// .env kökte: /var/www/volume-tracker/.env
dotenv.config({ path: path.join(__dirname, '../../.env') });

const app = express();
app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME || 'volume_tracker',
  waitForConnections: true,
  connectionLimit: 5,
});

// Sağlık kontrolü
app.get('/health', (req, res) => res.send('ok'));

// Özet: koşul bazlı PnL performansı
app.get('/api/sim/summary', async (req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT position,
             COUNT(*) as trades,
             AVG(pnl)   as avg_pnl,
             SUM(pnl)   as total_pnl
      FROM simulasyon
      WHERE pnl IS NOT NULL
      GROUP BY position
      ORDER BY total_pnl DESC
    `);
    res.json(rows);
  } catch (e) {
    console.error('summary error:', e);
    res.status(500).json({ error: 'summary_failed' });
  }
});

// Liste: ?position=long&sort=pnl_desc&limit=50&offset=0
app.get('/api/sim/list', async (req, res) => {
  try {
    const { position, sort = 'timestamp_desc', limit = 50, offset = 0 } = req.query;

    const allowedSort = {
      'timestamp_desc': 'timestamp DESC',
      'timestamp_asc' : 'timestamp ASC',
      'pnl_desc'      : 'pnl DESC',
      'pnl_asc'       : 'pnl ASC',
      'price_desc'    : 'price DESC',
      'price_asc'     : 'price ASC',
    };
    const orderBy = allowedSort[sort] || allowedSort.timestamp_desc;

    const params = [];
    let where = '1=1';
    if (position) {
      where += ' AND position = ?';
      params.push(position);
    }

    const [rows] = await db.query(
      `SELECT id, timestamp, coin, price, position, nprice, pnl
       FROM simulasyon
       WHERE ${where}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    );

    res.json(rows);
  } catch (e) {
    console.error('list error:', e);
    res.status(500).json({ error: 'list_failed' });
  }
});

const PORT = process.env.SIM_API_PORT || 3020;
app.listen(PORT, () => {
  console.log(`sim-api listening on ${PORT}`);
});