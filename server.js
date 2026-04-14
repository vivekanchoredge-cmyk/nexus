const express = require('express');
const axios   = require('axios');
const WebSocket = require('ws');
const path    = require('path');
const { createClient } = require('@libsql/client');
const crypto = require('crypto');

// ── TURSO DATABASE ────────────────────────────────────────────────
const db = createClient({
  url:       process.env.TURSO_DATABASE_URL || '',
  authToken: process.env.TURSO_AUTH_TOKEN   || '',
});

async function initDB() {
  if (!process.env.TURSO_DATABASE_URL) {
    console.warn('TURSO_DATABASE_URL not set — DB logging disabled');
    return;
  }
  await db.execute(`
    CREATE TABLE IF NOT EXISTS signals (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol      TEXT,
      signal      TEXT,
      entry       REAL,
      tp          REAL,
      sl          REAL,
      confidence  INTEGER,
      reasoning   TEXT,
      outcome     TEXT DEFAULT 'PENDING',
      exit_price  REAL,
      pnl_pct     REAL,
      evaluated_at DATETIME,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('Turso DB ready');
}

// ── LOAD PAST SIGNALS (memory for Claude) ────────────────────────
async function loadMemory(symbol) {
  if (!process.env.TURSO_DATABASE_URL) return '';
  try {
    // Recent signals for THIS symbol (last 10)
    const symRows = await db.execute({
      sql: `SELECT symbol, signal, entry, tp, sl, confidence, outcome, pnl_pct, reasoning, created_at
            FROM signals
            WHERE outcome != 'PENDING' AND symbol = ?
            ORDER BY id DESC LIMIT 15`,
      args: [symbol || 'N/A']
    });

    // Overall recent signals (last 20) for general learning
    const allRows = await db.execute({
      sql: `SELECT symbol, signal, entry, tp, sl, confidence, outcome, pnl_pct, reasoning, created_at
            FROM signals
            WHERE outcome != 'PENDING'
            ORDER BY id DESC LIMIT 30`,
      args: []
    });

    // Win rate stats per symbol
    const statsRows = await db.execute({
      sql: `SELECT symbol,
              COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              ROUND(AVG(pnl_pct),2) as avg_pnl
            FROM signals
            WHERE outcome IN ('WIN','LOSS')
            GROUP BY symbol
            ORDER BY total DESC LIMIT 10`,
      args: []
    });

    if (!allRows.rows.length) return '';

    const symLines = symRows.rows.map(r => {
      const pnl = r.pnl_pct != null ? `PnL=${r.pnl_pct}%` : '';
      return `  [${r.created_at}] ${r.symbol} ${r.signal} entry=${r.entry} tp=${r.tp} sl=${r.sl} conf=${r.confidence}% => ${r.outcome} ${pnl} | ${r.reasoning||'N/A'}`;
    }).join('\n');

    const allLines = allRows.rows.map(r => {
      const pnl = r.pnl_pct != null ? `PnL=${r.pnl_pct}%` : '';
      return `  ${r.symbol} ${r.signal} conf=${r.confidence}% => ${r.outcome} ${pnl}`;
    }).join('\n');

    const statsLines = statsRows.rows.map(r =>
      `  ${r.symbol}: ${r.wins}/${r.total} wins, avg PnL=${r.avg_pnl}%`
    ).join('\n');

    // Calculate recent streak for this symbol
    const symHistory = symRows.rows;
    let streak = 0, streakType = '';
    if(symHistory.length > 0){
      const last = symHistory[0].outcome;
      streakType = last;
      for(const r of symHistory){
        if(r.outcome === last) streak++;
        else break;
      }
    }
    const streakStr = streak > 1 ? `\n⚡ CURRENT STREAK: ${streak} consecutive ${streakType}s on ${symbol}` : '';

    return `

YOUR MEMORY SYSTEM — USE THIS TO MAKE SMARTER DECISIONS:

1. YOUR SIGNALS FOR ${symbol} (most recent first):
${symLines || '  No history yet for this coin — apply extra strict entry rules'}${streakStr}

2. RECENT SIGNALS ALL COINS:
${allLines || '  No history yet'}

3. WIN RATE BY COIN:
${statsLines || '  No completed trades yet'}

RULES BASED ON YOUR MEMORY:
- Coins with <40% win rate = skip unless this setup is significantly different
- Same coin + same pattern + same trend that previously LOST = do NOT repeat
- Avg PnL negative for a coin = skip unless strong volume confirmation present
- Patterns that previously won = increase confidence by 0.5
- Patterns that previously lost = decrease confidence by 1.0
- If you have no history on a coin = be extra strict on entry rules
- 2+ consecutive losses on a coin = skip that coin this cycle`
  } catch(e) {
    console.error('loadMemory error:', e.message);
    return '';
  }
}

// ── AUTO-EVALUATOR: check pending signals every 15min ────────────
async function evaluatePendingSignals() {
  if (!process.env.TURSO_DATABASE_URL) return;
  try {
    const rows = await db.execute({
      sql: `SELECT id, symbol, signal, entry, tp, sl FROM signals WHERE outcome='PENDING'`,
      args: []
    });
    if (!rows.rows.length) return;

    for (const row of rows.rows) {
      const sym = row.symbol;
      const coin = marketCache.find(c => c.symbol === sym);
      if (!coin) continue;

      const price = coin.price;
      const isLong  = row.signal === 'LONG';
      const isShort = row.signal === 'SHORT';

      let outcome = null;
      let exitPrice = price;

      if (isLong) {
        if (price >= row.tp)       { outcome = 'WIN';  exitPrice = row.tp; }
        else if (price <= row.sl)  { outcome = 'LOSS'; exitPrice = row.sl; }
      } else if (isShort) {
        if (price <= row.tp)       { outcome = 'WIN';  exitPrice = row.tp; }
        else if (price >= row.sl)  { outcome = 'LOSS'; exitPrice = row.sl; }
      }

      // If still open but >24h old, mark EXPIRED
      if (!outcome) {
        const created = new Date(row.created_at + 'Z').getTime(); // ensure UTC parse
        const age = Date.now() - created;
        if (!isNaN(age) && age > 24 * 60 * 60 * 1000) {
          outcome = 'EXPIRED';
        }
      }

      if (outcome) {
        const pnlPct = (row.entry && row.entry > 0)
          ? parseFloat((((exitPrice - row.entry) / row.entry) * 100 * (isShort ? -1 : 1)).toFixed(2))
          : null;
        // Sanity check — ignore unrealistic PnL values
        const validPnl = (pnlPct !== null && Math.abs(pnlPct) < 50) ? pnlPct : null;
        await db.execute({
          sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, evaluated_at=CURRENT_TIMESTAMP WHERE id=?`,
          args: [outcome, exitPrice, validPnl !== undefined ? validPnl : pnlPct, row.id]
        });
        console.log(`Signal #${row.id} ${sym} ${row.signal} => ${outcome} PnL=${pnlPct}%`);
      }
    }
  } catch(e) {
    console.error('evaluatePendingSignals error:', e.message);
  }
}

// ── TRADING MODE ──────────────────────────────────────────────────
let tradingMode = process.env.TRADING_MODE || 'paper';
const SESSION_TOKENS = new Set(); // active login sessions

// ── KUCOIN ORDER EXECUTION ────────────────────────────────────────
function kuSign(secret, timestamp, method, endpoint, body='') {
  const str = timestamp + method.toUpperCase() + endpoint + body;
  return crypto.createHmac('sha256', secret).update(str).digest('base64');
}

function kuHeaders(method, endpoint, body='') {
  const key        = process.env.KUCOIN_API_KEY        || '';
  const secret     = process.env.KUCOIN_API_SECRET     || '';
  const passphrase = process.env.KUCOIN_PASSPHRASE      || '';
  const ts         = Date.now().toString();
  const passSign   = crypto.createHmac('sha256', secret).update(passphrase).digest('base64');
  return {
    'KC-API-KEY':        key,
    'KC-API-SIGN':       kuSign(secret, ts, method, endpoint, body),
    'KC-API-TIMESTAMP':  ts,
    'KC-API-PASSPHRASE': passSign,
    'KC-API-KEY-VERSION':'2',
    'Content-Type':      'application/json'
  };
}

async function placeMarketOrder(symbol, side, sizeUsdt, coinQty=null) {
  const endpoint = '/api/v1/orders';
  // KuCoin: buy uses 'funds' (USDT amount), sell uses 'size' (coin quantity)
  const orderSize = side === 'buy'
    ? { funds: parseFloat(sizeUsdt).toFixed(2) }
    : { size: (coinQty || (sizeUsdt / (marketCache.find(c=>c.symbol===symbol)?.price||1))).toFixed(6) };
  const body = JSON.stringify({
    clientOid: `nexus_${Date.now()}`,
    side,
    symbol:   `${symbol}-USDT`,
    type:     'market',
    ...orderSize
  });
  const r = await axios.post(`https://api.kucoin.com${endpoint}`, body, {
    headers: kuHeaders('POST', endpoint, body),
    timeout: 10000
  });
  if (r.data.code !== '200000') throw new Error(`KuCoin order failed: ${r.data.msg}`);
  return r.data.data.orderId;
}

async function placeStopOrder(symbol, side, stopPrice, size) {
  const endpoint = '/api/v1/stop-order';
  const body = JSON.stringify({
    clientOid:  `nexus_sl_${Date.now()}`,
    side,
    symbol:     `${symbol}-USDT`,
    type:       'market',
    stop:       side === 'sell' ? 'loss'  : 'entry',
    stopPrice:  stopPrice.toFixed(8),
    size:       size.toFixed(6)
  });
  const r = await axios.post(`https://api.kucoin.com${endpoint}`, body, {
    headers: kuHeaders('POST', endpoint, body),
    timeout: 10000
  });
  if (r.data.code !== '200000') throw new Error(`KuCoin stop order failed: ${r.data.msg}`);
  return r.data.data.orderId;
}

async function placeLimitOrder(symbol, side, price, size) {
  const endpoint = '/api/v1/orders';
  const body = JSON.stringify({
    clientOid: `nexus_tp_${Date.now()}`,
    side,
    symbol:    `${symbol}-USDT`,
    type:      'limit',
    price:     price.toFixed(8),
    size:      size.toFixed(6)
  });
  const r = await axios.post(`https://api.kucoin.com${endpoint}`, body, {
    headers: kuHeaders('POST', endpoint, body),
    timeout: 10000
  });
  if (r.data.code !== '200000') throw new Error(`KuCoin limit order failed: ${r.data.msg}`);
  return r.data.data.orderId;
}

async function cancelKuOrder(orderId) {
  const endpoint = `/api/v1/orders/${orderId}`;
  const r = await axios.delete(`https://api.kucoin.com${endpoint}`, {
    headers: kuHeaders('DELETE', endpoint),
    timeout: 10000
  });
  return r.data;
}

const app  = express();
const PORT = process.env.PORT || 3000;

const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const NEWSDATA_KEY = process.env.Newsdata        || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── AUTH MIDDLEWARE (runs before ALL routes) ──────────────────────
function requireAuth(req, res, next) {
  // Always allow auth routes themselves
  if (req.path === '/api/auth' || req.path === '/api/auth/verify') return next();
  // Allow non-API routes (HTML, CSS, JS files)
  if (!req.path.startsWith('/api')) return next();
  // Check token
  const token = req.headers['x-nexus-token'];
  if (token && SESSION_TOKENS.has(token)) return next();
  return res.status(401).json({ok:false, error:'Unauthorized — please login'});
}
app.use(requireAuth);

// ── LIVE DATA STORE ───────────────────────────────────────────────
const store = {};

let activeSymbols = [];
let wsConnection  = null;
let wsConnected   = false;

// ── INDICATORS ────────────────────────────────────────────────────
function ema(arr, n) {
  if (!arr || arr.length < n) return arr?.at(-1) || 0;
  const k = 2 / (n + 1);
  let e = arr.slice(0, n).reduce((a,b) => a+b, 0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}
function rsi(closes, n=14) {
  if (!closes || closes.length < n+1) return 50;
  let g=0, l=0;
  for (let i=closes.length-n; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    d>0 ? g+=d : l-=d;
  }
  if (l===0) return 100;
  return parseFloat((100 - 100/(1+(g/n)/(l/n))).toFixed(1));
}
function atr(highs, lows, closes, n=14) {
  if (!closes || closes.length < n+1) return 1;
  let sum=0;
  for (let i=closes.length-n; i<closes.length; i++) {
    sum += Math.max(
      highs[i]-lows[i],
      Math.abs(highs[i]-(closes[i-1]||closes[i])),
      Math.abs(lows[i] -(closes[i-1]||closes[i]))
    );
  }
  return parseFloat(((sum/n)/closes.at(-1)*100).toFixed(2));
}
function trend(closes) {
  if (!closes || closes.length < 55) return 'SIDE';
  const e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50);
  if (e9>e21 && e21>e50) return 'UP';
  if (e9<e21 && e21<e50) return 'DOWN';
  return 'SIDE';
}
function mom(closes, n=10) {
  if (!closes || closes.length < n+2) return 0;
  return parseFloat(((closes.at(-1)-closes.at(-n-1))/closes.at(-n-1)*100).toFixed(2));
}
function volRatio(vols) {
  if (!vols || vols.length < 5) return 1;
  const avg = vols.slice(-20).reduce((a,b)=>a+b,0) / Math.min(vols.length,20);
  return avg > 0 ? parseFloat((vols.at(-1)/avg).toFixed(2)) : 1;
}
function pattern(candles) {
  if (!candles || candles.length < 3) return 'N/A';
  const [c1,c2,c3] = candles.slice(-3);
  const body = Math.abs(c3.close-c3.open);
  const range = c3.high-c3.low;
  const bull = c3.close > c3.open;
  if (bull && c2.close<c2.open && c3.close>c2.open && c3.open<c2.close) return 'BULL_ENGULF';
  if (!bull && c2.close>c2.open && c3.close<c2.open && c3.open>c2.close) return 'BEAR_ENGULF';
  if (range>0 && body/range < 0.1) return 'DOJI';
  if (c1.close>c1.open && c2.close>c2.open && c3.close>c3.open) return '3_GREEN';
  if (c1.close<c1.open && c2.close<c2.open && c3.close<c3.open) return '3_RED';
  const lw = Math.min(c3.open,c3.close)-c3.low;
  if (lw > body*2) return 'HAMMER';
  return 'NORMAL';
}

function tfSnapshot(candles) {
  if (!candles || candles.length < 20) return null;
  const closes = candles.map(c=>c.close);
  const highs  = candles.map(c=>c.high);
  const lows   = candles.map(c=>c.low);
  const vols   = candles.map(c=>c.vol);
  return {
    trend:    trend(closes),
    rsi:      rsi(closes),
    mom10:    mom(closes,10),
    atr:      atr(highs,lows,closes),
    volRatio: volRatio(vols),
    ema9:     parseFloat(ema(closes,9).toFixed(6)),
    ema21:    parseFloat(ema(closes,21).toFixed(6)),
    support:  parseFloat(Math.min(...lows.slice(-20)).toFixed(6)),
    resist:   parseFloat(Math.max(...highs.slice(-20)).toFixed(6)),
    pattern:  pattern(candles),
  };
}

// ── KUCOIN REST: initial candle load ─────────────────────────────
async function loadCandles(sym, interval, limit=100) {
  const mins = interval==='15min'?15 : interval==='1hour'?60 : 240;
  const endAt   = Math.floor(Date.now()/1000);
  const startAt = endAt - (limit * mins * 60);
  const r = await axios.get('https://api.kucoin.com/api/v1/market/candles', {
    params: { symbol:`${sym}-USDT`, type:interval, startAt, endAt },
    timeout: 12000, headers:{Accept:'application/json'}
  });
  if (r.data.code !== '200000') throw new Error(`${sym} ${interval}: ${r.data.msg}`);
  return r.data.data.reverse().map(k => ({
    time:parseInt(k[0]), open:parseFloat(k[1]), close:parseFloat(k[2]),
    high:parseFloat(k[3]), low:parseFloat(k[4]), vol:parseFloat(k[5])
  }));
}

// ── KUCOIN WEBSOCKET: live price + candle updates ─────────────────
async function getWsToken() {
  const r = await axios.post('https://api.kucoin.com/api/v1/bullet-public', {}, {timeout:8000});
  if (r.data.code !== '200000') throw new Error('WS token failed');
  const {token, instanceServers} = r.data.data;
  return { token, endpoint: instanceServers[0].endpoint };
}

async function connectWebSocket() {
  if (wsConnected) return;
  try {
    const {token, endpoint} = await getWsToken();
    const wsUrl = `${endpoint}?token=${token}&connectId=nexus${Date.now()}`;
    wsConnection = new WebSocket(wsUrl);

    wsConnection.on('open', () => {
      wsConnected = true;
      console.log('WebSocket connected');

      const tickerTopics = activeSymbols.slice(0,20).map(s=>`${s}-USDT`).join(',');
      wsConnection.send(JSON.stringify({
        id: Date.now(), type:'subscribe',
        topic: `/market/ticker:${tickerTopics}`,
        privateChannel: false, response: true
      }));

      activeSymbols.slice(0,10).forEach(sym => {
        wsConnection.send(JSON.stringify({
          id: Date.now()+Math.random(), type:'subscribe',
          topic: `/market/candles:${sym}-USDT_15min`,
          privateChannel: false, response: true
        }));
      });

      // Clear old heartbeat if exists, create new one
      if (app._heartbeat) clearInterval(app._heartbeat);
      app._heartbeat = setInterval(() => {
        if (wsConnected) wsConnection.send(JSON.stringify({id:Date.now(),type:'ping'}));
      }, 20000);
    });

    wsConnection.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'message') return;

        if (msg.topic && msg.topic.includes('/market/ticker:')) {
          const sym = msg.subject?.replace('-USDT','');
          if (!sym || !store[sym]) return;
          const d = msg.data;
          const price = parseFloat(d.price);
          store[sym].tick = {
            price,
            change24h: parseFloat((parseFloat(d.changeRate||0)*100).toFixed(2)),
            volume24h: parseFloat(d.volValue||0),
            bid: parseFloat(d.bestBid||price),
            ask: parseFloat(d.bestAsk||price),
            lastUpdated: Date.now()
          };
          if (store[sym].m15?.length > 0) {
            const last = store[sym].m15.at(-1);
            last.close = price;
            last.high  = Math.max(last.high, price);
            last.low   = Math.min(last.low, price);
          }
          buildCache();
        }

        if (msg.topic && msg.topic.includes('/market/candles:')) {
          const parts = msg.topic.split(':')[1]?.split('_');
          if (!parts) return;
          const sym = parts[0].replace('-USDT','');
          if (!store[sym]) return;
          const k = msg.data?.candles;
          if (!k) return;
          const candle = {
            time:parseInt(k[0]), open:parseFloat(k[1]), close:parseFloat(k[2]),
            high:parseFloat(k[3]), low:parseFloat(k[4]), vol:parseFloat(k[5])
          };
          const arr = store[sym].m15;
          const last = arr.at(-1);
          if (last && last.time === candle.time) {
            arr[arr.length-1] = candle;
          } else {
            arr.push(candle);
            if (arr.length > 150) arr.shift();
          }
          buildCache();
        }
      } catch(e) {}
    });

    wsConnection.on('close', () => {
      wsConnected = false;
      console.log('WebSocket closed — reconnecting in 5s');
      setTimeout(connectWebSocket, 5000);
    });

    wsConnection.on('error', (e) => {
      console.error('WebSocket error:', e.message);
      wsConnected = false;
    });

  } catch(e) {
    console.error('WebSocket connect failed:', e.message, '— retry in 10s');
    setTimeout(connectWebSocket, 10000);
  }
}

// ── INITIAL LOAD ──────────────────────────────────────────────────
async function initialLoad() {
  console.log('Loading top coins by volume...');
  try {
    const r = await axios.get('https://api.kucoin.com/api/v1/market/allTickers', {timeout:10000});
    if (r.data.code !== '200000') throw new Error('Tickers failed');
    const exclude = ['USDT','USDC','BUSD','DAI','TUSD','3L','3S','2L','2S','UP','DOWN','BEAR','BULL'];
    activeSymbols = r.data.data.ticker
      .filter(t => t.symbol.endsWith('-USDT')
        && !exclude.some(e=>t.symbol.replace('-USDT','').includes(e))
        && parseFloat(t.volValue) > 5000000)
      .sort((a,b) => parseFloat(b.volValue)-parseFloat(a.volValue))
      .slice(0,40)
      .map(t => t.symbol.replace('-USDT',''));
    console.log(`Top coins: ${activeSymbols.slice(0,10).join(', ')} ...`);
  } catch(e) {
    console.error('Top coins failed:', e.message);
    activeSymbols = ['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT'];
  }

  let loaded=0;
  for (const sym of activeSymbols) {
    store[sym] = { tick:{}, m15:[], h1:[], h4:[] };
    try {
      store[sym].m15 = await loadCandles(sym,'15min',100);
      await sleep(150);
      store[sym].h1  = await loadCandles(sym,'1hour',100);
      await sleep(150);
      store[sym].h4  = await loadCandles(sym,'4hour',60);
      await sleep(150);
      loaded++;
    } catch(e) { /* skip failed */ }
  }
  console.log(`Candles loaded: ${loaded}/${activeSymbols.length}`);
  buildCache();

  await connectWebSocket();
}

// ── MARKET CACHE ──────────────────────────────────────────────────
let marketCache = [];
function buildCache() {
  marketCache = activeSymbols
    .map(sym => {
      const d = store[sym];
      if (!d || !d.m15 || d.m15.length < 20) return null;
      const tick = d.tick || {};
      const price = tick.price || d.m15.at(-1)?.close || 0;
      return {
        symbol:    sym,
        price:     parseFloat(price.toFixed(6)),
        change24h: tick.change24h || 0,
        volume24h: tick.volume24h || 0,
        bid:       tick.bid || price,
        ask:       tick.ask || price,
        liveAge:   tick.lastUpdated ? Math.round((Date.now()-tick.lastUpdated)/1000) : 999,
        m15: tfSnapshot(d.m15),
        h1:  tfSnapshot(d.h1),
        h4:  tfSnapshot(d.h4),
      };
    })
    .filter(Boolean)
    .sort((a,b) => (b.volume24h||0)-(a.volume24h||0));
}

// ── NEWS ──────────────────────────────────────────────────────────
let newsCache = { data:[], ts:0, sentiment:'NEUTRAL' };
async function fetchNews() {
  if (!NEWSDATA_KEY || Date.now()-newsCache.ts < 300000) return newsCache;
  try {
    const r = await axios.get('https://newsdata.io/api/1/news',{
      params:{apikey:NEWSDATA_KEY,q:'crypto bitcoin',language:'en',size:8},
      timeout:8000
    });
    const hl = (r.data.results||[]).map(a=>({title:a.title,time:a.pubDate,source:a.source_id}));
    const text = hl.map(h=>h.title.toLowerCase()).join(' ');
    const pos = ['surge','rally','bull','gain','bullish','ath','record'].filter(w=>text.includes(w)).length;
    const neg = ['crash','dump','fall','bear','bearish','ban','collapse'].filter(w=>text.includes(w)).length;
    newsCache = {data:hl, ts:Date.now(), sentiment:pos>neg+1?'BULLISH':neg>pos+1?'BEARISH':'NEUTRAL'};
  } catch(e) {}
  return newsCache;
}

function sleep(ms) { return new Promise(r=>setTimeout(r,ms)); }

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/api/data', (req,res) => {
  if (!marketCache.length) return res.status(503).json({ok:false,error:'Loading, retry in 20s'});
  res.json({ok:true, data:marketCache, ts:Date.now(), wsConnected});
});

app.get('/api/news', async (req,res) => {
  try { res.json({ok:true,...(await fetchNews())}); }
  catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Simple in-memory rate limit for analyze — max 1 call per 25s
let lastAnalyzeTime = 0;
app.post('/api/analyze', async (req,res) => {
  if (!CLAUDE_KEY) return res.status(500).json({ok:false,error:'CLAUDE_API_KEY not set'});
  const now = Date.now();
  if (now - lastAnalyzeTime < 25000)
    return res.status(429).json({ok:false,error:'Rate limit — wait a moment'});
  lastAnalyzeTime = now;
  try {
    const {prompt, model} = req.body;

    // Load agent's past memory to inject into system prompt
    // Extract symbol from prompt for targeted memory
    // Extract coin symbols from prompt matching known active symbols
    const knownSyms = activeSymbols.length ? activeSymbols : ['BTC','ETH','SOL','BNB','XRP'];
    const allMatches = req.body.prompt?.match(/\b([A-Z]{2,10})\b/g) || [];
    const promptSymbol = allMatches.find(s => knownSyms.includes(s)) || 'N/A';
    const memory = await loadMemory(promptSymbol);

    const r = await axios.post('https://api.anthropic.com/v1/messages',{
      model: model||'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:`You are NEXUS PRO, an expert autonomous crypto trader.
You receive LIVE multi-timeframe data (15m/1h/4h) streamed in real-time via WebSocket.
Make precise, high-conviction LONG or SHORT decisions. Return ONLY raw JSON. No markdown.
Your JSON must include these fields: symbol, signal, entry, tp, sl, confidence, reasoning.
${memory}`,
      messages:[{role:'user',content:prompt}]
    },{
      headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      timeout:30000
    });

    const text = r.data.content[0]?.text||'';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ok:false,error:'No JSON in response'});
    const parsed = JSON.parse(m[0]);

    // Save each signal from parsed.signals array to Turso
    if (process.env.TURSO_DATABASE_URL && Array.isArray(parsed.signals) && parsed.signals.length > 0) {
      for (const sig of parsed.signals) {
        const isValid = ['LONG','SHORT'].includes(sig.direction) && sig.symbol && sig.symbol !== 'N/A';
        if (!isValid) continue;
        try {
          // Convert signal fields — frontend uses direction/sl_pct/tp_pct
          const coin = marketCache.find(c => c.symbol === sig.symbol);
          const price = coin?.price || null;
          const slPrice  = price && sig.sl_pct  ? parseFloat((price * (sig.direction==='LONG' ? 1-sig.sl_pct/100 : 1+sig.sl_pct/100)).toFixed(6)) : null;
          const tpPrice  = price && sig.tp_pct  ? parseFloat((price * (sig.direction==='LONG' ? 1+sig.tp_pct/100 : 1-sig.tp_pct/100)).toFixed(6)) : null;
          await db.execute({
            sql: `INSERT INTO signals (symbol, signal, entry, tp, sl, confidence, reasoning)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [
              sig.symbol,
              sig.direction,
              price,
              tpPrice,
              slPrice,
              sig.confidence  || null,
              sig.reason      || null
            ]
          });
          console.log(`Signal saved: ${sig.symbol} ${sig.direction} conf=${sig.confidence}`);
        } catch(dbErr) {
          console.error('DB save error:', dbErr.message);
        }
      }
    }

    res.json({ok:true, result:parsed});
  } catch(e) {
    res.status(500).json({ok:false,error:e.response?.data?JSON.stringify(e.response.data).slice(0,200):e.message});
  }
});

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth', (req,res) => {
  const { password } = req.body;
  const correct = process.env.NEXUS_PASSWORD || 'nexus123';
  if (password !== correct)
    return res.status(401).json({ok:false, error:'Wrong password'});
  // Generate simple session token
  const token = crypto.randomBytes(32).toString('hex');
  SESSION_TOKENS.add(token);
  // Token expires after 24 hours
  setTimeout(() => SESSION_TOKENS.delete(token), 24 * 60 * 60 * 1000);
  res.json({ok:true, token});
});

app.get('/api/auth/verify', (req,res) => {
  const token = req.headers['x-nexus-token'];
  if (token && SESSION_TOKENS.has(token))
    return res.json({ok:true});
  res.status(401).json({ok:false});
});


// ── TRADING MODE ROUTES ───────────────────────────────────────────
app.get('/api/mode', (req,res) => {
  const keysOk = !!(process.env.KUCOIN_API_KEY && process.env.KUCOIN_API_SECRET && process.env.KUCOIN_PASSPHRASE);
  res.json({ ok:true, mode: tradingMode, keysConfigured: keysOk });
});

app.post('/api/mode', (req,res) => {
  const { mode } = req.body;
  if (!['paper','live'].includes(mode))
    return res.status(400).json({ok:false, error:'Mode must be paper or live'});
  if (mode === 'live') {
    const missing = ['KUCOIN_API_KEY','KUCOIN_API_SECRET','KUCOIN_PASSPHRASE'].filter(k=>!process.env[k]);
    if (missing.length)
      return res.status(400).json({ok:false, error:`Missing env vars: ${missing.join(', ')}`});
  }
  tradingMode = mode;
  console.log(`Trading mode switched to: ${mode}`);
  res.json({ ok:true, mode });
});

// ── REAL ORDER ROUTE ──────────────────────────────────────────────
app.post('/api/order', async (req,res) => {
  if (tradingMode !== 'live')
    return res.json({ok:false, error:'Not in live mode'});
  const missing = ['KUCOIN_API_KEY','KUCOIN_API_SECRET','KUCOIN_PASSPHRASE'].filter(k=>!process.env[k]);
  if (missing.length)
    return res.status(400).json({ok:false, error:`Missing KuCoin keys: ${missing.join(', ')}`});

  try {
    const { symbol, direction, sizeUsdt, sl, tp, qty } = req.body;
    const side = direction === 'LONG' ? 'buy' : 'sell';

    // Place market entry order
    const entryId = await placeMarketOrder(symbol, side, sizeUsdt);

    // Place SL stop order
    const slSide  = direction === 'LONG' ? 'sell' : 'buy';
    const slId    = await placeStopOrder(symbol, slSide, sl, qty);

    // Place TP limit order
    const tpId = await placeLimitOrder(symbol, slSide, tp, qty);

    console.log(`LIVE ORDER: ${direction} ${symbol} $${sizeUsdt} | Entry:${entryId} SL:${slId} TP:${tpId}`);
    res.json({ ok:true, entryId, slId, tpId });
  } catch(e) {
    console.error('Order error:', e.message);
    res.status(500).json({ok:false, error: e.message});
  }
});

// ── CLOSE ORDER ROUTE ─────────────────────────────────────────────
app.post('/api/order/close', async (req,res) => {
  if (tradingMode !== 'live')
    return res.json({ok:false, error:'Not in live mode'});
  try {
    const { symbol, direction, qty, slId, tpId } = req.body;
    // Cancel SL and TP orders first
    if (slId) await cancelKuOrder(slId).catch(()=>{});
    if (tpId) await cancelKuOrder(tpId).catch(()=>{});
    // Place market close order
    const closeSide = direction === 'LONG' ? 'sell' : 'buy';
    const curPrice = marketCache.find(c=>c.symbol===symbol)?.price || 1;
    const closeId = await placeMarketOrder(symbol, closeSide, qty*curPrice, qty);
    res.json({ ok:true, closeId });
  } catch(e) {
    res.status(500).json({ok:false, error: e.message});
  }
});

// ── HISTORY ROUTE ─────────────────────────────────────────────────
app.get('/api/history', async (req,res) => {
  if (!process.env.TURSO_DATABASE_URL)
    return res.json({ok:false, error:'Turso not configured'});
  try {
    const limit = parseInt(req.query.limit)||50;
    const rows = await db.execute({
      sql: `SELECT id, symbol, signal, entry, tp, sl, confidence, outcome, pnl_pct, reasoning, created_at
            FROM signals ORDER BY id DESC LIMIT ?`,
      args: [limit]
    });
    const total  = rows.rows.length;
    const wins   = rows.rows.filter(r=>r.outcome==='WIN').length;
    const losses = rows.rows.filter(r=>r.outcome==='LOSS').length;
    res.json({ok:true, data:rows.rows, stats:{total,wins,losses,winRate: total?(wins/total*100).toFixed(1)+'%':'N/A'}});
  } catch(e) {
    res.status(500).json({ok:false, error:e.message});
  }
});

app.get('/health', (req,res) => res.json({ok:true}));

app.get('/api/health', (req,res) => {
  res.json({
    ok:true, coins:marketCache.length, wsConnected,
    liveCoins: marketCache.filter(c=>c.liveAge<60).length,
    sample: marketCache.slice(0,3).map(c=>({sym:c.symbol,price:c.price,liveAge:c.liveAge+'s',m15:c.m15?.trend,h1:c.h1?.trend})),
    keys:{claude:!!CLAUDE_KEY,news:!!NEWSDATA_KEY,turso:!!process.env.TURSO_DATABASE_URL}
  });
});

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.use((err,req,res,next) => res.status(500).json({ok:false,error:String(err.message)}));

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`NEXUS PRO on port ${PORT}`);
  console.log(`Keys: Claude=${!!CLAUDE_KEY} News=${!!NEWSDATA_KEY} Turso=${!!process.env.TURSO_DATABASE_URL}`);
  await initDB();
  await initialLoad();

  // Evaluate pending signals every 5 min (faster outcome detection)
  setInterval(evaluatePendingSignals, 5 * 60 * 1000);

  // Full candle reload every 20min (offset from evaluator to avoid conflict)
  setInterval(async () => {
    await initialLoad();
  }, 20 * 60 * 1000);

  // Keep-alive
  const SELF = process.env.RENDER_EXTERNAL_URL||`http://localhost:${PORT}`;
  setInterval(()=>axios.get(`${SELF}/health`,{timeout:5000}).catch(()=>{}), 14*60*1000);
});
