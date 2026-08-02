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
  ['gini',              'DECIMAL(7,4) NULL'],
  ['clean_top5_pct',    'DECIMAL(7,4) NULL'],
  ['cex_pool_pct',      'DECIMAL(7,4) NULL'],
  // Chainbase sürümüyle gelenler (top-holders limit=100 → 50/100 kohortları da hesaplanıyor)
  ['top50_pct',         'DECIMAL(7,4) NULL'],
  ['top100_pct',        'DECIMAL(7,4) NULL'],
  ['total_supply',      'DECIMAL(40,0) NULL COMMENT "yüzdelerin paydası (Binance alpha listesi)"'],
  ['circulating_supply','DECIMAL(40,0) NULL'],
  ['circ_ratio',        'DECIMAL(7,4) NULL COMMENT "dolaşım/toplam — düşükse arz kilitli"'],
  ['wallets_over_1k',   'INT NULL COMMENT "ilk 100 içinde >=$1.000 tutan cüzdan (100 ise tavan)"'],
  ['holders_capped',    'TINYINT(1) NULL COMMENT "wallets_over_1k tavana dayandı mı"'],
  // Çok zincirli arz dağılımı
  ['chains_json',       'LONGTEXT NULL COMMENT "zincir başına arz + kontrat, arza göre sıralı"'],
  ['primary_chain',     'VARCHAR(24) NULL COMMENT "en yüksek arzlı zincir (varsayılan sekme)"'],
  ['chain_count',       'INT NULL'],
  ['supply_pct',        'DECIMAL(7,4) NULL COMMENT "birincil zincirin global arz içindeki payı"'],
];

// Zincir başına holder verisi. coin_holders (PK symbol) "birincil zincir" özetini tutar;
// bu tablo her zincirin tam kaydını tutar → UI sekmeleri buradan beslenir.
const CREATE_CHAIN = `
CREATE TABLE IF NOT EXISTS coin_chain_holders (
  symbol            VARCHAR(40)   NOT NULL,
  chain             VARCHAR(24)   NOT NULL,
  contract_address  VARCHAR(120)  NULL,
  explorer          VARCHAR(32)   NULL,
  explorer_url      VARCHAR(300)  NULL,
  total_supply      DECIMAL(50,8) NULL COMMENT 'bu zincirdeki kontratın totalSupply()',
  supply_pct        DECIMAL(7,4)  NULL COMMENT 'global arz içindeki payı',
  top5_pct          DECIMAL(7,4)  NULL,
  top10_pct         DECIMAL(7,4)  NULL,
  top25_pct         DECIMAL(7,4)  NULL,
  top50_pct         DECIMAL(7,4)  NULL,
  top100_pct        DECIMAL(7,4)  NULL,
  clean_top5_pct    DECIMAL(7,4)  NULL,
  cex_pool_pct      DECIMAL(7,4)  NULL,
  holders_total     INT           NULL,
  wallets_over_1k   INT           NULL,
  holders_capped    TINYINT(1)    NULL,
  concentration_json LONGTEXT     NULL,
  top_holders_json   LONGTEXT     NULL,
  risk_level        VARCHAR(16)   NULL,
  risk_flags        TEXT          NULL,
  fetched_at        DATETIME      NULL,
  source            VARCHAR(32)   NULL,
  PRIMARY KEY (symbol, chain),
  KEY idx_symbol_supply (symbol, supply_pct)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;

(async () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASS, database: process.env.DB_NAME,
  });
  try {
    await pool.query(CREATE);
    console.log('✓ tablo hazır: coin_holders');
  } catch (e) { console.error('✗ coin_holders:', e.message); }

  try {
    await pool.query(CREATE_CHAIN);
    console.log('✓ tablo hazır: coin_chain_holders');
  } catch (e) { console.error('✗ coin_chain_holders:', e.message); }

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
