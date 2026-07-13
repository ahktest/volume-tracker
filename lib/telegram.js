// Telegram gönderimi — mevcut bot token'ı (.env'deki TELEGRAM_BOT_TOKEN) ile doğrudan
// Bot API'ye axios POST. Yeni bot/telegraf gerekmez. Hata toleranslı (sunucuyu düşürmez).
//
// ÖNEMLİ: api.telegram.org IPv6'ya çözülüp rota bozuk olduğunda istek timeout'a düşer.
// Kardeş telegram-bot projesindeki gibi IPv4'e zorluyoruz (dns ipv4first + Agent family:4).
const axios = require('axios');
const https = require('https');
const dns = require('dns');

try { dns.setDefaultResultOrder('ipv4first'); } catch (e) { /* eski node */ }

const tgAgent = new https.Agent({ family: 4, keepAlive: true, timeout: 15000 });

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = '-4678793180';   // pump uyarıları hedefi (koddan, thread yok)

async function sendMessage(text, opts = {}) {
  if (!TOKEN) {
    console.warn('[tg] TELEGRAM_BOT_TOKEN yok — mesaj atlanıyor');
    return false;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      ...opts,
    }, { timeout: 15000, httpsAgent: tgAgent, family: 4 });
    return true;
  } catch (e) {
    console.error('[tg] gönderim hatası:', (e.response && e.response.data && e.response.data.description) || e.message);
    return false;
  }
}

module.exports = { sendMessage, CHAT_ID };
