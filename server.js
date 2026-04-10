const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── ENV KEYS ──────────────────────────────────────────────────────
const BINANCE_KEY    = process.env.BINANCE_API_KEY || '';
const BINANCE_SECRET = process.env.BINANCE_API_SECRET || '';
const NEWSDATA_KEY   = process.env.Newsdata        || '';
const ANTHROPIC_KEY  = process.env.CLAUDE_API_KEY  || '';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname)));

// ── COIN LIST ────────────────────────────────────────────────────
const COINS = [
  'BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX',
  'LINK','DOT','MATIC','UNI','ATOM','NEAR','LTC',
  'AAVE','ARB','OP','INJ','TIA'
];

// ── IN-MEMORY PRICE HISTORY ───────────────────────────────────────
const history = {};
COINS.forEach(c => { history[c] = []; });

// ── CACHES ────────────────────────────────────────────────────────
let marketCache = { data: [], ts: 0 };
let newsCache   = { data: [], ts: 0, sentiment: 'NEUTRAL' };

// ── INDICATORS ────────────────────────────────────────────────────
function ema(arr, n) {
  if (arr.length < n) return arr[arr.length - 1] || 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function rsi(arr, n = 14) {
  if (arr.length < n + 1) return 50;
  let g = 0, l = 0;
  for (let i = arr.length - n; i < arr.length; i++) {
    const d = arr[i] - arr[i - 1];
    d > 0 ? g += d : l -= d;
  }
  if (l === 0) return 100;
  return parseFloat((100 - 100 / (1 + (g / n) / (l / n))).toFixed(1));
}
function mom(arr, n = 6) {
  if (arr.length < n + 2) return 0;
  return parseFloat(((arr[arr.length-1] - arr[arr.length-n-1]) / arr[arr.length-n-1] * 100).toFixed(2));
}
function atrEst(arr) {
  if (arr.length < 5) return 1.5;
  const slice = arr.slice(-14);
  const changes = slice.slice(1).map((v, i) => Math.abs((v - slice[i]) / slice[i]) * 100);
  return parseFloat((changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(2));
}
function calcTrend(arr) {
  if (arr.length < 52) return 'SIDE';
  const e9 = ema(arr, 9), e21 = ema(arr, 21), e50 = ema(arr, 50);
  if (e9 > e21 && e21 > e50) return 'UP';
  if (e9 < e21 && e21 < e50) return 'DOWN';
  return 'SIDE';
}

// ── KUCOIN FETCH (no key, no geo-block, generous rate limit) ────
async function fetchMarketPrices() {
  const resp = await axios.get('https://api.kucoin.com/api/v1/market/allTickers', {
    timeout: 12000,
    headers: { 'Accept': 'application/json' }
  });

  if (!resp.data || resp.data.code !== '200000') throw new Error('KuCoin bad response');

  const tickerMap = {};
  (resp.data.data.ticker || []).forEach(t => { tickerMap[t.symbol] = t; });

  const result = [];
  COINS.forEach(sym => {
    const t = tickerMap[sym + '-USDT'];
    if (!t) return;
    const price = parseFloat(t.last);
    if (!price) return;
    history[sym].push(price);
    if (history[sym].length > 100) history[sym].shift();
    const h = history[sym];
    const chg = t.changeRate ? parseFloat((parseFloat(t.changeRate) * 100).toFixed(2)) : 0;
    result.push({
      symbol:     sym,
      price,
      change24h:  chg,
      volume:     parseFloat(t.volValue) || 0,
      high24h:    parseFloat(t.high) || price,
      low24h:     parseFloat(t.low)  || price,
      rsi:        rsi(h),
      trend:      calcTrend(h),
      mom6:       mom(h, 6),
      mom20:      mom(h, 20),
      atr:        atrEst(h),
      support:    parseFloat((Math.min(...h.slice(-20)) || price).toFixed(6)),
      resistance: parseFloat((Math.max(...h.slice(-20)) || price).toFixed(6)),
    });
  });
  return result;
}

// ── NEWS FETCH (Newsdata.io) ──────────────────────────────────────
async function fetchNews() {
  if (!NEWSDATA_KEY) return { headlines: [], sentiment: 'NEUTRAL' };
  if (Date.now() - newsCache.ts < 5 * 60 * 1000) return newsCache; // 5min cache

  try {
    const resp = await axios.get('https://newsdata.io/api/1/news', {
      params: {
        apikey:   NEWSDATA_KEY,
        q:        'cryptocurrency bitcoin ethereum',
        language: 'en',
        category: 'business,technology',
        size:     10
      },
      timeout: 8000
    });

    const articles = resp.data.results || [];
    const headlines = articles.slice(0, 8).map(a => ({
      title: a.title,
      time:  a.pubDate,
      source: a.source_id
    }));

    // Basic sentiment: count positive/negative keywords
    const text = headlines.map(h => h.title.toLowerCase()).join(' ');
    const posWords = ['surge','rally','bull','gain','rise','high','pump','up','growth','buy','bullish','record','ath'];
    const negWords = ['crash','dump','fall','drop','bear','low','sell','bearish','hack','ban','fear','collapse','lawsuit'];
    let posScore = 0, negScore = 0;
    posWords.forEach(w => { if (text.includes(w)) posScore++; });
    negWords.forEach(w => { if (text.includes(w)) negScore++; });

    const sentiment = posScore > negScore + 1 ? 'BULLISH' : negScore > posScore + 1 ? 'BEARISH' : 'NEUTRAL';
    newsCache = { data: headlines, ts: Date.now(), sentiment };
    return newsCache;
  } catch (e) {
    console.error('News fetch error:', e.message);
    return newsCache;
  }
}

// ── MARKET DATA (with cache) ──────────────────────────────────────
async function getMarketData() {
  // Use cache if less than 60s old
  if (Date.now() - marketCache.ts < 60000 && marketCache.data.length)
    return marketCache.data;
  try {
    const data = await fetchMarketPrices();
    if (data.length) marketCache = { data, ts: Date.now() };
    return marketCache.data;
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.log('CoinGecko rate limit hit — using cached data, retry in 60s');
      marketCache.ts = Date.now() - 30000; // retry after 30s
    } else {
      console.error('Market data error:', e.message);
    }
    return marketCache.data;
  }
}

// ── CLAUDE ANALYZE (server-side) ─────────────────────────────────
async function claudeAnalyze(payload) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set in environment');

  const resp = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model:      payload.model || 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: `You are NEXUS PRO, an expert autonomous crypto trading AI.
You trade BOTH long AND short positions based on technical analysis and news sentiment.
CRITICAL: Return ONLY a raw JSON object. No markdown. No backticks. Just {}.`,
      messages: [{ role: 'user', content: payload.prompt }]
    },
    {
      headers: {
        'x-api-key':         ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json'
      },
      timeout: 30000
    }
  );

  const text = resp.data.content[0]?.text || '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in Claude response');
  return JSON.parse(match[0]);
}

// ── ROUTES ────────────────────────────────────────────────────────

// Market data
app.get('/api/data', async (req, res) => {
  try {
    const data = await getMarketData();
    if (!data.length)
      return res.status(503).json({ ok: false, error: 'Warming up — retry in 15s' });
    res.json({ ok: true, data, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// News + sentiment
app.get('/api/news', async (req, res) => {
  try {
    const news = await fetchNews();
    res.json({ ok: true, ...news });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Claude analysis
app.post('/api/analyze', async (req, res) => {
  try {
    const result = await claudeAnalyze(req.body);
    return res.json({ ok: true, result });
  } catch (e) {
    const msg = (e.response && e.response.data)
      ? JSON.stringify(e.response.data).slice(0, 300)
      : String(e.message || 'Unknown error');
    console.error('Analyze error:', msg);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    ok:       true,
    coins:    marketCache.data.length,
    dataAge:  Math.round((Date.now() - marketCache.ts) / 1000) + 's',
    newsAge:  Math.round((Date.now() - newsCache.ts)   / 1000) + 's',
    keys: {
      binance:   !!BINANCE_KEY,
      newsdata:  !!NEWSDATA_KEY,
      anthropic: !!ANTHROPIC_KEY
    }
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── STARTUP ───────────────────────────────────────────────────────
// Global error handler — always returns JSON, never HTML
app.use((err, req, res, next) => {
  console.error('Express error:', err.message);
  res.status(500).json({ ok: false, error: String(err.message) });
});

app.listen(PORT, () => {
  console.log(`NEXUS PRO on port ${PORT}`);
  console.log(`Keys: Binance=${!!BINANCE_KEY} News=${!!NEWSDATA_KEY} Anthropic=${!!ANTHROPIC_KEY}`);
  // Delayed warmup — wait 5s after boot to avoid rate limit burst
  setTimeout(async () => {
    try {
      const d = await getMarketData();
      console.log(`Warmup OK — ${d.length} coins`);
    } catch(e) {
      console.error('Warmup error:', e.message);
    }
  }, 5000);

  // Keep-alive: ping self every 14 min to prevent Render free tier spin-down
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try {
      await axios.get(`${SELF_URL}/api/health`, { timeout: 5000 });
      console.log('Keep-alive ping OK');
    } catch(e) {
      console.log('Keep-alive ping failed:', e.message);
    }
  }, 14 * 60 * 1000);
});
