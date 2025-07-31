async function fetchVolumeData() {
  try {
    const res = await fetch('/api/top-increase');
    if (!res.ok) throw new Error('API yanıt vermedi');
    const data = await res.json();

    const tbody = document.querySelector('#volume-table tbody');
    tbody.innerHTML = '';

    data.forEach((coin, index) => {
      const tr = document.createElement('tr');

      tr.innerHTML = `
        <td data-label="#">${index + 1}</td>
        <td data-label="Symbol">${coin.symbol}</td>
        <td data-label="Slug">${coin.slug}</td>
        <td data-label="Fiyat">${Number(coin.price).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 8})}</td>
        <td data-label="MarketCap">${Number(coin.marketcap).toLocaleString()}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${Number(coin.lvolume).toLocaleString()}</td>
        <td data-label="4h Hacim">${Number(coin.v4hvolume).toLocaleString()}</td>
        <td data-label="8h Hacim">${Number(coin.v8hvolume).toLocaleString()}</td>
        <td data-label="Fark">${Number(coin.fark).toLocaleString()}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
      `;

      tbody.appendChild(tr);
    });
  } catch (error) {
    console.error('Veri çekme hatası:', error);
  }
}

async function fetchDecreaseData() {
  try {
    const res = await fetch('/api/top-decrease');
    if (!res.ok) throw new Error('API yanıt vermedi');
    const data = await res.json();

    const tbody = document.querySelector('#volume-decrease-table tbody');
    tbody.innerHTML = '';

    data.forEach((coin, index) => {
      const tr = document.createElement('tr');

      tr.innerHTML = `
        <td data-label="#">${index + 1}</td>
        <td data-label="Symbol">${coin.symbol}</td>
        <td data-label="Slug">${coin.slug}</td>
        <td data-label="Fiyat">${Number(coin.price).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 8})}</td>
        <td data-label="MarketCap">${Number(coin.marketcap).toLocaleString()}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${Number(coin.lvolume).toLocaleString()}</td>
        <td data-label="4h Hacim">${Number(coin.v4hvolume).toLocaleString()}</td>
        <td data-label="8h Hacim">${Number(coin.v8hvolume).toLocaleString()}</td>
        <td data-label="Fark">${Number(coin.fark).toLocaleString()}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
      `;

      tbody.appendChild(tr);
    });
  } catch (error) {
    console.error('Veri çekme hatası:', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  fetchVolumeData();
  fetchDecreaseData();
});
