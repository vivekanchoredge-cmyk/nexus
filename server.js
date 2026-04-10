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

app.use(express.json());
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

// ── COINGECKO COIN MAP ───────────────────────────────────────────
const CG_MAP = {
  BTC:'bitcoin', ETH:'ethereum', BNB:'binancecoin', SOL:'solana',
  XRP:'ripple', DOGE:'dogecoin', ADA:'cardano', AVAX:'avalanche-2',
  LINK:'chainlink', DOT:'polkadot', MATIC:'matic-network', UNI:'uniswap',
  ATOM:'cosmos', NEAR:'near', LTC:'litecoin', AAVE:'aave',
  ARB:'arbitrum', OP:'optimism', INJ:'injective-protocol', TIA:'celestia'
};
const CG_IDS = Object.values(CG_MAP).join(',');

async function fetchMarketPrices() {
  const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
    params: {
      vs_currency: 'usd',
      ids: CG_IDS,
      order: 'market_cap_desc',
      per_page: 50,
      price_change_percentage: '24h'
    },
    timeout: 12000,
    headers: { 'Accept': 'application/json' }
  });

  const byId = {};
  resp.data.forEach(d => { byId[d.id] = d; });

  const result = [];
  Object.entries(CG_MAP).forEach(([sym, cgId]) => {
    const d = byId[cgId];
    if (!d) return;
    const price = d.current_price;
    history[sym].push(price);
    if (history[sym].length > 100) history[sym].shift();
    const h = history[sym];
    result.push({
      symbol:     sym,
      price,
      change24h:  parseFloat((d.price_change_percentage_24h || 0).toFixed(2)),
      volume:     d.total_volume || 0,
      high24h:    d.high_24h || price,
      low24h:     d.low_24h  || price,
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
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
});
