// Kısaltmalı gösterim + tooltip için yardımcı fonksiyon
function formatNumberTooltip(num) {
  if (num == null) return '-';
  const full = Number(num).toLocaleString();
  const abs = Math.abs(num);
  let display;
  if (abs >= 1e9) display = (num / 1e9).toFixed(1) + 'B';
  else if (abs >= 1e6) display = (num / 1e6).toFixed(1) + 'M';
  else if (abs >= 1e3) display = (num / 1e3).toFixed(1) + 'K';
  else display = full;
  return `<span class="tooltip" data-tooltip="${full}">${display}</span>`;
}

// Fiyat formatlama fonksiyonu
function formatPrice(price) {
  if (price == null) return '-';
  const abs = Math.abs(price);
  if (abs >= 1000) return Number(price).toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return Number(price).toFixed(2);
  if (abs >= 0.01) return Number(price).toFixed(4);
  return Number(price).toFixed(8);
}

// Artan hacimler tablosunu oluştur
async function fetchIncreaseData() {
  try {
    const res = await fetch('/api/top-increase');
    if (!res.ok) throw new Error('API yanıt vermedi');
    const data = await res.json();

    const tbody = document.querySelector('#volume-table tbody');
    tbody.innerHTML = '';

    data.forEach((coin, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="#">${idx + 1}</td>
        <td data-label="Symbol">
            <a href="/coin.html?slug=${coin.slug}" >${coin.symbol}</a>
        </td>
        <td data-label="Fiyat">${formatPrice(coin.price)}</td>
        <td data-label="MarketCap">${formatNumberTooltip(coin.marketcap)}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${formatNumberTooltip(coin.lvolume)}</td>
        <td data-label="4h Hacim">${formatNumberTooltip(coin.v4hvolume)}</td>
        <td data-label="8h Hacim">${formatNumberTooltip(coin.v8hvolume)}</td>
        <td data-label="Fark">${formatNumberTooltip(coin.fark)}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
        <td data-label="CMC">
          <a class="cmc-link" href="https://coinmarketcap.com/currencies/${coin.slug}" target="_blank" rel="noopener noreferrer">→</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Artan veri çekme hatası:', err);
  }
}

// Azalan hacim tablosunu oluştur
async function fetchDecreaseData() {
  try {
    const res = await fetch('/api/top-decrease');
    if (!res.ok) throw new Error('API yanıt vermedi');
    const data = await res.json();

    const tbody = document.querySelector('#volume-decrease-table tbody');
    tbody.innerHTML = '';

    data.forEach((coin, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td data-label="#">${idx + 1}</td>
        <td data-label="Symbol">
            <a href="/coin.html?slug=${coin.slug}" >${coin.symbol}</a>
        </td>
        <td data-label="Fiyat">${formatPrice(coin.price)}</td>
        <td data-label="MarketCap">${formatNumberTooltip(coin.marketcap)}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${formatNumberTooltip(coin.lvolume)}</td>
        <td data-label="4h Hacim">${formatNumberTooltip(coin.v4hvolume)}</td>
        <td data-label="8h Hacim">${formatNumberTooltip(coin.v8hvolume)}</td>
        <td data-label="Fark">${formatNumberTooltip(coin.fark)}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
        <td data-label="CMC">
          <a class="cmc-link" href="https://coinmarketcap.com/currencies/${coin.slug}" target="_blank" rel="noopener noreferrer">→</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error('Azalan veri çekme hatası:', err);
  }
}

// Sayfa yüklenince tablo verilerini çek
document.addEventListener('DOMContentLoaded', () => {
  fetchIncreaseData();
  fetchDecreaseData();
});
