// coin_ai_comments tablosunu kurar (idempotent).
// Çalıştır:  node scripts/addAiCommentsTable.js
require('dotenv').config({ path: __dirname + '/../.env' });
const mysql = require('mysql2/promise');

const CREATE = `
CREATE TABLE IF NOT EXISTS coin_ai_comments (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  symbol            VARCHAR(40)   NOT NULL,
  created_at        DATETIME      NOT NULL DEFAULT UTC_TIMESTAMP(),
  comment           MEDIUMTEXT    NULL,
  status            VARCHAR(16)   NOT NULL DEFAULT 'ok' COMMENT 'ok | refusal | error',
  error             VARCHAR(255)  NULL,
  model             VARCHAR(64)   NULL,
  input_tokens      INT           NULL,
  output_tokens     INT           NULL,
  cache_read_tokens INT           NULL,
  web_search_count  INT           NULL,
  cost_usd          DECIMAL(10,6) NULL COMMENT 'CLI total_cost_usd — aylık bütçe tavanı bundan hesaplanır',
  num_turns         INT           NULL,
  duration_ms       INT           NULL,
  session_id        VARCHAR(64)   NULL,
  PRIMARY KEY (id),
  KEY idx_symbol_created (symbol, created_at),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  try {
    await pool.query(CREATE);
    console.log('✓ tablo hazır: coin_ai_comments');
  } catch (e) {
    console.error('✗ coin_ai_comments:', e.message);
  }
  await pool.end();
  console.log('bitti.');
})();
