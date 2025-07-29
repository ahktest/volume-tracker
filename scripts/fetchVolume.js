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
        limit: 200, // İlk 200 coin için örnek
        convert: 'USD',
      },
    });

    const connection = await connectDB();
    const coins = response.data.data;

    for (const coin of coins) {
  const slug = coin.slug;
  const symbol = coin.symbol;
  const volume = coin.quote.USD.volume_24h;
  const marketcap = coin.quote.USD.market_cap;

  const query = 'INSERT INTO volume_data (timestamp, slug, symbol, volume, marketcap) VALUES (?, ?, ?, ?, ?)';
  await connection.execute(query, [timestamp, slug, symbol, volume, marketcap]);
}


    console.log('Veriler başarıyla kaydedildi.');
    await connection.end();
  } catch (error) {
    console.error('Hata oluştu:', error.message);
  }
}

fetchAndSaveVolume();
