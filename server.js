const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const CLAUDE_KEY   = process.env.CLAUDE_API_KEY  || '';
const NEWSDATA_KEY = process.env.Newsdata         || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── COINS ─────────────────────────────────────────────────────────
const COINS = [
  'BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX',
  'LINK','DOT','MATIC','UNI','ATOM','NEAR','LTC',
  'AAVE','ARB','OP','INJ','TIA'
];

// ── CANDLE STORE: real OHLCV per coin ─────────────────────────────
// Each coin stores last 100 real 15-min candles from KuCoin
const candles = {};
COINS.forEach(s => { candles[s] = []; });

// ── INDICATORS ────────────────────────────────────────────────────
function ema(closes, n) {
  if (closes.length < n) return closes.at(-1) || 0;
  const k = 2 / (n + 1);
  let e = closes.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, n = 14) {
  if (closes.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    d > 0 ? g += d : l -= d;
  }
  if (l === 0) return 100;
  return parseFloat((100 - 100 / (1 + (g / n) / (l / n))).toFixed(1));
}

function macd(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, hist: 0 };
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12 - ema26;
  // simplified signal
  return { macd: parseFloat(macdLine.toFixed(4)), hist: parseFloat(macdLine.toFixed(4)) };
}

function atr(highs, lows, closes, n = 14) {
  if (closes.length < n + 1) return 1.5;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i]  - closes[i - 1])
    );
    sum += tr;
  }
  return parseFloat(((sum / n) / closes.at(-1) * 100).toFixed(2));
}

function trend(closes) {
  if (closes.length < 55) return 'SIDE';
  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e50 = ema(closes, 50);
  if (e9 > e21 && e21 > e50) return 'UP';
  if (e9 < e21 && e21 < e50) return 'DOWN';
  return 'SIDE';
}

function mom(closes, n = 10) {
  if (closes.length < n + 2) return 0;
  return parseFloat(((closes.at(-1) - closes.at(-n - 1)) / closes.at(-n - 1) * 100).toFixed(2));
}

function bollingerBands(closes, n = 20) {
  if (closes.length < n) return { upper: 0, mid: 0, lower: 0, pct: 50 };
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(slice.reduce((s, v) => s + Math.pow(v - mid, 2), 0) / n);
  const upper = mid + 2 * std;
  const lower = mid - 2 * std;
  const pct = std > 0 ? parseFloat(((closes.at(-1) - lower) / (upper - lower) * 100).toFixed(1)) : 50;
  return { upper: parseFloat(upper.toFixed(4)), mid: parseFloat(mid.toFixed(4)), lower: parseFloat(lower.toFixed(4)), pct };
}

function buildIndicators(sym) {
  const c = candles[sym];
  if (c.length < 5) return null;
  const closes = c.map(x => x.close);
  const highs  = c.map(x => x.high);
  const lows   = c.map(x => x.low);
  const vols   = c.map(x => x.vol);
  const price  = closes.at(-1);
  const avgVol = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(vols.length, 20);
  const bb     = bollingerBands(closes);
  return {
    symbol:     sym,
    price:      parseFloat(price.toFixed(6)),
    change24h:  parseFloat(((price - closes.at(-96 < -closes.length ? 0 : -96)) / (closes.at(-96 < -closes.length ? 0 : -96) || price) * 100).toFixed(2)),
    rsi:        rsi(closes),
    trend:      trend(closes),
    mom10:      mom(closes, 10),
    mom30:      mom(closes, 30),
    atr:        atr(highs, lows, closes),
    macd:       macd(closes).hist,
    bbPct:      bb.pct,
    support:    parseFloat(Math.min(...lows.slice(-20)).toFixed(6)),
    resistance: parseFloat(Math.max(...highs.slice(-20)).toFixed(6)),
    ema9:       parseFloat(ema(closes, 9).toFixed(6)),
    ema21:      parseFloat(ema(closes, 21).toFixed(6)),
    ema50:      parseFloat(ema(closes, 50).toFixed(6)),
    volRatio:   avgVol > 0 ? parseFloat((vols.at(-1) / avgVol).toFixed(2)) : 1,
    candles:    c.length
  };
}

// ── KUCOIN: FETCH REAL CANDLES ────────────────────────────────────
async function fetchKlines(sym, limit = 100) {
  // KuCoin klines endpoint — no auth needed
  // KuCoin candles: startAt/endAt in seconds, no pageSize param
  const endAt   = Math.floor(Date.now() / 1000);
  const startAt = endAt - (limit * 15 * 60); // limit candles back
  const resp = await axios.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol: `${sym}-USDT`, type: '15min', startAt, endAt },
    timeout: 10000,
    headers: { 'Accept': 'application/json' }
  });
  if (resp.data.code !== '200000') throw new Error(`KuCoin error for ${sym}`);
  // KuCoin returns [time, open, close, high, low, vol, turnover] newest first
  const raw = resp.data.data.reverse(); // oldest first
  return raw.map(k => ({
    time:  parseInt(k[0]),
    open:  parseFloat(k[1]),
    close: parseFloat(k[2]),
    high:  parseFloat(k[3]),
    low:   parseFloat(k[4]),
    vol:   parseFloat(k[5])
  }));
}

// ── KUCOIN: LATEST TICKER (for current price) ─────────────────────
async function fetchTickers() {
  const resp = await axios.get('https://api.kucoin.com/api/v1/market/allTickers', {
    timeout: 8000
  });
  if (resp.data.code !== '200000') throw new Error('KuCoin tickers failed');
  const map = {};
  resp.data.data.ticker.forEach(t => { map[t.symbol] = t; });
  return map;
}

// ── INIT: load 100 real candles for all coins ─────────────────────
async function initCandles() {
  console.log('Loading real candles from KuCoin...');
  let loaded = 0;
  for (const sym of COINS) {
    try {
      const klines = await fetchKlines(sym, 100);
      candles[sym] = klines;
      loaded++;
      await new Promise(r => setTimeout(r, 200)); // 200ms between requests
    } catch (e) {
      console.error(`Failed ${sym}:`, e.message);
    }
  }
  console.log(`Candles loaded: ${loaded}/${COINS.length}`);
}

// ── REFRESH: add latest candle every 15 min ───────────────────────
async function refreshCandles() {
  try {
    const tickers = await fetchTickers();
    for (const sym of COINS) {
      const t = tickers[`${sym}-USDT`];
      if (!t) continue;
      const price = parseFloat(t.last);
      if (!price) continue;
      // Add a synthetic latest point using current price
      const last = candles[sym].at(-1);
      if (last) {
        candles[sym].push({
          time:  Date.now() / 1000,
          open:  last.close,
          close: price,
          high:  Math.max(last.close, price),
          low:   Math.min(last.close, price),
          vol:   parseFloat(t.vol) || last.vol
        });
        if (candles[sym].length > 150) candles[sym].shift();
      }
    }
  } catch (e) {
    console.error('Refresh error:', e.message);
  }
}

// ── NEWS ──────────────────────────────────────────────────────────
let newsCache = { data: [], ts: 0, sentiment: 'NEUTRAL' };

async function fetchNews() {
  if (!NEWSDATA_KEY) return newsCache;
  if (Date.now() - newsCache.ts < 5 * 60 * 1000) return newsCache;
  try {
    const resp = await axios.get('https://newsdata.io/api/1/news', {
      params: { apikey: NEWSDATA_KEY, q: 'crypto bitcoin', language: 'en', size: 8 },
      timeout: 8000
    });
    const articles = resp.data.results || [];
    const headlines = articles.map(a => ({ title: a.title, time: a.pubDate, source: a.source_id }));
    const text = headlines.map(h => h.title.toLowerCase()).join(' ');
    const pos = ['surge','rally','bull','gain','rise','pump','bullish','record','ath','high'].filter(w => text.includes(w)).length;
    const neg = ['crash','dump','fall','drop','bear','sell','bearish','hack','ban','fear','collapse'].filter(w => text.includes(w)).length;
    const sentiment = pos > neg + 1 ? 'BULLISH' : neg > pos + 1 ? 'BEARISH' : 'NEUTRAL';
    newsCache = { data: headlines, ts: Date.now(), sentiment };
  } catch (e) {
    console.error('News error:', e.message);
  }
  return newsCache;
}

// ── MARKET CACHE ──────────────────────────────────────────────────
let marketCache = { data: [], ts: 0 };

function buildMarketData() {
  const result = [];
  for (const sym of COINS) {
    const ind = buildIndicators(sym);
    if (ind) result.push(ind);
  }
  marketCache = { data: result, ts: Date.now() };
  return result;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    const data = marketCache.data.length ? marketCache.data : buildMarketData();
    if (!data.length) return res.status(503).json({ ok: false, error: 'Candles loading, retry in 10s' });
    res.json({ ok: true, data, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const news = await fetchNews();
    res.json({ ok: true, ...news });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/analyze', async (req, res) => {
  try {
    if (!CLAUDE_KEY) return res.status(500).json({ ok: false, error: 'CLAUDE_API_KEY not set' });
    const { prompt, model } = req.body;
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: model || 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: `You are NEXUS PRO, an expert autonomous crypto trading AI.
You trade BOTH long AND short positions. Analyze real technical data carefully.
CRITICAL: Return ONLY a raw JSON object. No markdown. No backticks. Just {}.`,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: {
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    const text = resp.data.content[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ ok: false, error: 'No JSON in Claude response: ' + text.slice(0, 100) });
    res.json({ ok: true, result: JSON.parse(match[0]) });
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 200) : e.message;
    console.error('Analyze error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    coins: marketCache.data.length,
    candleCount: Object.fromEntries(COINS.slice(0, 5).map(s => [s, candles[s].length])),
    keys: { claude: !!CLAUDE_KEY, news: !!NEWSDATA_KEY }
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Global error handler
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ ok: false, error: String(err.message) });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`NEXUS PRO on port ${PORT}`);
  console.log(`Keys: Claude=${!!CLAUDE_KEY} News=${!!NEWSDATA_KEY}`);

  // Load real candles on startup
  await initCandles();
  buildMarketData();

  // Refresh price every 30s (add latest tick)
  setInterval(() => {
    refreshCandles().then(() => buildMarketData());
  }, 30 * 1000);

  // Full candle refresh every 15 min
  setInterval(async () => {
    await initCandles();
    buildMarketData();
    console.log('Full candle refresh done');
  }, 15 * 60 * 1000);

  // Keep-alive ping every 14 min
  const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try { await axios.get(`${SELF}/api/health`, { timeout: 5000 }); }
    catch (e) { console.log('Keep-alive failed:', e.message); }
  }, 14 * 60 * 1000);
});
