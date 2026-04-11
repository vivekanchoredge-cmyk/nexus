const express = require('express');
const axios   = require('axios');
const WebSocket = require('ws');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const NEWSDATA_KEY = process.env.Newsdata        || '';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// ── LIVE DATA STORE ───────────────────────────────────────────────
// Per coin: live candles for 3 timeframes + latest tick
const store = {};
// store[sym] = {
//   tick: { price, change24h, volume24h, bid, ask, lastUpdated }
//   m15:  [ {time,open,high,low,close,vol}, ... ]  (100 candles)
//   h1:   [ ... ]
//   h4:   [ ... ]
// }

let activeSymbols = []; // top coins by volume
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

      // Subscribe to live ticker for all active coins
      const tickerTopics = activeSymbols.slice(0,20).map(s=>`${s}-USDT`).join(',');
      wsConnection.send(JSON.stringify({
        id: Date.now(), type:'subscribe',
        topic: `/market/ticker:${tickerTopics}`,
        privateChannel: false, response: true
      }));

      // Subscribe to 15m candles for top 10 coins
      activeSymbols.slice(0,10).forEach(sym => {
        wsConnection.send(JSON.stringify({
          id: Date.now()+Math.random(), type:'subscribe',
          topic: `/market/candles:${sym}-USDT_15min`,
          privateChannel: false, response: true
        }));
      });

      // Heartbeat every 20s
      setInterval(() => {
        if (wsConnected) wsConnection.send(JSON.stringify({id:Date.now(),type:'ping'}));
      }, 20000);
    });

    wsConnection.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'message') return;

        // Live ticker update
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
          // Update live candle
          if (store[sym].m15?.length > 0) {
            const last = store[sym].m15.at(-1);
            last.close = price;
            last.high  = Math.max(last.high, price);
            last.low   = Math.min(last.low, price);
          }
          buildCache();
        }

        // Live candle update
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
            // Update current candle
            arr[arr.length-1] = candle;
          } else {
            // New candle
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

  // Load historical candles for all 3 timeframes
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

  // Connect WebSocket for live updates
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

app.post('/api/analyze', async (req,res) => {
  if (!CLAUDE_KEY) return res.status(500).json({ok:false,error:'CLAUDE_API_KEY not set'});
  try {
    const {prompt, model} = req.body;
    const r = await axios.post('https://api.anthropic.com/v1/messages',{
      model: model||'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system:`You are NEXUS PRO, an expert autonomous crypto trader.
You receive LIVE multi-timeframe data (15m/1h/4h) streamed in real-time via WebSocket.
Make precise, high-conviction LONG or SHORT decisions. Return ONLY raw JSON. No markdown.`,
      messages:[{role:'user',content:prompt}]
    },{
      headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      timeout:30000
    });
    const text = r.data.content[0]?.text||'';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return res.status(500).json({ok:false,error:'No JSON in response'});
    res.json({ok:true,result:JSON.parse(m[0])});
  } catch(e) {
    res.status(500).json({ok:false,error:e.response?.data?JSON.stringify(e.response.data).slice(0,200):e.message});
  }
});

app.get('/api/health', (req,res) => {
  res.json({
    ok:true, coins:marketCache.length, wsConnected,
    liveCoins: marketCache.filter(c=>c.liveAge<60).length,
    sample: marketCache.slice(0,3).map(c=>({sym:c.symbol,price:c.price,liveAge:c.liveAge+'s',m15:c.m15?.trend,h1:c.h1?.trend})),
    keys:{claude:!!CLAUDE_KEY,news:!!NEWSDATA_KEY}
  });
});

app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.use((err,req,res,next) => res.status(500).json({ok:false,error:String(err.message)}));

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`NEXUS PRO on port ${PORT}`);
  console.log(`Keys: Claude=${!!CLAUDE_KEY} News=${!!NEWSDATA_KEY}`);
  await initialLoad();
  // Full reload every 15min (refresh historical candles)
  setInterval(initialLoad, 15*60*1000);
  // Keep-alive
  const SELF = process.env.RENDER_EXTERNAL_URL||`http://localhost:${PORT}`;
  setInterval(()=>axios.get(`${SELF}/api/health`,{timeout:5000}).catch(()=>{}), 14*60*1000);
});
