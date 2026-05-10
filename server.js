const express = require('express');

const PLATFORM_API_URL = process.env.PLATFORM_API_URL || 'http://43.203.215.179:4000';
const PORT = process.env.PORT || 3007;

const app = express();

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`window.__ALP_PLATFORM_API__ = ${JSON.stringify(PLATFORM_API_URL)};`);
});

app.use(express.static(__dirname, { index: 'index.html' }));

app.listen(PORT, () => {
  console.log(`Interior game (Singleplay-Game4) on port ${PORT}`);
});
