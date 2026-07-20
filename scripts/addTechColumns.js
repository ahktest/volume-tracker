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

// Çoklu zaman dilimi (1d/4h/1w) teknik sinyal tablosu
const CREATE_TECH_SIGNALS = `
CREATE TABLE IF NOT EXISTS coin_tech_signals (
  symbol              VARCHAR(40)   NOT NULL,
  timeframe           VARCHAR(8)    NOT NULL,
  rsi14               DECIMAL(6,2)  NULL,
  rsi_ma              DECIMAL(6,2)  NULL,
  rsi_cross_bars_ago  INT           NULL,
  ma50                DECIMAL(38,18) NULL,
  ma200               DECIMAL(38,18) NULL,
  ma_cross_bars_ago   INT           NULL,
  ma_source           VARCHAR(8)    NULL COMMENT 'MA hangi dilimden: kendi tf, ya da MA200 yoksa 1d devri',
  macd                DECIMAL(38,18) NULL,
  macd_signal         DECIMAL(38,18) NULL,
  macd_hist           DECIMAL(38,18) NULL,
  macd_cross_bars_ago INT           NULL,
  updated_at          DATETIME      NULL,
  PRIMARY KEY (symbol, timeframe),
  KEY idx_tf_rsi_cross (timeframe, rsi_cross_bars_ago)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  try {
    await pool.query(CREATE_TECH_SIGNALS);
    console.log('✓ tablo hazır: coin_tech_signals');
  } catch (e) { console.error('✗ coin_tech_signals:', e.message); }
  for (const [name, def] of COLS) {
    try {
      await pool.query(`ALTER TABLE coin_metrics ADD COLUMN \`${name}\` ${def}`);
      console.log(`✓ eklendi: ${name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log(`• zaten var: ${name}`);
      else console.error(`✗ ${name}:`, e.message);
    }
  }
  // Tablo önceki sürümde oluşturulmuşsa sonradan eklenen kolonlar (CREATE IF NOT EXISTS bunları eklemez)
  for (const [name, def] of [['ma_source', "VARCHAR(8) NULL COMMENT 'MA kaynağı dilim'"]]) {
    try {
      await pool.query(`ALTER TABLE coin_tech_signals ADD COLUMN \`${name}\` ${def}`);
      console.log(`✓ eklendi: coin_tech_signals.${name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log(`• zaten var: coin_tech_signals.${name}`);
      else console.error(`✗ coin_tech_signals.${name}:`, e.message);
    }
  }
  await pool.end();
  console.log('bitti.');
})();
