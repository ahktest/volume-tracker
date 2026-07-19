// coin_metrics'e teknik takip kolonlarını ekler (RSI + MA50/200 + MACD). Idempotent.
// Çalıştır:  node scripts/addTechColumns.js
// Zaten varsa "duplicate column" hatasını yutar. Ekledikten sonra:
//   POST /api/pump/refresh  (veya gecelik cron)  ile kolonlar dolar.
require('dotenv').config({ path: __dirname + '/../.env' });
const mysql = require('mysql2/promise');

const COLS = [
  // RSI
  ['rsi14',              'DECIMAL(6,2) NULL'],
  ['rsi_ma',             'DECIMAL(6,2) NULL'],
  ['rsi_cross_days_ago', 'INT NULL'],
  ['rsi_signal_at',      'DATETIME NULL'],
  // MA (golden/death cross)
  ['ma50',               'DECIMAL(38,18) NULL'],
  ['ma200',              'DECIMAL(38,18) NULL'],
  ['ma_cross_days_ago',  'INT NULL'],
  // MACD
  ['macd',               'DECIMAL(38,18) NULL'],
  ['macd_signal',        'DECIMAL(38,18) NULL'],
  ['macd_hist',          'DECIMAL(38,18) NULL'],
  ['macd_cross_days_ago','INT NULL'],
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
      else console.error(`✗ ${name}:`, e.message);
    }
  }
  await pool.end();
  console.log('bitti.');
})();
