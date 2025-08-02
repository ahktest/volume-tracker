async function fetchCoinData(slug) {
  const res = await fetch(`/coin/${slug}/history`);
  if (!res.ok) throw new Error("Veri çekilemedi");
  return await res.json();
}

function formatNumber(n) {
  return n.toLocaleString("tr-TR", { maximumFractionDigits: 2 });
}

function buildChart(data) {
  const labels = data.map(d => new Date(d.timestamp).toLocaleString("tr-TR"));
  const volumes = data.map(d => d.volume);
  const prices = data.map(d => d.price);

  const ctx = document.getElementById("volumeChart").getContext("2d");
  new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Hacim",
          data: volumes,
          backgroundColor: "rgba(0, 123, 255, 0.5)",
          yAxisID: "y",
        },
        {
          type: "line",
          label: "Fiyat",
          data: prices,
          borderColor: "rgba(255, 99, 132, 1)",
          yAxisID: "y1",
          tension: 0.3,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        tooltip: {
          callbacks: {
            afterBody: (ctx) => {
              const price = prices[ctx[0].dataIndex];
              return `Fiyat: $${formatNumber(price)}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          position: "left",
          title: { display: true, text: "Hacim" }
        },
        y1: {
          beginAtZero: false,
          position: "right",
          grid: { drawOnChartArea: false },
          title: { display: true, text: "Fiyat (USD)" }
        }
      }
    }
  });
}

async function init() {
  const urlParams = new URLSearchParams(window.location.search);
  const slug = urlParams.get("slug");
  if (!slug) return alert("Slug eksik.");

  const result = await fetchCoinData(slug);
  const last = result.data[result.data.length - 1] || {};

  document.getElementById("coin-name").textContent = result.slug.toUpperCase();
  document.getElementById("coin-price").textContent = `Fiyat: $${formatNumber(last.price || 0)}`;
  document.getElementById("coin-marketcap").textContent = `Mcap: $${formatNumber(last.marketcap || 0)}`;
  document.getElementById("coin-volume").textContent = `Hacim: $${formatNumber(last.volume || 0)}`;
  document.getElementById("cmc-link").href = `https://coinmarketcap.com/currencies/${result.slug}`;

  buildChart(result.data);
}

init();