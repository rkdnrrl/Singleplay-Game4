const express = require('express');

const PLATFORM_API_URL = process.env.PLATFORM_API_URL || 'http://43.203.215.179:4000';
const PORT = process.env.PORT || 3007;

const app = express();

// config.js — 항상 최신값 (캐시 금지)
app.get('/config.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('application/javascript');
  res.send(`window.__ALP_PLATFORM_API__ = ${JSON.stringify(PLATFORM_API_URL)};`);
});

// 정적 파일 — 항상 서버에 재검증 (배포 즉시 반영)
app.use(express.static(__dirname, {
  index: 'index.html',
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.listen(PORT, () => {
  console.log(`Interior game (Singleplay-Game4) on port ${PORT}`);
});
