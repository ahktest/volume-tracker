// Alpha–Futures Pump Dashboard — sabitler (handoff spec §2 + breakout eşikleri)
module.exports = {
  // ── Pump tespiti ──
  PUMP_X:         9.0,   // dipten >= +800% (ratio = high/low, üst sınır yok)
  PUMP_WINDOW:    60,    // dip -> tepe en fazla 60 gün (slow-burn pumpları da yakalar, ör. SOON)
  PUMP_CLUSTER_GAP: 5,   // bu kadar gün arayla flag'lenen mumlar tek olaya kümelenir
  SPEED_FAST_MAX: 7,     // <=7 gün: GUCLU
  SPEED_MED_MAX:  30,    // 8-30 gün: YAVAS | 31-60 gün: SLOW

  // ── Konsolidasyon ──
  CONS_BAND:      0.30,  // +-%30 salınım (medyan referanslı)
  CONS_MIN_DAYS:  45,    // bu kadar gün banttaysa "uyuyor" (is_sleeping)

  // ── Listeleme pump ayrımı ──
  LISTING_PUMP_DAYS: 3,  // trough_date, ilk mumdan <= bu kadar gün sonraysa day-1 pump

  // ── Klines ──
  KLINE_INTERVAL: '1d',
  KLINE_LIMIT:    1500,  // futures/spot tek çağrıda ~4 yıl günlük

  // Wick-clamp: low, mum gövde tabanının (min(open,close)) bu katından düşükse
  // bozuk print/listeleme wick'i say -> gövde tabanına çek. 0.1 = >%90 wick'leri temizler.
  // (ENSO listeleme mumu low=0.001 vs gövde 3.128 -> 3579× sahte pump'ı engeller)
  LOW_WICK_FLOOR: 0.1,

  // ── Getiriler / low pencereleri (gün) ──
  RET_WINDOWS:  { ret3d: 3, ret7d: 7, ret30d: 30 },
  LOW_WINDOWS:  { low_7d: 7, low_30d: 30, low_90d: 90 },
  DIST_LO_WINDOW: 7,     // dist_lo7 hangi low'a göre
  VOL_BASE_WINDOW: 30,   // vol_base = son N günün medyan günlük quote hacmi (fallback)

  // ── Breakout tetiği (canlı, "hareket başladı" sekmesi) ──
  BREAKOUT_VOL_MULT:    3.0,   // 24h quote hacim > vol_base * bu -> hacim spike
  BREAKOUT_CHG_PCT:     15.0,  // 24h_change % bu değerin üstünde -> yak
  // band-break: last_price > cons_mid * (1 + CONS_BAND) (üst bandı kırdı)

  // ── Hacim kuruması & volatilite sıkışması (squeeze) — futures serisinden ──
  VOL_DRYUP_SHORT:  7,     // kısa pencere (gün)
  VOL_DRYUP_LONG:   90,    // uzun/baz pencere (gün); <90g geçmiş -> ratio & bbw NULL
  VOL_DRYUP_THRESH: 0.40,  // hacim, 90g rolling ort.'nın bu katı altındaysa "kuru" gün
  BB_PERIOD:        20,    // Bollinger periyodu (kapanış SMA/std)
  BBW_LOOKBACK:     180,   // BBW yüzdelik sırası penceresi (gün)
  BAND_TOP_WINDOW:  20,    // band_top_20d = son N gün en yüksek kapanış
  VOL_AVG_WINDOW:   20,    // vol_avg_20d = son N gün ort. günlük hacim

  // ── Kırılım (LIVE, DB'ye yazılmaz) ──
  KIRILIM_PRICE_MULT: 1.01, // guncel_fiyat > band_top_20d * bu
  KIRILIM_VOL_MULT:   1.5,  // hacim_24h > vol_avg_20d * bu

  // ── Telegram bildirim + zamanlama ──
  DASH_URL:            'https://thorasan.xyz',  // mesaj linkleri için
  TG_ALERT_COOLDOWN_H: 10,          // aynı coin için tekrar uyarı arası (saat)
  CRON_TZ:             'Europe/Istanbul',       // gecelik cron saat dilimi
  CRON_NIGHTLY:        '0 4 * * *',             // gece 04:00 tam güncelleme
  CRON_BREAKOUT:       '*/15 * * * *',          // 15 dk breakout kontrol

  // ── Rate-limit / throttle (alpha bapi yavaş) ──
  SCAN_DELAY_MS:   150,  // coinler arası bekleme (refresh döngüsü)
  HTTP_TIMEOUT_MS: 20000,
  HTTP_RETRIES:    3,
};
