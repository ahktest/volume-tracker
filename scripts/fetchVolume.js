require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');

// Veritabanı bağlantısı
async function connectDB() {
  return await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
}

// Veri çekme ve veritabanına yazma
async function fetchAndSaveVolume() {
  try {
    const response = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
      headers: {
        'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY,
      },
      params: {
        limit: 10, // İlk 10 coin için örnek
        convert: 'USD',
      },
    });

    const connection = await connectDB();
    const coins = response.data.data;

    for (const coin of coins) {
      const { symbol, quote } = coin;
      const volume = quote.USD.volume_24h;

      await connection.execute(
        'INSERT INTO volume_history (symbol, volume) VALUES (?, ?)',
        [symbol, volume]
      );
    }

    console.log('Veriler başarıyla kaydedildi.');
    await connection.end();
  } catch (error) {
    console.error('Hata oluştu:', error.message);
  }
}

fetchAndSaveVolume();
