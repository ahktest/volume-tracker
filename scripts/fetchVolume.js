// scripts/fetchVolume.js
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_KEY = process.env.CMC_API_KEY;
const API_URL = 'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest';

const fetchVolume = async () => {
  try {
    const response = await axios.get(API_URL, {
      headers: {
        'X-CMC_PRO_API_KEY': API_KEY
      },
      params: {
        start: 1,
        limit: 20, // İstersen artır
        convert: 'USD'
      }
    });

    const data = response.data.data.map(coin => ({
      name: coin.name,
      symbol: coin.symbol,
      price: coin.quote.USD.price,
      volume_24h: coin.quote.USD.volume_24h,
      market_cap: coin.quote.USD.market_cap
    }));

    // Kaydet
    const savePath = path.join(__dirname, '../data/current.json');
    fs.writeFileSync(savePath, JSON.stringify(data, null, 2));

    console.log(`[${new Date().toISOString()}] Veri çekildi ve kaydedildi.`);
  } catch (error) {
    console.error('Veri çekme hatası:', error.response?.data || error.message);
  }
};

fetchVolume();
