const express = require('express');
const { exec } = require('child_process');
const app = express();
app.use(express.json());

const SECRET = "hasan-secret"; // webhook'tan doğrulama için

app.post('/webhook', (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  
  // Güvenlik için burada SECRET ile imza doğrulaması ekleyebilirsin (opsiyonel)
  console.log('Webhook alındı. Git pull yapılıyor...');

  exec('cd /var/www/volume-tracker && git pull', (err, stdout, stderr) => {
    if (err) {
      console.error(`Hata: ${err.message}`);
      return res.sendStatus(500);
    }
    console.log(`stdout: ${stdout}`);
    console.log(`stderr: ${stderr}`);
    res.sendStatus(200);
  });
});

app.listen(3001, () => {
  console.log('Webhook listener 3001 portunda çalışıyor');
});
