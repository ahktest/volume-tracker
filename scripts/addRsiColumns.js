// coin_metrics'e RSI teknik takip kolonlarını ekler (idempotent).
// Çalıştır:  node scripts/addRsiColumns.js
// Zaten varsa "duplicate column" hatasını yutar. Ekledikten sonra:
//   POST /api/pump/refresh  (veya gecelik cron)  ile kolonlar dolar.
require('dotenv').config({ path: __dirname + '/../.env' });
const mysql = require('mysql2/promise');

const COLS = [
  ['rsi14',              'DECIMAL(6,2) NULL'],
  ['rsi_ma',             'DECIMAL(6,2) NULL'],
  ['rsi_cross_days_ago', 'INT NULL'],
  ['rsi_signal_at',      'DATETIME NULL'],
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  for (const [name, def] of COLS) {
    try {
      await pool.query(`ALTER TABLE coin_metrics ADD COLUMN \`${name}\` ${def}`);
      console.log(`✓ eklendi: ${name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log(`• zaten var: ${name}`);
      else { console.error(`✗ ${name}:`, e.message); }
    }
  }
  await pool.end();
  console.log('bitti.');
})();
