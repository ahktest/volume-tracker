// Telegram gönderimi — mevcut bot token'ı (.env'deki TELEGRAM_BOT_TOKEN) ile doğrudan
// Bot API'ye axios POST. Yeni bot/telegraf gerekmez. Hata toleranslı (sunucuyu düşürmez).
const axios = require('axios');

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
    }, { timeout: 15000 });
    return true;
  } catch (e) {
    console.error('[tg] gönderim hatası:', (e.response && e.response.data && e.response.data.description) || e.message);
    return false;
  }
}

module.exports = { sendMessage, CHAT_ID };
