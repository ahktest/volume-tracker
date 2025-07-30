require('dotenv').config({ path: __dirname + '/../.env' });

//require('dotenv').config();
const axios = require('axios');
const mysql = require('mysql2/promise');
const apiKey = process.env.CMC_API_KEY;
//console.log(`[${new Date().toISOString()}] Cron çalıştı.`);
//console.log('API KEY:', process.env.CMC_API_KEY);


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
        'X-CMC_PRO_API_KEY': apiKey,
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
  const price = coin.quote?.USD?.price || 0;


  const query = `
  INSERT INTO volume_data (symbol, volume, marketcap, slug, price) VALUES (?, ?, ?, ?, ?)`;
const values = [symbol, volume, marketcap, slug, price];

}



    console.log('Veriler başarıyla kaydedildi.');
    await connection.end();
  } catch (error) {
    console.error('Hata oluştu:', error.message);
  }
}

fetchAndSaveVolume();
