const express = require('express');
const axios   = require('axios');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const NEWSDATA_KEY = process.env.Newsdata        || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── DYNAMIC COIN STORE ────────────────────────────────────────────
// Refreshed every 15 min from KuCoin top volume
let activeCoins = []; // [{symbol, volume, change24h, price}]
const candles   = {}; // symbol -> [{open,high,low,close,vol}]

// ── INDICATORS ────────────────────────────────────────────────────
function ema(arr, n) {
  if (arr.length < n) return arr.at(-1) || 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
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
function atr(highs, lows, closes, n = 14) {
  if (closes.length < n + 1) return 1.5;
  let sum = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - (closes[i-1]||closes[i])),
      Math.abs(lows[i]  - (closes[i-1]||closes[i]))
    );
    sum += tr;
  }
  return parseFloat(((sum / n) / closes.at(-1) * 100).toFixed(2));
}
function calcTrend(closes) {
  if (closes.length < 55) return 'SIDE';
  const e9 = ema(closes, 9), e21 = ema(closes, 21), e50 = ema(closes, 50);
  if (e9 > e21 && e21 > e50) return 'UP';
  if (e9 < e21 && e21 < e50) return 'DOWN';
  return 'SIDE';
}
function mom(closes, n = 10) {
  if (closes.length < n + 2) return 0;
  return parseFloat(((closes.at(-1) - closes.at(-n-1)) / closes.at(-n-1) * 100).toFixed(2));
}
function volRatio(vols) {
  if (vols.length < 10) return 1;
  const avg = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(vols.length, 20);
  return avg > 0 ? parseFloat((vols.at(-1) / avg).toFixed(2)) : 1;
}

// ── STEP 1: Get top hot coins by volume from KuCoin ───────────────
async function fetchTopCoins(limit = 60) {
  const resp = await axios.get('https://api.kucoin.com/api/v1/market/allTickers', {
    timeout: 10000,
    headers: { 'Accept': 'application/json' }
  });
  if (resp.data.code !== '200000') throw new Error('KuCoin tickers failed');

  const tickers = resp.data.data.ticker || [];

  // Filter: USDT pairs only, price > $0.001, exclude stablecoins/leveraged
  const exclude = ['USDT','USDC','BUSD','DAI','TUSD','USDP','FDUSD','UST',
                   '3L','3S','2L','2S','UP','DOWN','BEAR','BULL'];

  const filtered = tickers
    .filter(t => {
      if (!t.symbol.endsWith('-USDT')) return false;
      const sym = t.symbol.replace('-USDT','');
      if (exclude.some(e => sym.includes(e))) return false;
      const price = parseFloat(t.last);
      const vol   = parseFloat(t.volValue);
      return price > 0.0001 && vol > 100000; // min $100k daily volume
    })
    .map(t => ({
      symbol:    t.symbol.replace('-USDT',''),
      price:     parseFloat(t.last),
      volume:    parseFloat(t.volValue),
      change24h: parseFloat((parseFloat(t.changeRate||0) * 100).toFixed(2)),
      high24h:   parseFloat(t.high||t.last),
      low24h:    parseFloat(t.low||t.last),
    }))
    .sort((a, b) => b.volume - a.volume) // sort by volume descending
    .slice(0, limit);

  return filtered;
}

// ── STEP 2: Fetch real 15min candles for a coin ───────────────────
async function fetchCandles(sym, limit = 100) {
  const endAt   = Math.floor(Date.now() / 1000);
  const startAt = endAt - (limit * 15 * 60);
  const resp = await axios.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol: `${sym}-USDT`, type: '15min', startAt, endAt },
    timeout: 10000,
    headers: { 'Accept': 'application/json' }
  });
  if (resp.data.code !== '200000') throw new Error(`Candles failed: ${sym}`);
  // KuCoin: [time, open, close, high, low, vol, turnover] newest first
  return resp.data.data.reverse().map(k => ({
    time:  parseInt(k[0]),
    open:  parseFloat(k[1]),
    close: parseFloat(k[2]),
    high:  parseFloat(k[3]),
    low:   parseFloat(k[4]),
    vol:   parseFloat(k[5])
  }));
}

// ── STEP 3: Build full indicator snapshot for one coin ────────────
function buildCoinData(sym, tickerData) {
  const c = candles[sym];
  if (!c || c.length < 20) return null;

  const closes = c.map(x => x.close);
  const highs  = c.map(x => x.high);
  const lows   = c.map(x => x.low);
  const vols   = c.map(x => x.vol);
  const price  = tickerData?.price || closes.at(-1);

  const rsiVal   = rsi(closes);
  const trendVal = calcTrend(closes);
  const atrVal   = atr(highs, lows, closes);
  const mom10    = mom(closes, 10);
  const mom30    = mom(closes, 30);
  const vr       = volRatio(vols);
  const sup      = parseFloat(Math.min(...lows.slice(-20)).toFixed(6));
  const res      = parseFloat(Math.max(...highs.slice(-20)).toFixed(6));

  // Hot score: high volume ratio + strong momentum + not extreme RSI
  const hotScore = (vr > 1.5 ? 2 : vr > 1.2 ? 1 : 0)
                 + (Math.abs(mom10) > 2 ? 2 : Math.abs(mom10) > 1 ? 1 : 0)
                 + (rsiVal < 35 || rsiVal > 65 ? 1 : 0);

  return {
    symbol:     sym,
    price:      parseFloat(price.toFixed(6)),
    change24h:  tickerData?.change24h || 0,
    volume:     tickerData?.volume    || 0,
    rsi:        rsiVal,
    trend:      trendVal,
    mom10,
    mom30,
    atr:        atrVal,
    volRatio:   vr,
    support:    sup,
    resistance: res,
    ema9:       parseFloat(ema(closes, 9).toFixed(6)),
    ema21:      parseFloat(ema(closes, 21).toFixed(6)),
    ema50:      parseFloat(ema(closes, 50).toFixed(6)),
    hotScore,
    candles:    c.length
  };
}

// ── MARKET CACHE ──────────────────────────────────────────────────
let marketCache = { data: [], ts: 0 };

function buildMarketData() {
  const tickerMap = {};
  activeCoins.forEach(c => { tickerMap[c.symbol] = c; });

  const result = [];
  for (const sym of Object.keys(candles)) {
    const d = buildCoinData(sym, tickerMap[sym]);
    if (d) result.push(d);
  }
  // Sort by hotScore desc, then volume
  result.sort((a, b) => b.hotScore - a.hotScore || b.volume - a.volume);
  marketCache = { data: result, ts: Date.now() };
  return result;
}

// ── FULL REFRESH: top coins + candles ─────────────────────────────
async function fullRefresh() {
  console.log('Fetching top coins by volume...');
  try {
    activeCoins = await fetchTopCoins(60);
    console.log(`Top coins: ${activeCoins.length} found`);
  } catch (e) {
    console.error('fetchTopCoins error:', e.message);
    return;
  }

  let loaded = 0;
  for (const coin of activeCoins) {
    try {
      const klines = await fetchCandles(coin.symbol, 100);
      if (klines.length >= 20) {
        candles[coin.symbol] = klines;
        loaded++;
      }
      await new Promise(r => setTimeout(r, 250)); // rate limit spacing
    } catch (e) {
      // skip failed coins silently
    }
  }
  console.log(`Candles loaded: ${loaded}/${activeCoins.length}`);
  buildMarketData();
}

// ── PRICE TICK: update latest price every 30s ─────────────────────
async function priceTick() {
  try {
    const resp = await axios.get('https://api.kucoin.com/api/v1/market/allTickers', {
      timeout: 8000,
      headers: { 'Accept': 'application/json' }
    });
    if (resp.data.code !== '200000') return;
    const tickerMap = {};
    resp.data.data.ticker.forEach(t => { tickerMap[t.symbol] = t; });

    for (const sym of Object.keys(candles)) {
      const t = tickerMap[`${sym}-USDT`];
      if (!t) continue;
      const price = parseFloat(t.last);
      if (!price) continue;
      const last = candles[sym].at(-1);
      if (!last) continue;
      // Update last candle with latest price
      candles[sym][candles[sym].length - 1].close = price;
      candles[sym][candles[sym].length - 1].high  = Math.max(last.high, price);
      candles[sym][candles[sym].length - 1].low   = Math.min(last.low,  price);
      // Update activeCoins price
      const ac = activeCoins.find(c => c.symbol === sym);
      if (ac) {
        ac.price     = price;
        ac.change24h = parseFloat((parseFloat(t.changeRate||0)*100).toFixed(2));
      }
    }
    buildMarketData();
  } catch (e) {
    console.error('priceTick error:', e.message);
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
    const pos = ['surge','rally','bull','gain','rise','pump','bullish','record','ath'].filter(w=>text.includes(w)).length;
    const neg = ['crash','dump','fall','drop','bear','bearish','hack','ban','fear','collapse'].filter(w=>text.includes(w)).length;
    newsCache = {
      data: headlines,
      ts: Date.now(),
      sentiment: pos > neg + 1 ? 'BULLISH' : neg > pos + 1 ? 'BEARISH' : 'NEUTRAL'
    };
  } catch (e) { console.error('News error:', e.message); }
  return newsCache;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  try {
    const data = marketCache.data.length ? marketCache.data : buildMarketData();
    if (!data.length) return res.status(503).json({ ok: false, error: 'Loading market data, retry in 15s' });
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
      max_tokens: 2000,
      system: `You are NEXUS PRO, an expert autonomous crypto trading AI.
You analyze real market data and take LONG or SHORT positions based on technical analysis.
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
    const text  = resp.data.content[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return res.status(500).json({ ok: false, error: 'No JSON in response' });
    res.json({ ok: true, result: JSON.parse(match[0]) });
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data).slice(0, 300) : e.message;
    console.error('Analyze error:', msg);
    res.status(500).json({ ok: false, error: msg });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    trackedCoins: Object.keys(candles).length,
    marketData: marketCache.data.length,
    topCoins: activeCoins.slice(0,5).map(c=>c.symbol),
    keys: { claude: !!CLAUDE_KEY, news: !!NEWSDATA_KEY }
  });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((err, req, res, next) => {
  res.status(500).json({ ok: false, error: String(err.message) });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`NEXUS PRO on port ${PORT}`);
  console.log(`Keys: Claude=${!!CLAUDE_KEY} News=${!!NEWSDATA_KEY}`);

  // Initial load
  await fullRefresh();

  // Price tick every 30s
  setInterval(priceTick, 30 * 1000);

  // Full candle refresh every 15 min
  setInterval(fullRefresh, 15 * 60 * 1000);

  // Keep-alive every 14 min
  const SELF = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  setInterval(async () => {
    try { await axios.get(`${SELF}/api/health`, { timeout: 5000 }); }
    catch (e) {}
  }, 14 * 60 * 1000);
});
