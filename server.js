const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const SYMBOLS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT',
  'DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT',
  'MATICUSDT','UNIUSDT','ATOMUSDT','NEARUSDT','LTCUSDT',
  'AAVEUSDT','ARBUSDT','OPUSDT','INJUSDT','TIAUSDT'
];

// Cache to avoid hammering Binance
let priceCache = {};
let klinesCache = {};
let lastFetch = 0;

async function fetchPrices() {
  try {
    const now = Date.now();
    if (now - lastFetch < 15000) return priceCache; // 15s cache

    const resp = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 8000 });
    const data = resp.data;
    const result = {};
    SYMBOLS.forEach(sym => {
      const t = data.find(d => d.symbol === sym);
      if (t) {
        result[sym] = {
          symbol: sym,
          price: parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          volume: parseFloat(t.quoteVolume),
          high24h: parseFloat(t.highPrice),
          low24h: parseFloat(t.lowPrice)
        };
      }
    });
    priceCache = result;
    lastFetch = now;
    return result;
  } catch (e) {
    console.error('Binance price fetch error:', e.message);
    return priceCache;
  }
}

async function fetchKlines(symbol, interval = '15m', limit = 60) {
  const cacheKey = `${symbol}_${interval}`;
  const cached = klinesCache[cacheKey];
  if (cached && Date.now() - cached.time < 60000) return cached.data;
  try {
    const resp = await axios.get(`https://api.binance.com/api/v3/klines`, {
      params: { symbol, interval, limit },
      timeout: 8000
    });
    const closes = resp.data.map(k => parseFloat(k[4]));
    const highs  = resp.data.map(k => parseFloat(k[2]));
    const lows   = resp.data.map(k => parseFloat(k[3]));
    const vols   = resp.data.map(k => parseFloat(k[5]));
    klinesCache[cacheKey] = { time: Date.now(), data: { closes, highs, lows, vols } };
    return klinesCache[cacheKey].data;
  } catch (e) {
    console.error('Klines fetch error:', e.message);
    return klinesCache[cacheKey]?.data || null;
  }
}

// ── INDICATORS ───────────────────────────────────────────────────────
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  return 100 - (100 / (1 + (gains / period) / (losses / period)));
}
function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length - 1];
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}
function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return 0;
  let sum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    sum += Math.abs(highs[i] - lows[i]);
  }
  return (sum / period / closes[closes.length - 1]) * 100;
}
function calcMom(closes, period = 6) {
  if (closes.length < period + 2) return 0;
  const old = closes[closes.length - period - 1];
  return ((closes[closes.length - 1] - old) / old) * 100;
}
function calcTrend(closes) {
  if (closes.length < 52) return 'SIDE';
  const e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21), e50 = calcEMA(closes, 50);
  if (e9 > e21 && e21 > e50) return 'UP';
  if (e9 < e21 && e21 < e50) return 'DOWN';
  return 'SIDE';
}
function calcSupport(lows) { return Math.min(...lows.slice(-20)); }
function calcResistance(highs) { return Math.max(...highs.slice(-20)); }

// ── ROUTES ────────────────────────────────────────────────────────────
app.get('/api/prices', async (req, res) => {
  try {
    const prices = await fetchPrices();
    res.json({ ok: true, data: prices, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/data', async (req, res) => {
  try {
    const prices = await fetchPrices();
    const result = [];
    for (const sym of SYMBOLS) {
      const p = prices[sym];
      if (!p) continue;
      const klines = await fetchKlines(sym);
      if (!klines) {
        result.push({ ...p, rsi: 50, trend: 'SIDE', mom: 0, atr: 1, support: p.price * 0.97, resistance: p.price * 1.03 });
        continue;
      }
      const { closes, highs, lows } = klines;
      result.push({
        symbol: sym.replace('USDT', ''),
        price: p.price,
        change24h: p.change24h,
        volume: p.volume,
        high24h: p.high24h,
        low24h: p.low24h,
        rsi: parseFloat(calcRSI(closes).toFixed(1)),
        trend: calcTrend(closes),
        mom6: parseFloat(calcMom(closes, 6).toFixed(2)),
        mom20: parseFloat(calcMom(closes, 20).toFixed(2)),
        atr: parseFloat(calcATR(highs, lows, closes).toFixed(2)),
        support: parseFloat(calcSupport(lows).toFixed(6)),
        resistance: parseFloat(calcResistance(highs).toFixed(6)),
        ema9: parseFloat(calcEMA(closes, 9).toFixed(6)),
        ema21: parseFloat(calcEMA(closes, 21).toFixed(6)),
        ema50: parseFloat(calcEMA(closes, 50).toFixed(6))
      });
    }
    res.json({ ok: true, data: result, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`NEXUS running on port ${PORT}`));
