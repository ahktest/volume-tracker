// Binance veri kaynakları (handoff spec §3)
//  - Futures (birincil fiyat) : fapi.binance.com  /fapi/v1/klines
//  - Spot (yan)               : data-api.binance.vision /api/v3/klines
//  - Alpha (yan/erken geçmiş) : www.binance.com /bapi/.../alpha-trade/klines  ({code,data} sarmalı)
//  - Canlı batch              : /fapi/v1/ticker/24hr (parametresiz = hepsi), /fapi/v1/premiumIndex
const axios = require('axios');
const cfg = require('./config');

const FAPI  = 'https://fapi.binance.com';
const SPOT  = 'https://data-api.binance.vision';
const ALPHA = 'https://www.binance.com';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Basit retry'li GET (429/5xx/timeout'ta üstel bekleme)
async function get(url, params) {
  let lastErr;
  for (let attempt = 0; attempt <= cfg.HTTP_RETRIES; attempt++) {
    try {
      const res = await axios.get(url, { params, timeout: cfg.HTTP_TIMEOUT_MS });
      return res.data;
    } catch (err) {
      lastErr = err;
      const status = err.response && err.response.status;
      // 400/404 gibi kalıcı hatalarda tekrar deneme (symbol yok vs.)
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      await sleep(400 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ── Klines ──
async function futuresKlines(base, interval = cfg.KLINE_INTERVAL, limit = cfg.KLINE_LIMIT) {
  return get(`${FAPI}/fapi/v1/klines`, { symbol: `${base}USDT`, interval, limit });
}

async function spotKlines(base, interval = cfg.KLINE_INTERVAL, limit = cfg.KLINE_LIMIT) {
  return get(`${SPOT}/api/v3/klines`, { symbol: `${base}USDT`, interval, limit });
}

// alphaId, exchangecoins.alpha_id (ör. "ALPHA_101" ya da "101"). Sembol: ALPHA_<id>USDT
function alphaSymbol(alphaId) {
  if (!alphaId) return null;
  const id = String(alphaId).trim();
  const prefixed = id.toUpperCase().startsWith('ALPHA_') ? id : `ALPHA_${id}`;
  return `${prefixed}USDT`;
}

async function alphaKlines(alphaId, interval = cfg.KLINE_INTERVAL, limit = cfg.KLINE_LIMIT) {
  const symbol = alphaSymbol(alphaId);
  if (!symbol) return [];
  const data = await get(`${ALPHA}/bapi/defi/v1/public/alpha-trade/klines`, { symbol, interval, limit });
  // {"code":"000000","data":[[ts,o,h,l,c,v,...]]}
  if (data && Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

// ── Canlı batch (LIVE, ucuz) ──
// 24hr ticker: parametresiz tek çağrı = tüm semboller. Map<SYMBOL, {last, chgPct, quoteVol}>
async function ticker24hAll() {
  const rows = await get(`${FAPI}/fapi/v1/ticker/24hr`);
  const map = new Map();
  for (const r of (rows || [])) {
    map.set(r.symbol, {
      last:     Number(r.lastPrice),
      chgPct:   Number(r.priceChangePercent),
      quoteVol: Number(r.quoteVolume),
    });
  }
  return map;
}

// premiumIndex: parametresiz = tüm semboller. Map<SYMBOL, fundingRate>
async function fundingAll() {
  const rows = await get(`${FAPI}/fapi/v1/premiumIndex`);
  const arr = Array.isArray(rows) ? rows : [rows];
  const map = new Map();
  for (const r of arr) map.set(r.symbol, Number(r.lastFundingRate));
  return map;
}

module.exports = {
  futuresKlines, spotKlines, alphaKlines, alphaSymbol,
  ticker24hAll, fundingAll, sleep,
};
