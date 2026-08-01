// Holder dağılımı tablosunu oluşturur (explorer scrape sonuçları). Idempotent.
// Çalıştır:  node scripts/addHoldersTable.js
// Zaten varsa "duplicate column" hatasını yutar. Ekledikten sonra coin sayfasındaki
// admin butonu ("🔍 Holder verisi çek") ile doldurulur — cron YOK, elle tetiklenir.
require('dotenv').config({ path: __dirname + '/../.env' });
const mysql = require('mysql2/promise');

const CREATE = `
CREATE TABLE IF NOT EXISTS coin_holders (
  symbol            VARCHAR(40)   NOT NULL,
  chain             VARCHAR(24)   NULL COMMENT 'Binance alpha listesindeki chainName',
  contract_address  VARCHAR(120)  NULL,
  alpha_id          VARCHAR(24)   NULL,
  explorer          VARCHAR(32)   NULL COMMENT 'bscscan|etherscan|basescan|arbiscan',
  explorer_url      VARCHAR(300)  NULL COMMENT 'scrape edilemeyen zincirlerde de dolu (link butonu)',
  scrapable         TINYINT(1)    NOT NULL DEFAULT 0,

  -- sıralama/filtre/AI için normalize skalerler
  top5_pct          DECIMAL(7,4)  NULL COMMENT 'ham: CEX + havuz dahil',
  top10_pct         DECIMAL(7,4)  NULL,
  top25_pct         DECIMAL(7,4)  NULL,
  clean_top5_pct    DECIMAL(7,4)  NULL COMMENT 'etiketsiz (CEX/havuz/burn düşülmüş) ilk 5',
  cex_pool_pct      DECIMAL(7,4)  NULL COMMENT 'etiketli (CEX+havuz+burn) toplam pay',
  holders_total     INT           NULL COMMENT 'tier dağılımındaki holder sayılarının toplamı',
  gini              DECIMAL(7,4)  NULL COMMENT 'sayfada inline yok — faz 2',

  -- ham bloklar (explorer ne verdiyse; grafiklerin kaynağı)
  concentration_json LONGTEXT     NULL,
  tiers_json         LONGTEXT     NULL,
  depth_json         LONGTEXT     NULL,
  top_holders_json   LONGTEXT     NULL,

  risk_level        VARCHAR(16)   NULL COMMENT 'dusuk|orta|yuksek|cok_yuksek',
  risk_flags        TEXT          NULL COMMENT 'virgüllü bayraklar',

  fetched_at        DATETIME      NULL,
  source            VARCHAR(32)   NULL,
  PRIMARY KEY (symbol),
  KEY idx_clean_top5 (clean_top5_pct),
  KEY idx_risk (risk_level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

// Tablo önceki sürümde oluşturulmuşsa CREATE IF NOT EXISTS bunları eklemez.
const LATER_COLS = [
  ['gini',           'DECIMAL(7,4) NULL'],
  ['clean_top5_pct', 'DECIMAL(7,4) NULL'],
  ['cex_pool_pct',   'DECIMAL(7,4) NULL'],
];

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  try {
    await pool.query(CREATE);
    console.log('✓ tablo hazır: coin_holders');
  } catch (e) { console.error('✗ coin_holders:', e.message); }

  for (const [name, def] of LATER_COLS) {
    try {
      await pool.query(`ALTER TABLE coin_holders ADD COLUMN \`${name}\` ${def}`);
      console.log(`✓ eklendi: coin_holders.${name}`);
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') console.log(`• zaten var: coin_holders.${name}`);
      else console.error(`✗ coin_holders.${name}:`, e.message);
    }
  }
  await pool.end();
  console.log('bitti.');
})();
