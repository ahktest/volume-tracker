// Alpha–Futures Pump Dashboard — sabitler (handoff spec §2 + breakout eşikleri)
module.exports = {
  // ── Pump tespiti ──
  PUMP_X:         9.0,   // dipten >= +800% (ratio = high/low, üst sınır yok)
  PUMP_WINDOW:    30,    // dip -> tepe en fazla 30 gün (trailing pencere)
  PUMP_CLUSTER_GAP: 5,   // bu kadar gün arayla flag'lenen mumlar tek olaya kümelenir
  SPEED_FAST_MAX: 7,     // <=7 gün GUCLU, 8-30 gün YAVAS

  // ── Konsolidasyon ──
  CONS_BAND:      0.30,  // +-%30 salınım (medyan referanslı)
  CONS_MIN_DAYS:  45,    // bu kadar gün banttaysa "uyuyor" (is_sleeping)

  // ── Listeleme pump ayrımı ──
  LISTING_PUMP_DAYS: 3,  // trough_date, ilk mumdan <= bu kadar gün sonraysa day-1 pump

  // ── Klines ──
  KLINE_INTERVAL: '1d',
  KLINE_LIMIT:    1500,  // futures/spot tek çağrıda ~4 yıl günlük

  // ── Getiriler / low pencereleri (gün) ──
  RET_WINDOWS:  { ret3d: 3, ret7d: 7, ret30d: 30 },
  LOW_WINDOWS:  { low_7d: 7, low_30d: 30, low_90d: 90 },
  DIST_LO_WINDOW: 7,     // dist_lo7 hangi low'a göre
  VOL_BASE_WINDOW: 30,   // vol_base = son N günün medyan günlük quote hacmi (fallback)

  // ── Breakout tetiği (canlı, "hareket başladı" sekmesi) ──
  BREAKOUT_VOL_MULT:    3.0,   // 24h quote hacim > vol_base * bu -> hacim spike
  BREAKOUT_CHG_PCT:     15.0,  // 24h_change % bu değerin üstünde -> yak
  // band-break: last_price > cons_mid * (1 + CONS_BAND) (üst bandı kırdı)

  // ── Rate-limit / throttle (alpha bapi yavaş) ──
  SCAN_DELAY_MS:   150,  // coinler arası bekleme (refresh döngüsü)
  HTTP_TIMEOUT_MS: 20000,
  HTTP_RETRIES:    3,
};
