// RSI(14, Wilder) + RSI'nin hareketli ortalaması (SMA) — günlük kapanışlardan.
// Girdi: kapanış dizisi (parseRows'un close alanları). Yeni fetch YOK; scanCoin'in
// zaten belleğe aldığı futures serisinden hesaplanır (squeeze.js ile aynı desen).
const cfg = require('./config');

// Wilder RSI serisi; closes ile aynı uzunlukta, ilk `period` eleman null.
function rsiSeries(closes, period = cfg.RSI_PERIOD) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  if (n <= period) return out;

  // İlk ortalama kazanç/kayıp = ilk `period` değişimin basit ortalaması
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Sonrası Wilder yumuşatması (RMA)
  for (let i = period + 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0, l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// series'in SMA'sı; series ile aynı hizada. Başta null olan (RSI henüz başlamamış)
// bölge SMA penceresini sıfırlar, böylece ilk gerçek SMA `period` adet RSI ister.
function smaOf(series, period) {
  const n = series.length;
  const out = new Array(n).fill(null);
  const buf = [];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = series[i];
    if (v == null) { buf.length = 0; sum = 0; continue; }
    buf.push(v); sum += v;
    if (buf.length > period) sum -= buf.shift();
    if (buf.length === period) out[i] = sum / period;
  }
  return out;
}

// {rsi:[], ma:[]} — ikisi de closes ile aynı uzunlukta (grafik overlay için).
function computeRsi(closes, period = cfg.RSI_PERIOD, maPeriod = cfg.RSI_MA_PERIOD) {
  const rsi = rsiSeries(closes, period);
  const ma = smaOf(rsi, maPeriod);
  return { rsi, ma };
}

// En son "aşırı satımda yukarı kesiş" sinyali:
//   rsi, ma'yı aşağıdan yukarı keser (prev rsi<=ma, şimdi rsi>ma) VE kesiş barında rsi<=oversold.
// Döner: { rsi14, rsi_ma, rsi_cross_days_ago }  (kesiş yoksa days_ago=null)
function rsiSignal(closes) {
  const { rsi, ma } = computeRsi(closes);
  const n = closes.length;
  const last = n - 1;
  let crossIdx = null;
  for (let i = last; i >= 1; i--) {
    if (rsi[i] == null || ma[i] == null || rsi[i - 1] == null || ma[i - 1] == null) continue;
    if (rsi[i - 1] <= ma[i - 1] && rsi[i] > ma[i] && rsi[i] <= cfg.RSI_OVERSOLD) { crossIdx = i; break; }
  }
  return {
    rsi14:  rsi[last] != null ? +rsi[last].toFixed(2) : null,
    rsi_ma: ma[last]  != null ? +ma[last].toFixed(2)  : null,
    rsi_cross_days_ago: crossIdx != null ? (last - crossIdx) : null,
  };
}

module.exports = { rsiSeries, smaOf, computeRsi, rsiSignal };
