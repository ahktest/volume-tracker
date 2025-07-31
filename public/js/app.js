// Sayıları Kısaltmak İçin Fonksiyon
function formatNumber(num) {
  if (num >= 1_000_000_000) {
    return Math.round(num / 1_000_000_000) + "B";
  } else if (num >= 1_000_000) {
    return Math.round(num / 1_000_000) + "M";
  } else if (num >= 1_000) {
    return Math.round(num / 1_000) + "K";
  } else {
    return num?.toString() || "-";
  }
}

function formatPrice(price) {
  if (price >= 1000) {
    return Number(price).toLocaleString(undefined, { maximumFractionDigits: 0 });
  } else if (price >= 1) {
    return Number(price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } else if (price >= 0.01) {
    return Number(price).toFixed(4);
  } else if (price >= 0.0001) {
    return Number(price).toFixed(6);
  } else {
    return Number(price).toFixed(8);
  }
}


// Artan hacim tablosunu dolduran fonksiyon
async function fetchIncreaseData() {
  try {
    const res = await fetch("/api/top-increase");
    if (!res.ok) throw new Error("API yanıt vermedi");
    const data = await res.json();
    const tbody = document.querySelector("#volume-table tbody");
    tbody.innerHTML = "";

    data.forEach((coin, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="#">${idx + 1}</td>
        <td data-label="Symbol">${coin.symbol}</td>
        <td data-label="Fiyat">${formatPrice(coin.price)}</td>

        <td data-label="MarketCap">${formatNumber(coin.marketcap)}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${formatNumber(coin.lvolume)}</td>
        <td data-label="4h Hacim">${formatNumber(coin.v4hvolume)}</td>
        <td data-label="8h Hacim">${formatNumber(coin.v8hvolume)}</td>
        <td data-label="Fark">${formatNumber(coin.fark)}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
        <td data-label="CMC Link">
          <a class="cmc-link" href="https://coinmarketcap.com/currencies/${coin.slug}" target="_blank" rel="noopener noreferrer">→</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Artan veri çekme hatası:", err);
  }
}

// Azalan hacim tablosunu dolduran fonksiyon
async function fetchDecreaseData() {
  try {
    const res = await fetch("/api/top-decrease");
    if (!res.ok) throw new Error("API yanıt vermedi");
    const data = await res.json();
    const tbody = document.querySelector("#volume-decrease-table tbody");
    tbody.innerHTML = "";

    data.forEach((coin, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td data-label="#">${idx + 1}</td>
        <td data-label="Symbol">${coin.symbol}</td>
        <td data-label="Fiyat">${formatPrice(coin.price)}</td>

        <td data-label="MarketCap">${formatNumber(coin.marketcap)}</td>
        <td data-label="Son Zaman">${new Date(coin.ltime).toLocaleString()}</td>
        <td data-label="4h Önce">${new Date(coin.ptime).toLocaleString()}</td>
        <td data-label="Son Hacim">${formatNumber(coin.lvolume)}</td>
        <td data-label="4h Hacim">${formatNumber(coin.v4hvolume)}</td>
        <td data-label="8h Hacim">${formatNumber(coin.v8hvolume)}</td>
        <td data-label="Fark">${formatNumber(coin.fark)}</td>
        <td data-label="%" class="${coin.yuzdelik >= 0 ? 'percentage-positive' : 'percentage-negative'}">${coin.yuzdelik.toFixed(2)}%</td>
        <td data-label="CMC Link">
          <a class="cmc-link" href="https://coinmarketcap.com/currencies/${coin.slug}" target="_blank" rel="noopener noreferrer">→</a>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    console.error("Azalan veri çekme hatası:", err);
  }
}

// Sayfa yüklendiğinde çağırılıyor
document.addEventListener("DOMContentLoaded", () => {
  fetchIncreaseData();
  fetchDecreaseData();
});
