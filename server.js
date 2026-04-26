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
  // NEW: active_trades table — survives page refresh / server restart
  // Stores the full trade state so UI can recover from localStorage loss
  await db.execute(`
    CREATE TABLE IF NOT EXISTS active_trades (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      signal_id     INTEGER,
      symbol        TEXT NOT NULL,
      direction     TEXT NOT NULL,
      entry_price   REAL NOT NULL,
      tp_price      REAL,
      sl_price      REAL,
      sl_pct        REAL,
      tp_pct        REAL,
      confidence    REAL,
      size_usdt     REAL,
      reasoning     TEXT,
      status        TEXT DEFAULT 'OPEN',
      kucoin_entry_id TEXT,
      kucoin_sl_id    TEXT,
      kucoin_tp_id    TEXT,
      opened_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      closed_at     DATETIME,
      close_reason  TEXT,
      close_price   REAL,
      pnl_pct       REAL
    )
  `);
  // Index for fast queries on open trades
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_active_trades_status ON active_trades(status)`);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_active_trades_symbol ON active_trades(symbol)`);
  // Add trailing + tp1_hit columns if missing (migration for existing DBs)
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN trailing INTEGER DEFAULT 0`); } catch(e){}
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN trade_type TEXT DEFAULT 'spot'`); } catch(e){}
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN leverage INTEGER DEFAULT 1`); } catch(e){}
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN exchange TEXT DEFAULT 'kucoin'`); } catch(e){}
  // signals table — add trade_type for agent learning
  try { await db.execute(`ALTER TABLE signals ADD COLUMN trade_type TEXT DEFAULT 'spot'`); } catch(e){}
  try { await db.execute(`ALTER TABLE signals ADD COLUMN exchange TEXT DEFAULT 'kucoin'`); } catch(e){}
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN last_ai_check INTEGER DEFAULT 0`); } catch(e){}
  try { await db.execute(`ALTER TABLE active_trades ADD COLUMN tp1_hit INTEGER DEFAULT 0`); } catch(e){}
  // Delete PENDING signals older than 2h with no corresponding open trade
  // These are signals Claude generated but frontend never acted on
  await db.execute(`
    DELETE FROM signals
    WHERE outcome = 'PENDING'
      AND created_at < datetime('now', '-30 minutes')
      AND id NOT IN (
        SELECT DISTINCT signal_id FROM active_trades
        WHERE status = 'OPEN' AND signal_id IS NOT NULL
      )
  `);
  // Mark very old PENDING signals (>24h) as EXPIRED
  await db.execute(`
    UPDATE signals
    SET outcome = 'EXPIRED', evaluated_at = CURRENT_TIMESTAMP
    WHERE outcome = 'PENDING'
      AND created_at < datetime('now', '-24 hours')
  `);
  console.log('Turso DB ready (signals + active_trades)');
}

// ── MEMORY ───────────────────────────────────────────────────────
async function loadMemory(symbol) {
  if (!process.env.TURSO_DATABASE_URL) return '';
  try {
    // FIXED: Only load signals that have REAL outcomes with valid PnL data
    // NULL pnl_pct or NULL exit_price rows are excluded — they teach the agent nothing useful
    const symRows = await db.execute({
      sql: `SELECT symbol,signal,entry,tp,sl,confidence,outcome,pnl_pct,reasoning,created_at
            FROM signals
            WHERE outcome IN ('WIN','LOSS')
              AND symbol=?
              AND pnl_pct IS NOT NULL
            ORDER BY id DESC LIMIT 200`,
      args: [symbol||'N/A']
    });
    const allRows = await db.execute({
      sql: `SELECT symbol,signal,confidence,outcome,pnl_pct
            FROM signals
            WHERE outcome IN ('WIN','LOSS')
              AND pnl_pct IS NOT NULL
            ORDER BY id DESC LIMIT 500`,
      args: []
    });
    const statsRows = await db.execute({
      sql: `SELECT symbol,COUNT(*) as total,
              SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
              ROUND(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END),2) as avg_pnl,
              SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses
            FROM signals
            WHERE outcome IN ('WIN','LOSS')
              AND pnl_pct IS NOT NULL
              AND ABS(pnl_pct) < 50
            GROUP BY symbol
            HAVING total >= 2
            ORDER BY total DESC LIMIT 30`,
      args: []
    });
    if (!allRows.rows.length) return '';

    const symHistory = symRows.rows;
    let streak=0, streakType='';
    if(symHistory.length>0){
      const last=symHistory[0].outcome; streakType=last;
      for(const r of symHistory){ if(r.outcome===last) streak++; else break; }
    }
    const streakStr = streak>1 ? `\n⚡ STREAK: ${streak} consecutive ${streakType}s on ${symbol}` : '';

    const symLines = symRows.rows.map(r=>{
      const pnl = r.pnl_pct!=null?`PnL=${r.pnl_pct}%`:'';
      return `  [${r.created_at}] ${r.symbol} ${r.signal} entry=${r.entry} conf=${r.confidence}% => ${r.outcome} ${pnl}`;
    }).join('\n');

    // Add trade_type performance breakdown
    let typeStats = '';
    try {
      const typeRows = await db.execute({
        sql: `SELECT trade_type, COUNT(*) as total,
                SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
                ROUND(AVG(pnl_pct),2) as avg_pnl
              FROM signals
              WHERE outcome IN ('WIN','LOSS') AND pnl_pct IS NOT NULL
              GROUP BY trade_type`,
        args: []
      });
      if(typeRows.rows.length > 0) {
        typeStats = '\n4. TRADE TYPE PERFORMANCE:\n' + typeRows.rows.map(r=>{
          const wr = r.total>0 ? ((r.wins/r.total)*100).toFixed(0) : '?';
          return `  ${r.trade_type?.toUpperCase()||'SPOT'}: ${r.wins}W/${r.total-r.wins}L wr=${wr}% avg=${r.avg_pnl}%`;
        }).join('\n');
      }
    } catch(e) {}

    const statsLines = statsRows.rows.map(r=>{
      const wr = r.total>0 ? ((r.wins/r.total)*100).toFixed(0) : '?';
      const flag = parseFloat(wr)<40 ? '⚠️SKIP' : parseFloat(wr)>65 ? '✅GOOD' : '';
      return `  ${r.symbol}: ${r.wins}W/${r.losses}L/${r.total}T wr=${wr}% avg_pnl=${r.avg_pnl}% ${flag}`;
    }).join('\n');

    // Count PENDING signals — agent should know how many open trades exist
    const pendingCount = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM signals WHERE outcome='PENDING'`,
      args: []
    });
    const openTrades = pendingCount.rows[0]?.cnt || 0;

    return `\n\nYOUR MEMORY (only verified WIN/LOSS data — no NULL/PENDING noise):\n1. ${symbol} HISTORY (last 200):${streakStr}\n${symLines||'  No history yet'}\n2. SYMBOL WIN RATES (min 2 trades):\n${statsLines||'  No completed trades yet'}\n3. OPEN PENDING TRADES: ${openTrades}${typeStats}\nRULES: <40% winrate=SKIP symbol | same losing pattern=SKIP | 2+ consecutive losses=REDUCE SIZE | >65% winrate=+0.5 conf bonus | futures wr<50%=prefer spot`;
  } catch(e) {
    console.error('loadMemory error:', e.message);
    return '';
  }
}

// ── AUTO-EVALUATOR ────────────────────────────────────────────────
async function evaluatePendingSignals() {
  if (!process.env.TURSO_DATABASE_URL) return;
  try {
    // FIXED: Only evaluate signals with valid entry,tp,sl — NULL entry signals are garbage data
    const rows = await db.execute({
      sql: `SELECT id,symbol,signal,entry,tp,sl,created_at FROM signals
            WHERE outcome='PENDING'
              AND entry IS NOT NULL
              AND tp IS NOT NULL
              AND sl IS NOT NULL`,
      args: []
    });
    if (!rows.rows.length) return;
    for (const row of rows.rows) {
      const coin = marketCache.find(c=>c.symbol===row.symbol);
      if (!coin) continue;
      const price=coin.price, isLong=row.signal==='LONG', isShort=row.signal==='SHORT';
      let outcome=null, exitPrice=price;
      if(isLong){
        if(price>=row.tp){outcome='WIN';exitPrice=row.tp;}
        else if(price<=row.sl){outcome='LOSS';exitPrice=row.sl;}
      } else if(isShort){
        if(price<=row.tp){outcome='WIN';exitPrice=row.tp;}
        else if(price>=row.sl){outcome='LOSS';exitPrice=row.sl;}
      }
      // Don't mark as EXPIRED — no learning value
      // Old PENDING signals get cleaned up by auto-cleanup after 30 min
      if(outcome){
        const pnlPct=(row.entry&&row.entry>0)
          ? parseFloat((((exitPrice-row.entry)/row.entry)*100*(isShort?-1:1)).toFixed(2)) : null;
        const validPnl=(pnlPct!==null&&Math.abs(pnlPct)<50)?pnlPct:null;
        await db.execute({
          sql:`UPDATE signals SET outcome=?,exit_price=?,pnl_pct=?,evaluated_at=CURRENT_TIMESTAMP WHERE id=?`,
          args:[outcome,exitPrice,validPnl,row.id]
        });
        console.log(`Signal #${row.id} ${row.symbol} ${row.signal} => ${outcome} PnL=${pnlPct}%`);
      }
    }
  } catch(e) { console.error('evaluatePendingSignals error:',e.message); }
}

// ── TRADING MODE ──────────────────────────────────────────────────
let tradingMode = process.env.TRADING_MODE || 'paper';

// ═══════════════════════════════════════════════════════════════
// RISK MANAGEMENT
// ═══════════════════════════════════════════════════════════════
let riskConfig = {
  dailyLossLimit: -50,      // $ loss limit per day
  maxOpenPositions: 5,      // max concurrent trades
  maxDrawdown: -10,         // % portfolio drawdown limit
  atrSLMultiplier: 2.0,     // ATR × this = SL distance
  enabled: true
};

// ═══════════════════════════════════════════════════════════════
// KELLY CRITERION — optimal position sizing
// ═══════════════════════════════════════════════════════════════
let kellyConfig = {
  enabled: true,
  minPct: 0.5,   // minimum bet % of capital
  maxPct: 5.0,   // maximum bet % of capital
  fraction: 0.5  // half-kelly (safer)
};

async function calcKellySize(baseCapital, regime='SIDEWAYS') {
  if(!kellyConfig.enabled || !process.env.TURSO_DATABASE_URL) return null;
  try {
    const rows = await db.execute({
      sql:`SELECT pnl_pct, outcome FROM signals WHERE outcome IN ('WIN','LOSS') AND pnl_pct IS NOT NULL ORDER BY id DESC LIMIT 50`,
      args:[]
    });
    if(rows.rows.length < 10) return null; // need min 10 trades
    const wins   = rows.rows.filter(r=>r.outcome==='WIN');
    const losses = rows.rows.filter(r=>r.outcome==='LOSS');
    if(!wins.length || !losses.length) return null;
    const wr     = wins.length / rows.rows.length;
    const avgWin  = wins.reduce((s,r)=>s+Math.abs(r.pnl_pct),0) / wins.length;
    const avgLoss = losses.reduce((s,r)=>s+Math.abs(r.pnl_pct),0) / losses.length;
    if(!avgLoss) return null;
    // Kelly formula: f = WR - (1-WR)/(avgWin/avgLoss)
    const kelly = wr - (1-wr) / (avgWin/avgLoss);
    const halfKelly = kelly * kellyConfig.fraction;
    let pct = Math.max(kellyConfig.minPct, Math.min(kellyConfig.maxPct, halfKelly * 100));
    // Regime multiplier: BULL=1.2x, SIDEWAYS=1.0x, BEAR=0.5x
    const regimeMult = regime==='BULL' ? 1.2 : regime==='BEAR' ? 0.5 : 1.0;
    pct = Math.max(kellyConfig.minPct, Math.min(kellyConfig.maxPct, pct * regimeMult));
    const sizeUsdt = parseFloat((baseCapital * pct / 100).toFixed(2));
    console.log(`[KELLY] Regime=${regime}(${regimeMult}x) WR=${(wr*100).toFixed(1)}% → ${pct.toFixed(2)}% = $${sizeUsdt}`);
    return { pct: parseFloat(pct.toFixed(2)), sizeUsdt };
  } catch(e) { console.error('[KELLY] Error:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════
// VOLATILITY FILTER — skip bad market conditions
// ═══════════════════════════════════════════════════════════════
let volFilterConfig = {
  enabled: true,
  minATR: 0.4,    // skip if ATR% < 0.4 (dead market)
  maxATR: 7.0,    // skip if ATR% > 7.0 (too dangerous)
  minBBWidth: 0.8,// skip if Bollinger squeeze < 0.8%
  minVolRatio: 0.4 // skip if volume ratio < 0.4
};

function passVolatilityFilter(coin) {
  if(!volFilterConfig.enabled) return {pass:true};
  const m15 = coin.m15;
  if(!m15) return {pass:true};
  const atr = m15.atr || 0;
  const bbw = m15.bb?.bwidth || 99;
  const vr  = m15.volRatio || 1;
  if(atr < volFilterConfig.minATR) return {pass:false, reason:`ATR too low (${atr}% < ${volFilterConfig.minATR}%)`};
  if(atr > volFilterConfig.maxATR) return {pass:false, reason:`ATR too high (${atr}% > ${volFilterConfig.maxATR}%)`};
  if(bbw < volFilterConfig.minBBWidth) return {pass:false, reason:`BB squeeze (${bbw}% < ${volFilterConfig.minBBWidth}%)`};
  if(vr < volFilterConfig.minVolRatio) return {pass:false, reason:`Low volume ratio (${vr}x < ${volFilterConfig.minVolRatio}x)`};
  return {pass:true};
}

let dailyStats = {
  startTime: Date.now(),
  closedPnL: [],
  dailyPnL: 0,
  highestEquity: 100,
  lowestEquity: 100
};

function resetDailyStats(){
  const now = new Date();
  const timeToMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 0).getTime() - now.getTime();
  setTimeout(()=>{
    dailyStats = {startTime:Date.now(), closedPnL:[], dailyPnL:0, highestEquity:100, lowestEquity:100};
    console.log('[RISK] Daily stats reset');
    resetDailyStats(); // recursive
  }, timeToMidnight);
}
const SESSION_TOKENS = new Set();

// ── KUCOIN ORDER EXECUTION ────────────────────────────────────────
function kuSign(secret,ts,method,endpoint,body=''){
  return crypto.createHmac('sha256',secret).update(ts+method.toUpperCase()+endpoint+body).digest('base64');
}
function kuHeaders(method,endpoint,body=''){
  const key=process.env.KUCOIN_API_KEY||'',secret=process.env.KUCOIN_API_SECRET||'',
        passphrase=process.env.KUCOIN_PASSPHRASE||'',ts=Date.now().toString();
  return {
    'KC-API-KEY':key,
    'KC-API-SIGN':kuSign(secret,ts,method,endpoint,body),
    'KC-API-TIMESTAMP':ts,
    'KC-API-PASSPHRASE':crypto.createHmac('sha256',secret).update(passphrase).digest('base64'),
    'KC-API-KEY-VERSION':'2',
    'Content-Type':'application/json'
  };
}
async function placeMarketOrder(symbol,side,sizeUsdt,coinQty=null){
  const endpoint='/api/v1/orders';
  const sizeField=side==='buy'?{funds:parseFloat(sizeUsdt).toFixed(2)}:{size:(coinQty||(sizeUsdt/(marketCache.find(c=>c.symbol===symbol)?.price||1))).toFixed(6)};
  const body=JSON.stringify({clientOid:`nexus_${Date.now()}`,side,symbol:`${symbol}-USDT`,type:'market',...sizeField});
  const r=await axios.post(`https://api.kucoin.com${endpoint}`,body,{headers:kuHeaders('POST',endpoint,body),timeout:10000});
  if(r.data.code!=='200000') throw new Error(`KuCoin order failed: ${r.data.msg}`);
  return r.data.data.orderId;
}
async function placeStopOrder(symbol,side,stopPrice,size){
  const endpoint='/api/v1/stop-order';
  const body=JSON.stringify({clientOid:`nexus_sl_${Date.now()}`,side,symbol:`${symbol}-USDT`,type:'market',stop:side==='sell'?'loss':'entry',stopPrice:stopPrice.toFixed(8),size:size.toFixed(6)});
  const r=await axios.post(`https://api.kucoin.com${endpoint}`,body,{headers:kuHeaders('POST',endpoint,body),timeout:10000});
  if(r.data.code!=='200000') throw new Error(`KuCoin stop failed: ${r.data.msg}`);
  return r.data.data.orderId;
}
async function placeLimitOrder(symbol,side,price,size){
  const endpoint='/api/v1/orders';
  const body=JSON.stringify({clientOid:`nexus_tp_${Date.now()}`,side,symbol:`${symbol}-USDT`,type:'limit',price:price.toFixed(8),size:size.toFixed(6)});
  const r=await axios.post(`https://api.kucoin.com${endpoint}`,body,{headers:kuHeaders('POST',endpoint,body),timeout:10000});
  if(r.data.code!=='200000') throw new Error(`KuCoin limit failed: ${r.data.msg}`);
  return r.data.data.orderId;
}
async function cancelKuOrder(orderId){
  const endpoint=`/api/v1/orders/${orderId}`;
  const r=await axios.delete(`https://api.kucoin.com${endpoint}`,{headers:kuHeaders('DELETE',endpoint),timeout:10000});
  return r.data;
}

// ── BINGX API ─────────────────────────────────────────────────────
function bxSign(params) {
  const qs = Object.keys(params).sort().map(k=>k+'='+params[k]).join('&');
  return { qs, sig: crypto.createHmac('sha256', BINGX_SECRET).update(qs).digest('hex') };
}
async function bxRequest(method, path, params={}) {
  params.timestamp = Date.now();
  const { qs, sig } = bxSign(params);
  const url = `https://open-api.bingx.com${path}?${qs}&signature=${sig}`;
  const r = await axios({ method, url, headers:{ 'X-BX-APIKEY': BINGX_API_KEY }, timeout:10000 });
  if(String(r.data.code) !== '0') throw new Error(`BingX error: ${r.data.msg}`);
  return r.data.data;
}
async function bxPlaceOrder(symbol, side, sizeUsdt, qty=null) {
  // BingX spot market order
  const params = {
    symbol: symbol+'-USDT',
    side: side.toUpperCase(), // BUY or SELL
    type: 'MARKET',
    quoteOrderQty: qty ? undefined : parseFloat(sizeUsdt).toFixed(2),
    quantity: qty ? parseFloat(qty).toFixed(6) : undefined
  };
  if(!params.quantity) delete params.quantity;
  if(!params.quoteOrderQty) delete params.quoteOrderQty;
  return await bxRequest('POST', '/openApi/spot/v1/trade/order', params);
}
async function bxCancelOrder(symbol, orderId) {
  return await bxRequest('POST', '/openApi/spot/v1/trade/cancel', { symbol: symbol+'-USDT', orderId });
}
// Fetch BingX top coins by volume
async function fetchBingXTickers() {
  const r = await axios.get('https://open-api.bingx.com/openApi/spot/v1/ticker/24hr', {
    params: { timestamp: Date.now() },
    timeout: 10000
  });
  // BingX returns code as string "0" for success
  if(String(r.data.code) !== '0') throw new Error('BingX API error: ' + r.data.msg);
  return r.data.data || [];
}

// ── BingX FUTURES (Perpetual) ─────────────────────────────────────
async function bxFuturesRequest(method, path, params={}) {
  params.timestamp = Date.now();
  const { qs, sig } = bxSign(params);
  const url = `https://open-api.bingx.com${path}?${qs}&signature=${sig}`;
  const r = await axios({ method, url, headers:{'X-BX-APIKEY': BINGX_API_KEY}, timeout:10000 });
  if(String(r.data.code) !== '0') throw new Error(`BingX futures error: ${r.data.msg}`);
  return r.data.data;
}
async function bxFuturesOrder(symbol, side, sizeUsdt, leverage=5) {
  // Set leverage first
  await bxFuturesRequest('POST', '/openApi/swap/v2/trade/leverage', {
    symbol: symbol+'-USDT', side: side==='BUY'?'Long':'Short', leverage: leverage.toString()
  }).catch(()=>{}); // ignore if already set
  // Place market order
  const price = marketCache.find(c=>c.symbol===symbol)?.price || 1;
  const qty = parseFloat((sizeUsdt * leverage / price).toFixed(6));
  return await bxFuturesRequest('POST', '/openApi/swap/v2/trade/order', {
    symbol: symbol+'-USDT',
    side: side, // BUY or SELL
    positionSide: side==='BUY' ? 'LONG' : 'SHORT',
    type: 'MARKET',
    quantity: qty.toString()
  });
}
async function bxFuturesClose(symbol, direction, qty) {
  const side = direction==='LONG' ? 'SELL' : 'BUY';
  return await bxFuturesRequest('POST', '/openApi/swap/v2/trade/order', {
    symbol: symbol+'-USDT',
    side, positionSide: direction,
    type: 'MARKET',
    quantity: parseFloat(qty).toFixed(6),
    reduceOnly: 'true'
  });
}
// KuCoin Futures (Spot leverage via margin - simplified)
async function kuFuturesOrder(symbol, side, sizeUsdt, leverage=5) {
  // KuCoin margin order for futures-like behavior
  const endpoint = '/api/v1/margin/order';
  const body = JSON.stringify({
    clientOid: `nexus_f_${Date.now()}`,
    side, symbol: `${symbol}-USDT`, type: 'market',
    marginModel: 'cross',
    autoBorrow: true,
    funds: parseFloat(sizeUsdt).toFixed(2)
  });
  const r = await axios.post(`https://api.kucoin.com${endpoint}`, body, {
    headers: kuHeaders('POST', endpoint, body), timeout:10000
  });
  if(r.data.code !== '200000') throw new Error(`KuCoin futures failed: ${r.data.msg}`);
  return r.data.data.orderId;
}

// ── DECIDE TRADE TYPE ─────────────────────────────────────────────
// Futures when: high volatility (volRatio>1.5 OR atr>2%) + major coin
const FUTURES_MAJOR = ['BTC','ETH','SOL','BNB','XRP','ADA','AVAX','DOGE','LINK','DOT','MATIC','UNI','ATOM','LTC','BCH'];
function decideTradeType(coin) {
  if(!coin) return { type:'spot', leverage:1 };
  const atrPct = coin.m15?.atr?.pct || coin.m15?.atr || 0;
  const vr = coin.m15?.volRatio || 1;
  const isMajor = FUTURES_MAJOR.includes(coin.symbol);
  // Futures: major coin + high volatility — 5x leverage
  if(isMajor && (vr > 1.5 || atrPct > 2)) return { type:'futures', leverage:5 };
  // Futures: any coin with very high volatility spike — 5x leverage
  if(vr > 2.0 && atrPct > 2.5) return { type:'futures', leverage:5 };
  return { type:'spot', leverage:1 };
}

// Remove listener limit — libsql/turso + axios create many listeners normally
require('events').EventEmitter.defaultMaxListeners = 0;
process.setMaxListeners(0);

// ── TELEGRAM NOTIFICATIONS ────────────────────────────────────────
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID   || '';
async function sendTelegram(msg) {
  if(!TG_TOKEN || !TG_CHAT) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT, text: msg, parse_mode: 'HTML'
    }, { timeout: 5000 });
  } catch(e) { console.log('[TG] Failed:', e.message); }
}
const https = require('https');
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
axios.defaults.httpsAgent = httpsAgent;
const app  = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_KEY    = process.env.CLAUDE_API_KEY   || '';
const NEWSDATA_KEY  = process.env.Newsdata           || '';
const BINGX_API_KEY = process.env.BINGX_API_KEY      || '';
const BINGX_SECRET  = process.env.BINGX_API_SECRET   || '';

app.use(express.json({limit:'10mb'}));
app.use(express.static(path.join(__dirname)));

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────
function requireAuth(req,res,next){
  if(req.path==='/api/auth'||req.path==='/api/auth/verify') return next();
  if(!req.path.startsWith('/api')) return next();
  const token=req.headers['x-nexus-token'];
  if(token&&SESSION_TOKENS.has(token)) return next();
  return res.status(401).json({ok:false,error:'Unauthorized — please login'});
}
app.use(requireAuth);

// ── LIVE DATA STORE ───────────────────────────────────────────────
const store={};
let activeSymbols=[], wsConnection=null, wsConnected=false;

// ── INDICATORS ────────────────────────────────────────────────────
function ema(arr,n){
  if(!arr||arr.length<n) return arr?.at(-1)||0;
  const k=2/(n+1); let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<arr.length;i++) e=arr[i]*k+e*(1-k);
  return e;
}
function rsi(closes,n=14){
  // Wilder's Smoothed RSI — matches TradingView exactly
  // Bug was: original used simple avg of last n candles only (Cutler's RSI), not standard
  if(!closes||closes.length<n+1) return 50;
  let avgG=0,avgL=0;
  for(let i=1;i<=n;i++){const d=closes[i]-closes[i-1];if(d>0)avgG+=d;else avgL-=d;}
  avgG/=n; avgL/=n;
  for(let i=n+1;i<closes.length;i++){
    const d=closes[i]-closes[i-1];
    avgG=(avgG*(n-1)+(d>0?d:0))/n;
    avgL=(avgL*(n-1)+(d<0?-d:0))/n;
  }
  if(avgL===0) return 100;
  return parseFloat((100-100/(1+avgG/avgL)).toFixed(1));
}
function macd(closes){
  // BUG WAS: closes.slice(-35) gave only ~10 MACD values for signal EMA — signal line was garbage
  // FIX: proper iterative O(n) — EMA12, EMA26, then signal EMA9 of full MACD series
  if(!closes||closes.length<35) return {macd:0,signal:0,hist:0,crossUp:false,crossDn:false};
  const k12=2/13,k26=2/27,k9=2/10;
  let e12=closes.slice(0,12).reduce((a,b)=>a+b,0)/12;
  let e26=closes.slice(0,26).reduce((a,b)=>a+b,0)/26;
  // Advance e12 to candle 25 (sync with e26 start)
  for(let i=12;i<26;i++) e12=closes[i]*k12+e12*(1-k12);
  // Collect first 9 MACD values to SMA-seed the signal line
  const seed=[];
  for(let i=26;i<Math.min(35,closes.length);i++){
    e12=closes[i]*k12+e12*(1-k12);
    e26=closes[i]*k26+e26*(1-k26);
    seed.push(e12-e26);
  }
  if(seed.length<9) return {macd:seed.at(-1)||0,signal:seed.at(-1)||0,hist:0,crossUp:false,crossDn:false};
  let macdVal=seed.at(-1), sigVal=seed.reduce((a,b)=>a+b,0)/9;
  let prevMacd=macdVal, prevSig=sigVal;
  for(let i=35;i<closes.length;i++){
    prevMacd=macdVal; prevSig=sigVal;
    e12=closes[i]*k12+e12*(1-k12);
    e26=closes[i]*k26+e26*(1-k26);
    macdVal=e12-e26;
    sigVal=macdVal*k9+sigVal*(1-k9);
  }
  return {
    macd:parseFloat(macdVal.toFixed(6)),
    signal:parseFloat(sigVal.toFixed(6)),
    hist:parseFloat((macdVal-sigVal).toFixed(6)),
    crossUp:prevMacd<prevSig&&macdVal>=sigVal,  // Golden cross this candle
    crossDn:prevMacd>prevSig&&macdVal<=sigVal,  // Death cross this candle
  };
}
function bollingerBands(closes,n=20,mult=2){
  if(!closes||closes.length<n) return {upper:0,mid:0,lower:0,bwidth:0};
  const slice=closes.slice(-n);
  const mid=slice.reduce((a,b)=>a+b,0)/n;
  const std=Math.sqrt(slice.reduce((s,v)=>s+(v-mid)**2,0)/n);
  const upper=mid+mult*std, lower=mid-mult*std;
  return {
    upper:parseFloat(upper.toFixed(6)),
    mid:parseFloat(mid.toFixed(6)),
    lower:parseFloat(lower.toFixed(6)),
    bwidth:parseFloat(((upper-lower)/mid*100).toFixed(2))
  };
}
function stochRsi(closes,n=14,smoothK=3,smoothD=3){
  // BUG WAS: kArr was a weird nested-stoch of RSI values, not standard SMA smoothing
  // FIX: Standard TradingView StochRSI — rawStoch → SMA(smoothK) = K → SMA(smoothD) = D
  const minLen=n*2+smoothK+smoothD;
  if(!closes||closes.length<minLen) return {k:50,d:50,crossUp:false,crossDn:false};
  // Build RSI array
  const rsiArr=[];
  for(let i=n;i<closes.length;i++) rsiArr.push(rsi(closes.slice(0,i+1),n));
  if(rsiArr.length<n+smoothK+smoothD) return {k:50,d:50,crossUp:false,crossDn:false};
  // Build raw stochastic RSI
  const rawArr=[];
  for(let i=n-1;i<rsiArr.length;i++){
    const win=rsiArr.slice(i-n+1,i+1);
    const mn=Math.min(...win),mx=Math.max(...win);
    rawArr.push(mx===mn?50:((rsiArr[i]-mn)/(mx-mn))*100);
  }
  if(rawArr.length<smoothK+smoothD) return {k:50,d:50,crossUp:false,crossDn:false};
  // K = SMA(rawArr, smoothK)
  const kArr=[];
  for(let i=smoothK-1;i<rawArr.length;i++){
    const sl=rawArr.slice(i-smoothK+1,i+1);
    kArr.push(sl.reduce((a,b)=>a+b,0)/smoothK);
  }
  if(kArr.length<smoothD) return {k:50,d:50,crossUp:false,crossDn:false};
  // D = SMA(K, smoothD)
  const dSlice=kArr.slice(-smoothD);
  const d=dSlice.reduce((a,b)=>a+b,0)/smoothD;
  const k=kArr.at(-1);
  const prevK=kArr.at(-2)||k;
  const prevD=kArr.length>=smoothD+1?(kArr.slice(-smoothD-1,-1).reduce((a,b)=>a+b,0)/smoothD):d;
  return {
    k:parseFloat(k.toFixed(1)),
    d:parseFloat(d.toFixed(1)),
    crossUp:prevK<prevD&&k>=d&&k<80,  // K crossed above D (not overbought)
    crossDn:prevK>prevD&&k<=d&&k>20,  // K crossed below D (not oversold)
  };
}
function atr(highs,lows,closes,n=14){
  // Now returns {pct, abs} — abs useful for precise SL/TP calculation
  if(!closes||closes.length<n+1) return {pct:1,abs:0};
  let sum=0;
  for(let i=closes.length-n;i<closes.length;i++){
    const prev=closes[i-1]||closes[i];
    sum+=Math.max(highs[i]-lows[i],Math.abs(highs[i]-prev),Math.abs(lows[i]-prev));
  }
  const absATR=sum/n;
  return {pct:parseFloat((absATR/closes.at(-1)*100).toFixed(2)),abs:parseFloat(absATR.toFixed(6))};
}
function trend(closes){
  if(!closes||closes.length<55) return 'SIDE';
  const e9=ema(closes,9),e21=ema(closes,21),e50=ema(closes,50);
  if(e9>e21&&e21>e50) return 'UP';
  if(e9<e21&&e21<e50) return 'DOWN';
  return 'SIDE';
}
function mom(closes,n=10){
  if(!closes||closes.length<n+2) return 0;
  return parseFloat(((closes.at(-1)-closes.at(-n-1))/closes.at(-n-1)*100).toFixed(2));
}
function volRatio(vols){
  if(!vols||vols.length<5) return 1;
  const avg=vols.slice(-20).reduce((a,b)=>a+b,0)/Math.min(vols.length,20);
  return avg>0?parseFloat((vols.at(-1)/avg).toFixed(2)):1;
}
// NEW: On-Balance Volume direction (last 5 candles net flow)
function obv(closes,vols){
  if(!closes||closes.length<5) return 0;
  let net=0;
  const start=Math.max(1,closes.length-5);
  for(let i=start;i<closes.length;i++){
    if(closes[i]>closes[i-1]) net+=vols[i];
    else if(closes[i]<closes[i-1]) net-=vols[i];
  }
  return net>0?1:net<0?-1:0;
}
// NEW: Williams %R — overbought/oversold confirmation
function williamsR(highs,lows,closes,n=14){
  if(!closes||closes.length<n) return -50;
  const hs=highs.slice(-n),ls=lows.slice(-n);
  const hh=Math.max(...hs),ll=Math.min(...ls);
  if(hh===ll) return -50;
  return parseFloat(((hh-closes.at(-1))/(hh-ll)*-100).toFixed(1));
}
// ── SUPERTREND (ATR multiplier=3, period=10) ─────────────────────
// Returns: 'UP' (bullish), 'DOWN' (bearish)
// Widely used algo indicator — flips on ATR-based trend change
function supertrend(candles, period=10, mult=3){
  if(!candles||candles.length<period+2) return {trend:'SIDE',value:0};
  const highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low);
  const closes=candles.map(c=>c.close);
  // ATR using simple method for supertrend
  const atrArr=[];
  for(let i=1;i<closes.length;i++){
    const tr=Math.max(highs[i]-lows[i],Math.abs(highs[i]-closes[i-1]),Math.abs(lows[i]-closes[i-1]));
    atrArr.push(tr);
  }
  // Smooth ATR with RMA (Wilder's)
  const rmaArr=[];
  let rma=atrArr.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for(let i=period;i<atrArr.length;i++){
    rma=(rma*(period-1)+atrArr[i])/period;
    rmaArr.push(rma);
  }
  if(rmaArr.length<2) return {trend:'SIDE',value:0};
  // Compute bands from rmaArr aligned to candles
  const offset=candles.length-rmaArr.length;
  const bands=rmaArr.map((a,i)=>{
    const idx=i+offset;
    const hl2=(highs[idx]+lows[idx])/2;
    return {upper:hl2+mult*a, lower:hl2-mult*a};
  });
  // Compute supertrend direction
  let dir=1; // 1=UP, -1=DOWN
  let stVal=bands[0].lower;
  for(let i=1;i<bands.length;i++){
    const c=closes[i+offset];
    if(dir===1){
      stVal=Math.max(bands[i].lower, stVal);
      if(c<stVal){ dir=-1; stVal=bands[i].upper; }
    } else {
      stVal=Math.min(bands[i].upper, stVal);
      if(c>stVal){ dir=1; stVal=bands[i].lower; }
    }
  }
  return {trend:dir===1?'UP':'DOWN', value:parseFloat(stVal.toFixed(6))};
}

// ── VWAP (session-based, last 50 candles as proxy) ───────────────
// Returns vwap price — price above vwap = bullish, below = bearish
function vwap(candles){
  if(!candles||candles.length<5) return 0;
  const slice=candles.slice(-50); // last 50 candles
  let cumPV=0, cumVol=0;
  for(const c of slice){
    const tp=(c.high+c.low+c.close)/3;
    cumPV+=tp*c.vol;
    cumVol+=c.vol;
  }
  return cumVol>0?parseFloat((cumPV/cumVol).toFixed(6)):0;
}

function pattern(candles){
  // BUG WAS: HAMMER check didn't verify upper wick — shooting star falsely returned HAMMER
  // FIX: Added upper wick check + added SHOOT_STAR, MORNING_STAR, EVENING_STAR
  if(!candles||candles.length<3) return 'N/A';
  const [c1,c2,c3]=candles.slice(-3);
  const body=Math.abs(c3.close-c3.open),range=c3.high-c3.low;
  const bull=c3.close>c3.open;
  const upperWick=c3.high-Math.max(c3.open,c3.close);
  const lowerWick=Math.min(c3.open,c3.close)-c3.low;
  const c2body=Math.abs(c2.close-c2.open),c1body=Math.abs(c1.close-c1.open);
  // Engulfing
  if(bull&&c2.close<c2.open&&c3.close>c2.open&&c3.open<c2.close) return 'BULL_ENGULF';
  if(!bull&&c2.close>c2.open&&c3.close<c2.open&&c3.open>c2.close) return 'BEAR_ENGULF';
  // Doji
  if(range>0&&body/range<0.1) return 'DOJI';
  // Three-candle reversal patterns
  const midIsDoji=c2body<c1body*0.3;
  if(c1.close<c1.open&&midIsDoji&&c3.close>c3.open&&c3.close>(c1.open+c1.close)/2) return 'MORNING_STAR';
  if(c1.close>c1.open&&midIsDoji&&c3.close<c3.open&&c3.close<(c1.open+c1.close)/2) return 'EVENING_STAR';
  // Three consecutive same-direction
  if(c1.close>c1.open&&c2.close>c2.open&&c3.close>c3.open) return '3_GREEN';
  if(c1.close<c1.open&&c2.close<c2.open&&c3.close<c3.open) return '3_RED';
  // Hammer: long lower wick, small upper wick (bullish reversal)
  if(lowerWick>body*2&&upperWick<body*0.5) return 'HAMMER';
  // Shooting Star: long upper wick, small lower wick (bearish reversal) — was missing!
  if(upperWick>body*2&&lowerWick<body*0.5) return 'SHOOT_STAR';
  return 'NORMAL';
}

function tfSnapshot(candles){
  if(!candles||candles.length<26) return null;
  const closes=candles.map(c=>c.close);
  const highs=candles.map(c=>c.high);
  const lows=candles.map(c=>c.low);
  const vols=candles.map(c=>c.vol);
  const bb=bollingerBands(closes);
  const mc=macd(closes);
  const sr=stochRsi(closes);
  const atrData=atr(highs,lows,closes);
  return {
    trend:       trend(closes),
    rsi:         rsi(closes),
    stochK:      sr.k,
    stochD:      sr.d,
    stochCrossUp:sr.crossUp,
    stochCrossDn:sr.crossDn,
    macdHist:    mc.hist,
    macdBull:    mc.hist>0,
    macdCrossUp: mc.crossUp,   // Fresh golden cross this candle
    macdCrossDn: mc.crossDn,   // Fresh death cross this candle
    bb:          bb,
    bbPos:       parseFloat(((closes.at(-1)-bb.lower)/(bb.upper-bb.lower||1)*100).toFixed(1)),
    mom10:       mom(closes,10),
    atr:         atrData.pct,  // % ATR (backward compat for hard-reject thresholds)
    atrAbs:      atrData.abs,  // Absolute ATR — use for SL/TP calculation
    volRatio:    volRatio(vols),
    obv:         obv(closes,vols),         // +1 rising, -1 falling, 0 flat
    williamsR:   williamsR(highs,lows,closes), // -100 to 0 (below -80=oversold, above -20=overbought)
    ema9:        parseFloat(ema(closes,9).toFixed(6)),
    ema21:       parseFloat(ema(closes,21).toFixed(6)),
    ema50:       closes.length>=50?parseFloat(ema(closes,50).toFixed(6)):null,
    support:     parseFloat(Math.min(...lows.slice(-20)).toFixed(6)),
    resist:      parseFloat(Math.max(...highs.slice(-20)).toFixed(6)),
    pattern:     pattern(candles),
    supertrend:  supertrend(candles),   // {trend:'UP'/'DOWN', value:price}
    vwap:        vwap(candles),         // VWAP price (0 if no vol data)
  };
}

// ── SMART PRE-FILTER (saves ~70% Claude API calls) ────────────────
// Score 0-120+. Claude called only if score >= ~55 (normal) / ~40 (aggressive)
function preFilter(coin, aggressive=false, futuresMode=false) {
  const m15=coin.m15, h1=coin.h1, h4=coin.h4, d1=coin.d1;
  if(!m15||!h1||!h4) return {score:0, reason:'No data'};

  const reasons = [];
  let score = 0;

  const dailyTrend = d1?.trend || 'SIDE';
  const dailyST    = d1?.supertrend?.trend || 'SIDE';

  // ── Hard rejects ──────────────────────────────────────────────
  // Futures mode: relax volRatio — leverage compensates for low volume
  const minVol = futuresMode ? 0.3 : (aggressive ? 0.6 : 0.9);

  if(!aggressive){
    if(h4.trend==='SIDE'&&h1.trend==='SIDE'&&!futuresMode) return {score:0, reason:'Both h4+h1 SIDE'};
    if(h4.trend!==h1.trend&&h4.trend!=='SIDE'&&h1.trend!=='SIDE'&&!futuresMode) return {score:0, reason:'h4/h1 conflict'};
    if(m15.atr>5) return {score:0, reason:`ATR too high ${m15.atr}%`};
    if(m15.volRatio<minVol) return {score:0, reason:`Low volume ${m15.volRatio}x`};
  } else {
    if(h4.trend==='SIDE'&&h1.trend==='SIDE'&&m15.trend==='SIDE'&&!futuresMode) return {score:0, reason:'All 3TF SIDE'};
    if(m15.atr>8) return {score:0, reason:`ATR extreme ${m15.atr}%`};
    if(m15.volRatio<minVol) return {score:0, reason:`Volume too low ${m15.volRatio}x`};
  }

  const longSetup = (aggressive ? h1.trend==='UP' : h4.trend==='UP'&&h1.trend==='UP');
  const shortSetup = (aggressive ? h1.trend==='DOWN' : h4.trend==='DOWN'&&h1.trend==='DOWN');

  if(longSetup){
    // ── Daily trend alignment (bonus/penalty, not hard reject) ──
    if(dailyTrend==='UP')   { score+=18; reasons.push('D1 trend UP'); }
    if(dailyST==='UP')      { score+=12; reasons.push('D1 Supertrend UP'); }
    if(dailyTrend==='DOWN') { score-=10; reasons.push('D1 against'); }
    // ── H1 Supertrend ──
    if(h1.supertrend?.trend==='UP')  { score+=10; reasons.push('h1 ST UP'); }
    // ── VWAP position ──
    const price=coin.price||0;
    if(h1.vwap>0&&price>h1.vwap)    { score+=8;  reasons.push('Above VWAP'); }

    score+=20; reasons.push('Trend UP');
    if(h1.rsi<65){ score+=15; reasons.push(`RSI ${h1.rsi} OK`); }
    else if(h1.rsi<72){ score+=5; reasons.push(`RSI ${h1.rsi} border`); }
    else return {score:0, reason:`RSI overbought ${h1.rsi}`};
    if(h1.macdBull){ score+=10; reasons.push('MACD bull'); }
    if(h1.macdCrossUp){ score+=12; reasons.push('h1 MACD ⚡crossUp'); }
    if(m15.macdCrossUp){ score+=8; reasons.push('m15 MACD crossUp'); }
    if(h1.bbPos<75){ score+=8; reasons.push(`BB ${h1.bbPos}%`); }
    if(h1.stochK<75){ score+=7; reasons.push(`Stoch ${h1.stochK}`); }
    if(h1.stochCrossUp){ score+=8; reasons.push('Stoch ⚡crossUp'); }
    if(h1.williamsR!==undefined&&h1.williamsR<-20&&h1.williamsR>-80){ score+=5; reasons.push(`W%R ${h1.williamsR}`); }
    if(m15.obv>0){ score+=6; reasons.push('OBV rising'); }
    if(m15.volRatio>1.5){ score+=15; reasons.push(`Vol ${m15.volRatio}x strong`); }
    else if(m15.volRatio>1.2){ score+=8; reasons.push(`Vol ${m15.volRatio}x ok`); }
    if(['BULL_ENGULF','HAMMER','3_GREEN','MORNING_STAR'].includes(m15.pattern)){ score+=15; reasons.push(`🕯 ${m15.pattern}`); }
    else if(m15.pattern==='DOJI'&&h1.trend==='UP'){ score+=5; reasons.push('DOJI pullback'); }
  } else if(shortSetup){
    // ── Daily trend alignment (bonus/penalty, not hard reject) ──
    if(dailyTrend==='DOWN') { score+=18; reasons.push('D1 trend DOWN'); }
    if(dailyST==='DOWN')    { score+=12; reasons.push('D1 Supertrend DOWN'); }
    if(dailyTrend==='UP')   { score-=10; reasons.push('D1 against'); }
    // ── H1 Supertrend ──
    if(h1.supertrend?.trend==='DOWN') { score+=10; reasons.push('h1 ST DOWN'); }
    // ── VWAP position ──
    const price2=coin.price||0;
    if(h1.vwap>0&&price2<h1.vwap)    { score+=8;  reasons.push('Below VWAP'); }

    score+=20; reasons.push('Trend DOWN');
    if(h1.rsi>35){ score+=15; reasons.push(`RSI ${h1.rsi} OK`); }
    else if(h1.rsi>28){ score+=5; reasons.push(`RSI ${h1.rsi} border`); }
    else return {score:0, reason:`RSI oversold ${h1.rsi}`};
    if(!h1.macdBull){ score+=10; reasons.push('MACD bear'); }
    if(h1.macdCrossDn){ score+=12; reasons.push('h1 MACD ⚡crossDn'); }
    if(m15.macdCrossDn){ score+=8; reasons.push('m15 MACD crossDn'); }
    if(h1.bbPos>25){ score+=8; reasons.push(`BB ${h1.bbPos}%`); }
    if(h1.stochK>25){ score+=7; reasons.push(`Stoch ${h1.stochK}`); }
    if(h1.stochCrossDn){ score+=8; reasons.push('Stoch ⚡crossDn'); }
    if(h1.williamsR!==undefined&&h1.williamsR>-80&&h1.williamsR<-20){ score+=5; reasons.push(`W%R ${h1.williamsR}`); }
    if(m15.obv<0){ score+=6; reasons.push('OBV falling'); }
    if(m15.volRatio>1.5){ score+=15; reasons.push(`Vol ${m15.volRatio}x strong`); }
    else if(m15.volRatio>1.2){ score+=8; reasons.push(`Vol ${m15.volRatio}x ok`); }
    if(['BEAR_ENGULF','3_RED','SHOOT_STAR','EVENING_STAR'].includes(m15.pattern)){ score+=15; reasons.push(`🕯 ${m15.pattern}`); }
    else if(m15.pattern==='DOJI'&&h1.trend==='DOWN'){ score+=5; reasons.push('DOJI resistance'); }
  } else {
    return {score:0, reason:'No clear setup'};
  }

  const direction = longSetup ? 'LONG' : 'SHORT';

  // Dynamic TP multiplier — G0DM0D3 adaptive strategy
  // If very strong setup (MACD crossUp + strong volume + good pattern), suggest TP extension
  let tpMultiplier = 1.0;
  const hasStrongMomentum = reasons.includes('MACD ⚡crossUp') || reasons.includes('MACD ⚡crossDn');
  const hasStrongVolume = reasons.includes('Vol') && m15.volRatio > 1.8;
  const hasStrongPattern = ['BULL_ENGULF','MORNING_STAR','BEAR_ENGULF','EVENING_STAR'].some(p=>reasons.includes(p));
  if(hasStrongMomentum && hasStrongVolume) { tpMultiplier = 1.5; reasons.push('⚡TP+50%'); }
  else if(hasStrongMomentum || (hasStrongPattern && hasStrongVolume)) { tpMultiplier = 1.3; reasons.push('⚡TP+30%'); }

  return {score, direction, reasons: reasons.join(' | '), tpMultiplier};
}

// ── KUCOIN WEBSOCKET ──────────────────────────────────────────────
async function loadCandles(sym,interval,limit=100){
  const mins=interval==='15min'?15:interval==='1hour'?60:interval==='4hour'?240:1440;
  const endAt=Math.floor(Date.now()/1000);
  const startAt=endAt-(limit*mins*60);
  const r=await axios.get('https://api.kucoin.com/api/v1/market/candles',{
    params:{symbol:`${sym}-USDT`,type:interval,startAt,endAt},
    timeout:12000,headers:{Accept:'application/json'}
  });
  if(r.data.code!=='200000') throw new Error(`${sym} ${interval}: ${r.data.msg}`);
  return r.data.data.reverse().map(k=>({
    time:parseInt(k[0]),open:parseFloat(k[1]),close:parseFloat(k[2]),
    high:parseFloat(k[3]),low:parseFloat(k[4]),vol:parseFloat(k[5])
  }));
}

async function getWsToken(){
  const r=await axios.post('https://api.kucoin.com/api/v1/bullet-public',{},{timeout:8000});
  if(r.data.code!=='200000') throw new Error('WS token failed');
  return {token:r.data.data.token,endpoint:r.data.data.instanceServers[0].endpoint};
}

async function connectWebSocket(){
  if(wsConnected) return;
  try {
    // Clean up old connection before creating new one
    if(wsConnection){
      wsConnection.removeAllListeners();
      try{ wsConnection.terminate(); }catch(e){}
      wsConnection = null;
    }
    if(app._heartbeat){ clearInterval(app._heartbeat); app._heartbeat=null; }
    const {token,endpoint}=await getWsToken();
    const ws=new WebSocket(`${endpoint}?token=${token}&connectId=nexus${Date.now()}`);
    ws.setMaxListeners(20);
    wsConnection=ws;
    wsConnection.on('open',()=>{
      wsConnected=true; console.log('WebSocket connected');
      const topics=activeSymbols.slice(0,20).map(s=>`${s}-USDT`).join(',');
      wsConnection.send(JSON.stringify({id:Date.now(),type:'subscribe',topic:`/market/ticker:${topics}`,privateChannel:false,response:true}));
      activeSymbols.slice(0,10).forEach(sym=>{
        wsConnection.send(JSON.stringify({id:Date.now()+Math.random(),type:'subscribe',topic:`/market/candles:${sym}-USDT_15min`,privateChannel:false,response:true}));
      });
      if(app._heartbeat) clearInterval(app._heartbeat);
      app._heartbeat=setInterval(()=>{if(wsConnected) wsConnection.send(JSON.stringify({id:Date.now(),type:'ping'}));},20000);
    });
    wsConnection.on('message',(raw)=>{
      try {
        const msg=JSON.parse(raw.toString());
        if(msg.type!=='message') return;
        if(msg.topic&&msg.topic.includes('/market/ticker:')){
          const sym=msg.subject?.replace('-USDT','');
          if(!sym||!store[sym]) return;
          const d=msg.data, price=parseFloat(d.price);
          store[sym].tick={price,change24h:parseFloat((parseFloat(d.changeRate||0)*100).toFixed(2)),volume24h:parseFloat(d.volValue||0),bid:parseFloat(d.bestBid||price),ask:parseFloat(d.bestAsk||price),lastUpdated:Date.now()};
          if(store[sym].m15?.length>0){const last=store[sym].m15.at(-1);last.close=price;last.high=Math.max(last.high,price);last.low=Math.min(last.low,price);}
          buildCache();
        }
        if(msg.topic&&msg.topic.includes('/market/candles:')){
          const parts=msg.topic.split(':')[1]?.split('_');
          if(!parts) return;
          const sym=parts[0].replace('-USDT','');
          if(!store[sym]) return;
          const k=msg.data?.candles; if(!k) return;
          const candle={time:parseInt(k[0]),open:parseFloat(k[1]),close:parseFloat(k[2]),high:parseFloat(k[3]),low:parseFloat(k[4]),vol:parseFloat(k[5])};
          const arr=store[sym].m15, last=arr.at(-1);
          if(last&&last.time===candle.time) arr[arr.length-1]=candle;
          else{arr.push(candle);if(arr.length>150) arr.shift();}
          buildCache();
        }
      } catch(e){}
    });
    wsConnection.on('close',()=>{wsConnected=false;console.log('WS closed — retry 5s');setTimeout(connectWebSocket,5000);});
    wsConnection.on('error',(e)=>{console.error('WS error:',e.message);wsConnected=false;});
  } catch(e){console.error('WS connect failed:',e.message);setTimeout(connectWebSocket,10000);}
}

async function initialLoad(){
  console.log('Loading top coins from KuCoin + BingX...');
  const exclude=['USDT','USDC','BUSD','DAI','TUSD','3L','3S','2L','2S','UP','DOWN','BEAR','BULL'];

  // KuCoin coins
  let kuCoins=[];
  try {
    const r=await axios.get('https://api.kucoin.com/api/v1/market/allTickers',{timeout:10000});
    if(r.data.code!=='200000') throw new Error('Tickers failed');
    kuCoins=r.data.data.ticker
      .filter(t=>t.symbol.endsWith('-USDT')&&!exclude.some(e=>t.symbol.replace('-USDT','').includes(e))&&parseFloat(t.volValue)>2000000)
      .sort((a,b)=>parseFloat(b.volValue)-parseFloat(a.volValue))
      .slice(0,70).map(t=>t.symbol.replace('-USDT',''));
    console.log(`KuCoin: ${kuCoins.length} coins`);
  } catch(e){ console.error('KuCoin tickers failed:',e.message); }

  // BingX coins
  let bxCoins=[];
  try {
    const tickers = await fetchBingXTickers();
    bxCoins = tickers
      .filter(t=>t.symbol&&t.symbol.endsWith('-USDT')&&!exclude.some(e=>t.symbol.replace('-USDT','').includes(e))&&parseFloat(t.quoteVolume||0)>2000000)
      .sort((a,b)=>parseFloat(b.quoteVolume||0)-parseFloat(a.quoteVolume||0))
      .slice(0,50).map(t=>t.symbol.replace('-USDT',''));
    console.log(`BingX: ${bxCoins.length} coins`);
  } catch(e){ console.error('BingX tickers failed:',e.message); }

  // Merge — KuCoin first, BingX adds new ones
  activeSymbols = [...new Set([...kuCoins, ...bxCoins])];
  if(!activeSymbols.length) activeSymbols=['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT'];
  // Track BingX-only coins for market scanner badge
  global.bxOnlyCoins = new Set(bxCoins.filter(s=>!kuCoins.includes(s)));
  console.log(`Total coins: ${activeSymbols.length} (KU:${kuCoins.length} BX:${bxCoins.length} BX-only:${global.bxOnlyCoins.size})`);
  let loaded=0;
  for(const sym of activeSymbols){
    store[sym]={tick:{},m15:[],h1:[],h4:[],d1:[]};
    try {
      store[sym].m15=await loadCandles(sym,'15min',100); await sleep(300);
      store[sym].h1=await loadCandles(sym,'1hour',100);  await sleep(300);
      store[sym].h4=await loadCandles(sym,'4hour',60);   await sleep(300);
      store[sym].d1=await loadCandles(sym,'1day',60);    await sleep(300);
      loaded++;
    } catch(e){}
  }
  console.log(`Candles loaded: ${loaded}/${activeSymbols.length}`);
  buildCache();
  await connectWebSocket();
}

let marketCache=[];
function buildCache(){
  marketCache=activeSymbols.map(sym=>{
    const d=store[sym];
    if(!d||!d.m15||d.m15.length<26) return null;
    const tick=d.tick||{}, price=tick.price||d.m15.at(-1)?.close||0;
    return {
      symbol:sym, price:parseFloat(price.toFixed(6)),
      change24h:tick.change24h||0, volume24h:tick.volume24h||0,
      bid:tick.bid||price, ask:tick.ask||price,
      liveAge:tick.lastUpdated?Math.round((Date.now()-tick.lastUpdated)/1000):999,
      m15:tfSnapshot(d.m15), h1:tfSnapshot(d.h1), h4:tfSnapshot(d.h4),
      d1:d.d1&&d.d1.length>=26?tfSnapshot(d.d1):null,
      isBingX: !!(global.bxOnlyCoins&&global.bxOnlyCoins.has(sym)),
    };
  }).filter(Boolean).sort((a,b)=>(b.volume24h||0)-(a.volume24h||0));
}

let newsCache={data:[],ts:0,sentiment:'NEUTRAL'};
async function fetchNews(){
  if(!NEWSDATA_KEY||Date.now()-newsCache.ts<300000) return newsCache;
  try {
    const r=await axios.get('https://newsdata.io/api/1/news',{params:{apikey:NEWSDATA_KEY,q:'crypto bitcoin',language:'en',size:8},timeout:8000});
    const hl=(r.data.results||[]).map(a=>({title:a.title,time:a.pubDate,source:a.source_id}));
    const text=hl.map(h=>h.title.toLowerCase()).join(' ');
    const pos=['surge','rally','bull','gain','bullish','ath','record'].filter(w=>text.includes(w)).length;
    const neg=['crash','dump','fall','bear','bearish','ban','collapse'].filter(w=>text.includes(w)).length;
    newsCache={data:hl,ts:Date.now(),sentiment:pos>neg+1?'BULLISH':neg>pos+1?'BEARISH':'NEUTRAL'};
  } catch(e){}
  return newsCache;
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/api/data',(req,res)=>{
  if(!marketCache.length) return res.status(503).json({ok:false,error:'Loading, retry in 20s'});
  res.json({ok:true,data:marketCache,ts:Date.now(),wsConnected});
});
app.get('/api/news',async(req,res)=>{
  try{res.json({ok:true,...(await fetchNews())});}
  catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ── PRE-FILTER ROUTE (check before Claude) ─────────────────────
app.post('/api/prefilter',(req,res)=>{
  const {symbols, aggressive=false, orderMode='auto'} = req.body;
  const futuresMode = orderMode === 'futures';
  const coins = symbols
    ? symbols.map(s=>marketCache.find(c=>c.symbol===s)).filter(Boolean)
    : marketCache.slice(0,20);
  const results = coins.map(coin=>{
    // Volatility filter first
    const vf = passVolatilityFilter(coin);
    if(!vf.pass) return {symbol:coin.symbol, score:0, reason:vf.reason, direction:null};
    const pf = preFilter(coin, aggressive, futuresMode);
    const bt = approvedCoins[coin.symbol];
    // Boost score if coin has good backtest history
    let btBoost = 0;
    if(bt){ btBoost = bt.wr >= 65 ? 15 : bt.wr >= 58 ? 8 : 0; }
    return {symbol:coin.symbol, ...pf, score:(pf.score||0)+btBoost, price:coin.price,
      btWR:bt?.wr||null, btType:bt?.tradeType||null, btApproved:!!bt};
  }).filter(r=>r.score>0).sort((a,b)=>b.score-a.score);
  // Log top candidates with D1 data for verification
  if(results.length>0){
    const top=results.slice(0,3);
    top.forEach(r=>{
      const coin=marketCache.find(c=>c.symbol===r.symbol);
      const d1trend=coin?.d1?.trend||'N/A';
      const d1st=coin?.d1?.supertrend?.trend||'N/A';
      const h1st=coin?.h1?.supertrend?.trend||'N/A';
      const vwapPos=coin?.h1?.vwap>0?(coin.price>coin.h1.vwap?'above':'below'):'N/A';
      console.log('[PREFILTER] '+r.symbol+' score='+r.score+' dir='+r.direction+
        ' D1='+d1trend+' D1_ST='+d1st+' H1_ST='+h1st+' VWAP='+vwapPos+
        ' | '+r.reasons);
    });
  }
  res.json({ok:true, candidates:results, total:results.length});
});

// ── ANALYZE ROUTE ─────────────────────────────────────────────────
let lastAnalyzeTime=0;
app.post('/api/analyze',async(req,res)=>{
  if(!CLAUDE_KEY) return res.status(500).json({ok:false,error:'CLAUDE_API_KEY not set'});
  const now=Date.now();
  if(now-lastAnalyzeTime<20000) return res.status(429).json({ok:false,error:'Rate limit'});
  lastAnalyzeTime=now;
  try {
    const {prompt,model,aggressive=false,orderMode='auto'} = req.body;
    const knownSyms=activeSymbols.length?activeSymbols:['BTC','ETH','SOL','BNB','XRP'];
    const allMatches=prompt?.match(/\b([A-Z]{2,10})\b/g)||[];
    const promptSymbol=allMatches.find(s=>knownSyms.includes(s))||'N/A';
    const memory=await loadMemory(promptSymbol);

    const r=await axios.post('https://api.anthropic.com/v1/messages',{
      model:model||'claude-sonnet-4-20250514',
      max_tokens:2500,
      system:`You are NEXUS PRO, an elite crypto trading agent optimized for profit.
You receive pre-filtered high-quality setups with advanced indicators (MACD, Bollinger Bands, Stochastic RSI).
These coins already passed a strict pre-filter — your job is to pick the BEST ones and set precise SL/TP.
Coins with btWR (backtest win rate) are historically proven — prefer them. btType tells you spot or futures.
Return ONLY raw JSON. No markdown.
FORMAT: {"market_read":"...","signals":[{"symbol":"...","direction":"LONG/SHORT","confidence":8.5,"sl_pct":2.0,"tp_pct":5.0,"reason":"...","trade_type":"spot/futures","leverage":1}],"skip_reason":"..."}
${memory}`,
      messages:[{role:'user',content:prompt}]
    },{
      headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      timeout:50000
    });

    const text=r.data.content[0]?.text||'';
    let parsed = null;
    // Structured retry: attempt 1 — extract JSON from response
    const m=text.match(/\{[\s\S]*\}/);
    if(m){
      try { parsed = JSON.parse(m[0]); } catch(e){ parsed = null; }
    }
    // Retry attempt 2 — if parse failed, ask Claude to fix the JSON
    if(!parsed){
      try {
        const retryR = await axios.post('https://api.anthropic.com/v1/messages',{
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 800,
          system: 'Fix this broken JSON and return ONLY valid JSON. No explanation.',
          messages:[{role:'user',content:`Fix to valid JSON, return ONLY {"market_read":"...","signals":[],"skip_reason":"..."}:\n${text.slice(0,300)}`}]
        },{headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},timeout:10000});
        const retryText = retryR.data.content[0]?.text||'';
        const retryM = retryText.match(/\{[\s\S]*\}/);
        if(retryM) parsed = JSON.parse(retryM[0]);
      } catch(e2){ /* retry also failed */ }
    }
    if(!parsed) return res.status(500).json({ok:false,error:'No JSON in response after retry'});

    if(process.env.TURSO_DATABASE_URL&&Array.isArray(parsed.signals)&&parsed.signals.length>0){
      for(const sig of parsed.signals){
        if(!['LONG','SHORT'].includes(sig.direction)||!sig.symbol||sig.symbol==='N/A') continue;
        try {
          const coin=marketCache.find(c=>c.symbol===sig.symbol);
          const price=coin?.price||null;
          const slPrice=price&&sig.sl_pct?parseFloat((price*(sig.direction==='LONG'?1-sig.sl_pct/100:1+sig.sl_pct/100)).toFixed(6)):null;
          const tpPrice=price&&sig.tp_pct?parseFloat((price*(sig.direction==='LONG'?1+sig.tp_pct/100:1-sig.tp_pct/100)).toFixed(6)):null;
          // Trade type: orderMode ko HIGHEST priority do
          // futures mode = ALWAYS futures | spot mode = ALWAYS spot | auto = decide karo
          const sigCoin = marketCache.find(cc=>cc.symbol===sig.symbol);
          const sigTradeDecision = decideTradeType(sigCoin);
          let finalTradeType;
          if(orderMode === 'futures') {
            finalTradeType = 'futures';  // User ne force kiya futures
          } else if(orderMode === 'spot') {
            finalTradeType = 'spot';     // User ne force kiya spot
          } else {
            // AUTO: Claude ka suggestion → decideTradeType → default spot
            finalTradeType = sig.trade_type || sigTradeDecision.type || 'spot';
          }
          const finalExchange = process.env.BINGX_API_KEY && !process.env.KUCOIN_API_KEY ? 'bingx' : (process.env.KUCOIN_API_KEY ? 'kucoin' : 'bingx');
          // DEDUP FIX: Same symbol+direction 30 min mein dobara PENDING insert nahi hoga
          const dupCheck = await db.execute({
            sql: `SELECT id FROM signals WHERE symbol=? AND signal=? AND outcome='PENDING'
                  AND created_at > datetime('now', '-30 minutes') LIMIT 1`,
            args: [sig.symbol, sig.direction]
          });
          if(dupCheck.rows.length > 0) {
            console.log(`Signal SKIPPED (duplicate): ${sig.symbol} ${sig.direction} already pending`);
            continue;
          }
          await db.execute({
            sql:`INSERT INTO signals (symbol,signal,entry,tp,sl,confidence,reasoning,trade_type,exchange) VALUES (?,?,?,?,?,?,?,?,?)`,
            args:[sig.symbol,sig.direction,price,tpPrice,slPrice,sig.confidence||null,sig.reason||null,
                  finalTradeType, finalExchange]
          });
          console.log(`Signal saved: ${sig.symbol} ${sig.direction} conf=${sig.confidence} type=${finalTradeType}`);
        } catch(dbErr){console.error('DB save error:',dbErr.message);}
      }
    }
    res.json({ok:true,result:parsed});
  } catch(e){
    res.status(500).json({ok:false,error:e.response?.data?JSON.stringify(e.response.data).slice(0,200):e.message});
  }
});

// ── AUTH ──────────────────────────────────────────────────────────
app.post('/api/auth',(req,res)=>{
  const {password}=req.body;
  const correct=process.env.NEXUS_PASSWORD||'nexus123';
  if(password!==correct) return res.status(401).json({ok:false,error:'Wrong password'});
  const token=crypto.randomBytes(32).toString('hex');
  SESSION_TOKENS.add(token);
  setTimeout(()=>SESSION_TOKENS.delete(token),24*60*60*1000);
  res.json({ok:true,token});
});
app.get('/api/auth/verify',(req,res)=>{
  const token=req.headers['x-nexus-token'];
  if(token&&SESSION_TOKENS.has(token)) return res.json({ok:true});
  res.status(401).json({ok:false});
});

// ── TRADING MODE ──────────────────────────────────────────────────
app.get('/api/mode',(req,res)=>{
  const kuOk=!!(process.env.KUCOIN_API_KEY&&process.env.KUCOIN_API_SECRET&&process.env.KUCOIN_PASSPHRASE);
  const bxOk=!!(BINGX_API_KEY&&BINGX_SECRET);
  res.json({ok:true,mode:tradingMode,keysConfigured:kuOk||bxOk,kucoin:kuOk,bingx:bxOk});
});
app.post('/api/mode',(req,res)=>{
  const {mode}=req.body;
  if(!['paper','live'].includes(mode)) return res.status(400).json({ok:false,error:'Mode must be paper or live'});
  if(mode==='live'){
    const kuOk=!!(process.env.KUCOIN_API_KEY&&process.env.KUCOIN_API_SECRET&&process.env.KUCOIN_PASSPHRASE);
    const bxOk=!!(BINGX_API_KEY&&BINGX_SECRET);
    if(!kuOk&&!bxOk) return res.status(400).json({ok:false,error:'No exchange keys configured (KuCoin or BingX)'});
  }
  tradingMode=mode;
  res.json({ok:true,mode});
});

// ── FUNDING RATE CHECK ───────────────────────────────────────────
async function checkFundingRate(symbol, direction) {
  try {
    const r = await axios.get('https://open-api.bingx.com/openApi/swap/v2/quote/premiumIndex', {
      params: { symbol: symbol+'-USDT', timestamp: Date.now() },
      timeout: 5000
    });
    if(String(r.data.code) !== '0') return { ok:true }; // fail safe
    const rate = parseFloat(r.data.data?.lastFundingRate || 0) * 100;
    const MAX = 0.15; // 0.15% threshold
    if(direction==='LONG' && rate > MAX)
      return { ok:false, rate, reason:`Funding ${rate.toFixed(3)}% too high — longs crowded` };
    if(direction==='SHORT' && rate < -MAX)
      return { ok:false, rate, reason:`Funding ${rate.toFixed(3)}% too negative — shorts crowded` };
    return { ok:true, rate };
  } catch(e) { return { ok:true }; } // fail safe — never block trade on API error
}

// ── ORDER ROUTES ──────────────────────────────────────────────────
app.post('/api/order',async(req,res)=>{
  if(tradingMode!=='live') return res.json({ok:false,error:'Not in live mode'});
  try {
    const {symbol,direction,sizeUsdt,sl,tp,qty,trade_type,leverage}=req.body;
    const kuOk=!!(process.env.KUCOIN_API_KEY&&process.env.KUCOIN_API_SECRET&&process.env.KUCOIN_PASSPHRASE);
    const bxOk=!!(BINGX_API_KEY&&BINGX_SECRET);
    if(!kuOk&&!bxOk) return res.status(400).json({ok:false,error:'No exchange keys configured'});
    // Prefer KuCoin if available, BingX as fallback
    const useBingX = bxOk && !kuOk;
    const isFutures = trade_type === 'futures';
    const lev = leverage || 5;
    const side = direction==='LONG' ? 'buy' : 'sell';
    let entryId, slId=null, tpId=null, exchange;

    // Funding rate check for futures only
    if(isFutures) {
      const fr = await checkFundingRate(symbol, direction);
      if(!fr.ok) {
        console.log(`[FUNDING] Blocked ${symbol} ${direction}: ${fr.reason}`);
        return res.json({ok:false, error:fr.reason, blocked_by:'funding_rate'});
      }
      if(fr.rate !== undefined) console.log(`[FUNDING] OK ${symbol}: ${fr.rate.toFixed(3)}%`);
    }

    if(useBingX) {
      exchange = 'bingx';
      if(isFutures) {
        // BingX Futures (Perpetual)
        const bxSide = direction==='LONG' ? 'BUY' : 'SELL';
        const r = await bxFuturesOrder(symbol, bxSide, sizeUsdt, lev);
        entryId = r?.orderId || 'bxf_'+Date.now();
      } else {
        // BingX Spot
        const r = await bxPlaceOrder(symbol, side, sizeUsdt);
        entryId = r?.orderId || 'bx_'+Date.now();
      }
      // SL/TP managed by Guardian for BingX (no native stop orders needed)
    } else {
      exchange = 'kucoin';
      if(isFutures) {
        // KuCoin Margin (futures-like)
        entryId = await kuFuturesOrder(symbol, side, sizeUsdt, lev);
      } else {
        // KuCoin Spot
        entryId = await placeMarketOrder(symbol, side, sizeUsdt);
        const slSide = direction==='LONG' ? 'sell' : 'buy';
        slId = await placeStopOrder(symbol, slSide, sl, qty);
        tpId = await placeLimitOrder(symbol, slSide, tp, qty);
      }
    }
    res.json({ok:true, entryId, slId, tpId, exchange, trade_type: isFutures?'futures':'spot', leverage:lev});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.post('/api/order/close',async(req,res)=>{
  if(tradingMode!=='live') return res.json({ok:false,error:'Not in live mode'});
  try {
    const {symbol,direction,qty,slId,tpId}=req.body;
    if(slId) await cancelKuOrder(slId).catch(()=>{});
    if(tpId) await cancelKuOrder(tpId).catch(()=>{});
    const closeSide=direction==='LONG'?'sell':'buy';
    const curPrice=marketCache.find(c=>c.symbol===symbol)?.price||1;
    const closeId=await placeMarketOrder(symbol,closeSide,qty*curPrice,qty);
    res.json({ok:true,closeId});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ── DB CLEANUP ────────────────────────────────────────────────────
app.post('/api/db/cleanup', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'Turso not configured'});
  try {
    // Delete PENDING signals older than 2h that have no open trade
    // This is the main fix — old code only deleted entry IS NULL which never matched
    const d1 = await db.execute({
      sql: `DELETE FROM signals
            WHERE outcome = 'PENDING'
              AND created_at < datetime('now', '-30 minutes')
              AND id NOT IN (
                SELECT DISTINCT signal_id FROM active_trades
                WHERE status = 'OPEN' AND signal_id IS NOT NULL
              )`,
      args: []
    });
    // Mark remaining old PENDING (>24h) as EXPIRED
    const d2 = await db.execute({
      sql: `UPDATE signals SET outcome='EXPIRED', evaluated_at=CURRENT_TIMESTAMP
            WHERE outcome='PENDING' AND created_at < datetime('now','-24 hours')`,
      args: []
    });
    // Delete exact duplicates (same symbol+signal within 1 min)
    const d3 = await db.execute({
      sql: `DELETE FROM signals WHERE id NOT IN (
              SELECT MIN(id) FROM signals
              GROUP BY symbol, signal, CAST(strftime('%s',created_at)/60 AS INT)
            ) AND outcome='PENDING'`,
      args: []
    });
    res.json({ok:true,
      null_deleted: Number(d1.rowsAffected||0),
      stale_expired: Number(d2.rowsAffected||0),
      dupes_removed: Number(d3.rowsAffected||0)
    });
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── ACTIVE TRADES (persistent — survives page refresh) ────────────
// Save a new trade when agent opens it
app.post('/api/trades/open', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'Turso not configured'});
  try {
    const {signal_id,symbol,direction,entry_price,tp_price,sl_price,sl_pct,tp_pct,
           confidence,size_usdt,reasoning,trailing,tp1_hit,
           kucoin_entry_id,kucoin_sl_id,kucoin_tp_id,
           trade_type,leverage,exchange} = req.body;
    if (!symbol||!direction||!entry_price) return res.status(400).json({ok:false,error:'symbol/direction/entry_price required'});

    // ── RISK CHECK ──────────────────────────────────────────────
    const openCount = await db.execute({sql:`SELECT COUNT(*) as cnt FROM active_trades WHERE status='OPEN'`,args:[]});
    const openPositionsCount = openCount.rows[0]?.cnt || 0;
    const riskResult = checkRiskLimits(openPositionsCount);
    if(!riskResult.ok) {
      console.log(`[RISK] Trade BLOCKED: ${riskResult.reason}`);
      sendTelegramFiltered(`🚫 <b>TRADE BLOCKED</b>\n${symbol} ${direction}\nReason: ${riskResult.reason}`, 'risk_block');
      return res.status(400).json({ok:false, error:`RISK: ${riskResult.reason}`, blocked:true});
    }

    // ── ATR-BASED SL (if atrAbs available from coin data) ─────
    let finalSLPrice = sl_price;
    let finalSLPct   = sl_pct;
    const coin = marketCache.find(c=>c.symbol===symbol);
    const atrAbs = coin?.m15?.atrAbs;
    if(atrAbs && atrAbs > 0 && riskConfig.atrSLMultiplier > 0) {
      const slDistance = atrAbs * riskConfig.atrSLMultiplier;
      finalSLPrice = direction==='LONG'
        ? parseFloat((parseFloat(entry_price) - slDistance).toFixed(8))
        : parseFloat((parseFloat(entry_price) + slDistance).toFixed(8));
      finalSLPct = parseFloat((slDistance / parseFloat(entry_price) * 100).toFixed(2));
      console.log(`[RISK] ATR-SL: ${symbol} ATR=${atrAbs} mult=${riskConfig.atrSLMultiplier} SL=${finalSLPrice} (${finalSLPct}%)`);
    }

    const safeLeverage  = leverage || 1;
    const safeTradeType = trade_type || 'spot';
    const safeExchange  = exchange || (process.env.BINGX_API_KEY && !process.env.KUCOIN_API_KEY ? 'bingx' : 'kucoin');
    console.log(`[TRADE OPEN] ${symbol} ${direction} entry=${entry_price} type=${safeTradeType} lev=${safeLeverage} exch=${safeExchange}`);
    const result = await db.execute({
      sql: `INSERT INTO active_trades
              (signal_id,symbol,direction,entry_price,tp_price,sl_price,sl_pct,tp_pct,
               confidence,size_usdt,reasoning,trailing,tp1_hit,
               kucoin_entry_id,kucoin_sl_id,kucoin_tp_id,status,
               trade_type,leverage,exchange)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',?,?,?)`,
      args: [signal_id||null, symbol, direction, entry_price, tp_price||null, finalSLPrice||sl_price||null,
             finalSLPct||sl_pct||null, tp_pct||null, confidence||null, size_usdt||null, reasoning||null,
             trailing?1:0, tp1_hit?1:0,
             kucoin_entry_id||null, kucoin_sl_id||null, kucoin_tp_id||null,
             safeTradeType, safeLeverage, safeExchange]
    });
    const tradeId = Number(result.lastInsertRowid);
    // Telegram notification — trade opened
    const tgType = safeTradeType==='futures' ? `FUTURES ${safeLeverage}x` : 'SPOT';
    const tgDir  = direction==='LONG' ? '📈 LONG' : '📉 SHORT';
    sendTelegramFiltered(`🚀 <b>TRADE OPENED</b> [${tgType}]\n${tgDir} <b>${symbol}</b> @ $${parseFloat(entry_price).toFixed(4)}\nSL: $${parseFloat(sl_price||0).toFixed(4)} (${sl_pct||0}%) | TP: $${parseFloat(tp_price||0).toFixed(4)} (${tp_pct||0}%)\nSize: $${size_usdt||0} | Conf: ${confidence||0} | ${safeExchange.toUpperCase()}`, 'trade_open');
    res.json({ok:true, trade_id: tradeId});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Get all open trades — called on page load to restore state
app.get('/api/trades/open', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:true, trades:[]});
  try {
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades WHERE status='OPEN' ORDER BY opened_at DESC`,
      args: []
    });
    res.json({ok:true, trades: rows.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Close a trade with outcome
app.post('/api/trades/close', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'Turso not configured'});
  try {
    const {trade_id, close_reason, close_price, pnl_pct} = req.body;
    if (!trade_id) return res.status(400).json({ok:false,error:'trade_id required'});
    await db.execute({
      sql: `UPDATE active_trades
            SET status='CLOSED', closed_at=CURRENT_TIMESTAMP,
                close_reason=?, close_price=?, pnl_pct=?
            WHERE id=?`,
      args: [close_reason||'MANUAL', close_price||null, pnl_pct||null, trade_id]
    });
    // signals table bhi update karo — taaki agent memory refresh ke baad bhi rahe
    const outcome = (pnl_pct != null && pnl_pct >= 0) ? 'WIN' : 'LOSS';
    await db.execute({
      sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, evaluated_at=CURRENT_TIMESTAMP
            WHERE id = (SELECT signal_id FROM active_trades WHERE id=? AND signal_id IS NOT NULL LIMIT 1)`,
      args: [outcome, close_price||null, pnl_pct||null, trade_id]
    });
    // Telegram notification for trade close
    try {
      const tradeRow = await db.execute({
        sql: `SELECT symbol, direction, entry_price, trade_type, leverage FROM active_trades WHERE id=?`,
        args: [trade_id]
      });
      if(tradeRow.rows.length > 0) {
        const t = tradeRow.rows[0];
        const emoji = pnl_pct >= 0 ? '✅' : '❌';
        const tgType = t.trade_type === 'futures' ? `FUTURES ${t.leverage||1}x` : 'SPOT';
        const pnlStr = pnl_pct != null ? `${pnl_pct >= 0 ? '+' : ''}${parseFloat(pnl_pct).toFixed(2)}%` : 'N/A';
        sendTelegramFiltered(`${emoji} <b>TRADE CLOSED</b> [${tgType}]\n${t.direction} <b>${t.symbol}</b>\nEntry: $${parseFloat(t.entry_price).toFixed(4)} → Exit: $${parseFloat(close_price||0).toFixed(4)}\nPnL: ${pnlStr} | Reason: ${close_reason||'MANUAL'}`, 'trade_close');
      }
    } catch(tgErr) { console.warn('Telegram close notify error:', tgErr.message); }
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Close trade by symbol (fallback when trade_id missing)
app.post('/api/trades/close-by-symbol', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'Turso not configured'});
  try {
    const {symbol, close_reason, close_price, pnl_pct} = req.body;
    if (!symbol) return res.status(400).json({ok:false,error:'symbol required'});
    await db.execute({
      sql: `UPDATE active_trades
            SET status='CLOSED', closed_at=CURRENT_TIMESTAMP,
                close_reason=?, close_price=?, pnl_pct=?
            WHERE symbol=? AND status='OPEN'`,
      args: [close_reason||'MANUAL', close_price||null, pnl_pct||null, symbol]
    });
    // signals table bhi update karo
    const outcome2 = (pnl_pct != null && pnl_pct >= 0) ? 'WIN' : 'LOSS';
    await db.execute({
      sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, evaluated_at=CURRENT_TIMESTAMP
            WHERE id = (SELECT signal_id FROM active_trades WHERE symbol=? AND signal_id IS NOT NULL ORDER BY id DESC LIMIT 1)`,
      args: [outcome2, close_price||null, pnl_pct||null, symbol]
    });
    // Telegram notification
    try {
      const tradeRow2 = await db.execute({
        sql: `SELECT direction, entry_price, trade_type, leverage FROM active_trades WHERE symbol=? AND status='CLOSED' ORDER BY closed_at DESC LIMIT 1`,
        args: [symbol]
      });
      if(tradeRow2.rows.length > 0) {
        const t2 = tradeRow2.rows[0];
        const emoji2 = pnl_pct >= 0 ? '✅' : '❌';
        const tgType2 = t2.trade_type === 'futures' ? `FUTURES ${t2.leverage||1}x` : 'SPOT';
        const pnlStr2 = pnl_pct != null ? `${pnl_pct >= 0 ? '+' : ''}${parseFloat(pnl_pct).toFixed(2)}%` : 'N/A';
        sendTelegramFiltered(`${emoji2} <b>TRADE CLOSED</b> [${tgType2}]\n${t2.direction} <b>${symbol}</b>\nEntry: $${parseFloat(t2.entry_price).toFixed(4)} → Exit: $${parseFloat(close_price||0).toFixed(4)}\nPnL: ${pnlStr2} | Reason: ${close_reason||'MANUAL'}`, 'trade_close');
      }
    } catch(tgErr2) { console.warn('Telegram close-by-symbol notify error:', tgErr2.message); }
    res.json({ok:true});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Get today's closed trades for dashboard restore
app.post('/api/trades/closed-since', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:true, trades:[]});
  try {
    const {since} = req.body;
    const sinceDate = since ? new Date(since).toISOString() : new Date(Date.now()-24*60*60*1000).toISOString();
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades WHERE status='CLOSED' AND closed_at >= ? ORDER BY closed_at DESC LIMIT 50`,
      args: [sinceDate]
    });
    res.json({ok:true, trades: rows.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Get all trades history (open + closed)
app.get('/api/trades', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:true, trades:[]});
  try {
    const limit = parseInt(req.query.limit)||100;
    const rows = await db.execute({
      sql: `SELECT * FROM active_trades ORDER BY opened_at DESC LIMIT ?`,
      args: [limit]
    });
    res.json({ok:true, trades: rows.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// ── CANDLES ───────────────────────────────────────────────────────
app.get('/api/candles/:symbol',(req,res)=>{
  const sym=req.params.symbol.toUpperCase();
  const d=store[sym];
  if(!d) return res.status(404).json({ok:false,error:'Symbol not found'});
  const candles=(d.m15||[]).slice(-120);
  if(!candles.length) return res.status(404).json({ok:false,error:'No candle data'});
  res.json({ok:true,symbol:sym,candles});
});

// ── HISTORY ───────────────────────────────────────────────────────
app.get('/api/history',async(req,res)=>{
  if(!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'Turso not configured'});
  try {
    const limit=parseInt(req.query.limit)||200;
    const rows=await db.execute({sql:`SELECT id,symbol,signal,entry,tp,sl,confidence,outcome,pnl_pct,reasoning,created_at FROM signals ORDER BY id DESC LIMIT ?`,args:[limit]});
    const total=rows.rows.length,wins=rows.rows.filter(r=>r.outcome==='WIN').length,losses=rows.rows.filter(r=>r.outcome==='LOSS').length;
    res.json({ok:true,data:rows.rows,stats:{total,wins,losses,winRate:total?(wins/total*100).toFixed(1)+'%':'N/A'}});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

// ── AI EXIT CHECK — server evaluates open positions for smart exit ──
// Called every cycle with open positions — AI decides if any should exit NOW
// Based on: trend reversal, RSI extreme, MACD death cross, momentum loss
app.post('/api/exit-check', async(req,res) => {
  if(!CLAUDE_KEY) return res.json({ok:true, exits:[]});
  const {positions} = req.body; // [{symbol, direction, entry, current_pnl_pct, sl, tp}]
  if(!positions||!positions.length) return res.json({ok:true, exits:[]});

  try {
    // Build position data with current indicators
    const posData = positions.map(p => {
      const coin = marketCache.find(c=>c.symbol===p.symbol);
      if(!coin) return null;
      const m15=coin.m15, h1=coin.h1;
      if(!m15||!h1) return null;

      // Check for reversal signals
      const reversalSignals = [];
      if(p.direction==='LONG') {
        if(h1.rsi>75) reversalSignals.push(`RSI overbought ${h1.rsi}`);
        if(h1.macdCrossDn) reversalSignals.push('MACD death cross h1');
        if(m15.macdCrossDn) reversalSignals.push('MACD death cross 15m');
        if(h1.trend==='DOWN') reversalSignals.push('h1 trend flipped DOWN');
        if(m15.pattern==='BEAR_ENGULF'||m15.pattern==='EVENING_STAR'||m15.pattern==='SHOOT_STAR') reversalSignals.push(`bearish pattern: ${m15.pattern}`);
        if(h1.stochCrossDn&&h1.stochK>70) reversalSignals.push(`Stoch cross down from ${h1.stochK}`);
      } else {
        if(h1.rsi<25) reversalSignals.push(`RSI oversold ${h1.rsi}`);
        if(h1.macdCrossUp) reversalSignals.push('MACD golden cross h1');
        if(m15.macdCrossUp) reversalSignals.push('MACD golden cross 15m');
        if(h1.trend==='UP') reversalSignals.push('h1 trend flipped UP');
        if(m15.pattern==='BULL_ENGULF'||m15.pattern==='MORNING_STAR'||m15.pattern==='HAMMER') reversalSignals.push(`bullish pattern: ${m15.pattern}`);
        if(h1.stochCrossUp&&h1.stochK<30) reversalSignals.push(`Stoch cross up from ${h1.stochK}`);
      }
      return {
        symbol: p.symbol,
        direction: p.direction,
        pnl_pct: p.current_pnl_pct,
        entry: p.entry,
        current_price: coin.price,
        sl: p.sl, tp: p.tp,
        reversal_signals: reversalSignals,
        h1_trend: h1.trend, h1_rsi: h1.rsi,
        m15_trend: m15.trend, m15_rsi: m15.rsi,
        macd_bull: h1.macdBull, mom: m15.mom10
      };
    }).filter(Boolean);

    if(!posData.length) return res.json({ok:true, exits:[]});

    // Only ask Claude if there are reversal signals (save API calls)
    const hasReversal = posData.some(p=>p.reversal_signals.length>=2);
    if(!hasReversal) return res.json({ok:true, exits:[], reason:'No reversal signals detected'});

    const posLines = posData.map(p=>{
      const sign = p.pnl_pct>0?'+':'';
      const pnl = sign+parseFloat(p.pnl_pct||0).toFixed(2)+'%';
      const revs = p.reversal_signals.join(', ')||'none';
      return p.symbol+' '+p.direction+' PnL:'+pnl+
        ' h1['+p.h1_trend+' RSI='+p.h1_rsi+' MACD='+(p.macd_bull?'BULL':'BEAR')+']'+
        ' m15['+p.m15_trend+' RSI='+p.m15_rsi+' mom='+p.mom+'%]'+
        ' | Reversals: '+revs;
    }).join('\n');
    const exitPrompt = 'NEXUS exit manager. Evaluate open positions for early exit.\n'+
      'EXIT: if 2+ reversal signals AND profit>0.5% to protect or stop loss justified.\n'+
      'HOLD: if trending normally, minor pullback, noise.\n\n'+
      'POSITIONS:\n'+posLines+'\n\n'+
      'JSON: {"exits":[{"symbol":"X","reason":"specific reason"}],"hold":[{"symbol":"Y","reason":"why hold"}]}'


    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: 'claude-haiku-4-5-20251001', // Fast model for exit checks
      max_tokens: 500,
      system: 'You are a precise exit manager. Return ONLY raw JSON. Be conservative — only exit with strong evidence.',
      messages: [{role:'user', content: exitPrompt}]
    }, {
      headers: {'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      timeout: 15000
    });

    const text = r.data.content[0]?.text||'';
    const m = text.match(/\{[\s\S]*\}/);
    if(!m) return res.json({ok:true, exits:[]});
    const parsed = JSON.parse(m[0]);
    res.json({ok:true, exits: parsed.exits||[], hold: parsed.hold||[]});
  } catch(e) {
    console.error('exit-check error:', e.message);
    res.json({ok:true, exits:[]}); // fail safe — don't exit on error
  }
});

// Agent memory restore — returns last 500 WIN/LOSS/EXPIRED signals
// Frontend uses this to rebuild EMA and signalMemory on page load
app.get('/api/signals/history', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:true, signals:[]});
  try {
    const rows = await db.execute({
      sql: `SELECT symbol, signal as direction, confidence, outcome, pnl_pct, reasoning,
                   created_at, evaluated_at
            FROM signals
            WHERE outcome IN ('WIN','LOSS')
              AND pnl_pct IS NOT NULL
            ORDER BY id DESC LIMIT 500`,
      args: []
    });
    res.json({ok:true, signals: rows.rows});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Mark rejected signals as SKIPPED (frontend calls after cycle to prevent NULL pile-up)
app.post('/api/signals/skip', async(req,res) => {
  if (!process.env.TURSO_DATABASE_URL) return res.json({ok:true});
  try {
    const {symbols} = req.body;
    if (!Array.isArray(symbols)||!symbols.length) return res.json({ok:true,skipped:0});
    const placeholders = symbols.map(()=>'?').join(',');
    const result = await db.execute({
      sql: `UPDATE signals SET outcome='SKIPPED'
            WHERE symbol IN (${placeholders})
              AND outcome='PENDING'
              AND evaluated_at IS NULL
              AND created_at > datetime('now','-10 minutes')`,
      args: symbols
    });
    res.json({ok:true, skipped: Number(result.rowsAffected||0)});
  } catch(e) { res.status(500).json({ok:false,error:e.message}); }
});

// Frontend calls this to decide spot vs futures before placing trade
app.post('/api/decide-trade-type',(req,res)=>{
  const {symbol} = req.body;
  const coin = marketCache.find(c=>c.symbol===symbol);
  const decision = decideTradeType(coin);
  res.json({ok:true, ...decision, symbol});
});

// ── APPROVED COINS (auto-backtest results) ───────────────────────
// { symbol: { wr, totalPnl, trades, tradeType, avgAtr, lastRun } }
let approvedCoins = {};

// Core backtest function — reused by both API route and auto-backtest
async function runBacktestForCoin(symbol, days=60, slPct=2, tpPct=5, aggressive=false) {
  const mins15 = Math.min(Math.ceil(days*24*4), 240);  // LITE: 50% API reduction
  const mins60  = Math.min(Math.ceil(days*24),   240);  // LITE: 50% API reduction
  // LITE MODE: Skip 4hour (mins240) and 1day (mins1d) - saves 2 API calls

  let m15=[], h1=[];  // LITE: Skip h4 and d1
  try {
    m15 = await loadCandles(symbol,'15min',mins15); await sleep(300);
    h1  = await loadCandles(symbol,'1hour', mins60);  // LITE: 2 API calls only
  } catch(e) { return null; }

  if(m15.length < 60) return null;

  const trades = [];
  const LOOKBACK = 60;
  let i = LOOKBACK, inTrade = false, trade = null, cooldown = 0;
  let totalAtr = 0, atrCount = 0;

  while(i < m15.length - 1) {
    i++;
    if(cooldown > 0){ cooldown--; continue; }
    const curTime = m15[i-1].time;
    const cur15 = m15.slice(0, i);
    const cur_h1 = h1.filter(c=>c.time <= curTime);
    // LITE MODE: h4 and d1 removed (saves 2 API calls)
    if(cur_h1.length < 10) continue;
    const snap15 = tfSnapshot(cur15);
    const snapH1 = tfSnapshot(cur_h1);
    if(!snap15||!snapH1) continue;  // LITE: Only 2 timeframes
    const price = m15[i-1].close;
    // Track average ATR for futures decision
    if(snap15.atr) { totalAtr += snap15.atr; atrCount++; }

    if(!inTrade) {
      const coin = { symbol, price, m15:snap15, h1:snapH1, h4:snapH1, d1:snapH1 };  // LITE: Reuse h1
      const pf = preFilter(coin, aggressive);
      const minScore = aggressive ? 50 : 65;
      if(pf.score >= minScore && pf.direction) {
        const dir = pf.direction;
        const sl = dir==='LONG' ? price*(1-slPct/100) : price*(1+slPct/100);
        const tp = dir==='LONG' ? price*(1+tpPct/100) : price*(1-tpPct/100);
        trade = { dir, entry:price, sl, tp, entryIdx:i };
        inTrade = true;
      }
    } else {
      const candle = m15[i-1];
      let exitReason=null, exitPrice=price;
      if(trade.dir==='LONG'){
        if(candle.low<=trade.sl){ exitReason='SL'; exitPrice=trade.sl; }
        else if(candle.high>=trade.tp){ exitReason='TP'; exitPrice=trade.tp; }
      } else {
        if(candle.high>=trade.sl){ exitReason='SL'; exitPrice=trade.sl; }
        else if(candle.low<=trade.tp){ exitReason='TP'; exitPrice=trade.tp; }
      }
      if(!exitReason && (i-trade.entryIdx) >= 48){ exitReason='TIMEOUT'; exitPrice=price; }
      if(exitReason){
        const pnl = trade.dir==='LONG'
          ? (exitPrice-trade.entry)/trade.entry*100
          : (trade.entry-exitPrice)/trade.entry*100;
        trades.push({ dir:trade.dir, pnl:parseFloat(pnl.toFixed(2)), reason:exitReason });
        inTrade=false; trade=null; cooldown=4;
      }
    }
  }

  const total = trades.length;
  if(total < 5) return null; // not enough trades to judge
  const wins = trades.filter(t=>t.pnl>0).length;
  const wr = parseFloat((wins/total*100).toFixed(1));
  const totalPnl = parseFloat(trades.reduce((s,t)=>s+t.pnl,0).toFixed(2));
  const avgAtr = atrCount > 0 ? parseFloat((totalAtr/atrCount).toFixed(2)) : 0;
  // Decide trade type based on WR + avg ATR
  const tradeType = (wr >= 62 && avgAtr > 1.5) ? 'futures' : 'spot';
  return { wr, totalPnl, total, wins, avgAtr, tradeType,
    equityCurve: trades.reduce((arr,t)=>{ arr.push(parseFloat((arr.at(-1)+t.pnl).toFixed(2))); return arr; },[100]),
    trades: trades.slice(-30)
  };
}

// Auto-backtest top 50 coins and build approved list
async function autoBacktest() {
  console.log('[BACKTEST] Auto-backtest starting for top 50 coins...');
  const top50 = marketCache.slice(0,50).map(c=>c.symbol);
  if(!top50.length){ console.log('[BACKTEST] No market data yet, skipping'); return; }

  let approved=0, skipped=0;
  for(const sym of top50){
    try {
      const result = await runBacktestForCoin(sym, 60, 2, 5, false);
      if(result && result.wr >= 52){
        approvedCoins[sym] = { ...result, lastRun: Date.now() };
        approved++;
        console.log(`[BACKTEST] ✅ ${sym}: WR=${result.wr}% PnL=${result.totalPnl}% type=${result.tradeType}`);
      } else {
        skipped++;
        if(approvedCoins[sym]) delete approvedCoins[sym]; // remove if previously approved
      }
    } catch(e){ skipped++; }
    await sleep(500); // rate limit spacing
  }
  console.log(`[BACKTEST] Done: ${approved} approved, ${skipped} skipped`);
}

// ── BACKTEST API ROUTES ───────────────────────────────────────────
// Manual backtest for a specific coin (UI use)
app.post('/api/backtest', async(req,res) => {
  try {
    const { symbol, days=90, aggressive=false, slPct=2, tpPct=5 } = req.body;
    if(!symbol) return res.status(400).json({ok:false,error:'symbol required'});
    console.log(`[BACKTEST] Manual: ${symbol} ${days}d`);
    const result = await runBacktestForCoin(symbol, days, slPct, tpPct, aggressive);
    if(!result) return res.status(400).json({ok:false,error:'Not enough data or trades'});
    const maxDD = Math.min(...result.trades.map(t=>t.pnl));
    const bestTrade = Math.max(...result.trades.map(t=>t.pnl));
    res.json({ok:true, symbol, days, ...result,
      losses: result.total - result.wins,
      maxDD: parseFloat(maxDD.toFixed(2)),
      bestTrade: parseFloat(bestTrade.toFixed(2)),
      avgPnl: parseFloat((result.totalPnl/result.total).toFixed(2))
    });
  } catch(e) {
    console.error('[BACKTEST] error:', e.message);
    res.status(500).json({ok:false, error:e.message});
  }
});

// Get approved coins list
app.get('/api/backtest/approved', (req,res) => {
  const list = Object.entries(approvedCoins)
    .map(([sym,d])=>({ symbol:sym, wr:d.wr, totalPnl:d.totalPnl, total:d.total, tradeType:d.tradeType, avgAtr:d.avgAtr }))
    .sort((a,b)=>b.wr-a.wr);
  res.json({ ok:true, approved:list, total:list.length, lastRun: list.length>0 ? approvedCoins[list[0]?.symbol]?.lastRun : null });
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SETTINGS
// ═══════════════════════════════════════════════════════════════
let notifConfig = {
  onTradeOpen:   true,
  onTradeClose:  true,
  onSLHit:       true,
  onTPHit:       true,
  onRiskBlock:   true,
  onDailyReport: true,   // daily summary at midnight
  minPnLAlert:   0       // only alert if |pnl| >= this %
};

// Override sendTelegram to respect notification settings
const _origSendTg = sendTelegram;
async function sendTelegramFiltered(msg, type='general') {
  const typeMap = {
    'trade_open':   notifConfig.onTradeOpen,
    'trade_close':  notifConfig.onTradeClose,
    'sl_hit':       notifConfig.onSLHit,
    'tp_hit':       notifConfig.onTPHit,
    'risk_block':   notifConfig.onRiskBlock,
    'general':      true
  };
  if(typeMap[type] === false) return;
  return _origSendTg(msg);
}

// ── PERFORMANCE REPORT API ───────────────────────────────────────
app.get('/api/performance/report', async(req,res)=>{
  if(!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'No DB'});
  try {
    // All closed signals
    const all = await db.execute({
      sql:`SELECT symbol,signal,pnl_pct,outcome,confidence,trade_type,created_at,evaluated_at
           FROM signals WHERE outcome IN ('WIN','LOSS') ORDER BY id DESC LIMIT 200`,
      args:[]
    });
    const rows = all.rows;
    if(!rows.length) return res.json({ok:true, empty:true});

    const wins   = rows.filter(r=>r.outcome==='WIN');
    const losses = rows.filter(r=>r.outcome==='LOSS');
    const total  = rows.length;
    const wr     = parseFloat((wins.length/total*100).toFixed(1));
    const totalPnl = parseFloat(rows.reduce((s,r)=>s+(r.pnl_pct||0),0).toFixed(2));
    const avgWin   = wins.length  ? parseFloat((wins.reduce((s,r)=>s+(r.pnl_pct||0),0)/wins.length).toFixed(2)) : 0;
    const avgLoss  = losses.length? parseFloat((losses.reduce((s,r)=>s+Math.abs(r.pnl_pct||0),0)/losses.length).toFixed(2)) : 0;
    const bestTrade  = rows.length ? parseFloat(Math.max(...rows.map(r=>r.pnl_pct||0)).toFixed(2)) : 0;
    const worstTrade = rows.length ? parseFloat(Math.min(...rows.map(r=>r.pnl_pct||0)).toFixed(2)) : 0;
    const profitFactor = avgLoss > 0 ? parseFloat((avgWin/avgLoss).toFixed(2)) : null;

    // Sharpe Ratio (simplified — pnl_pct as returns)
    const pnls = rows.map(r=>r.pnl_pct||0);
    const mean = pnls.reduce((s,v)=>s+v,0)/pnls.length;
    const variance = pnls.reduce((s,v)=>s+Math.pow(v-mean,2),0)/pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? parseFloat((mean/stdDev).toFixed(2)) : null;

    // Per symbol stats
    const bySymbol = {};
    rows.forEach(r=>{
      if(!bySymbol[r.symbol]) bySymbol[r.symbol]={wins:0,losses:0,pnl:0,trades:0};
      bySymbol[r.symbol].trades++;
      bySymbol[r.symbol].pnl += r.pnl_pct||0;
      if(r.outcome==='WIN') bySymbol[r.symbol].wins++;
      else bySymbol[r.symbol].losses++;
    });
    const symbolStats = Object.entries(bySymbol)
      .map(([sym,d])=>({symbol:sym, trades:d.trades, wr:parseFloat((d.wins/d.trades*100).toFixed(1)), pnl:parseFloat(d.pnl.toFixed(2))}))
      .sort((a,b)=>b.wr-a.wr).slice(0,10);

    // By direction
    const longs  = rows.filter(r=>r.signal==='LONG');
    const shorts = rows.filter(r=>r.signal==='SHORT');
    const longWR  = longs.length  ? parseFloat((longs.filter(r=>r.outcome==='WIN').length/longs.length*100).toFixed(1)) : 0;
    const shortWR = shorts.length ? parseFloat((shorts.filter(r=>r.outcome==='WIN').length/shorts.length*100).toFixed(1)) : 0;

    // Equity curve (cumulative pnl_pct)
    let eq=100;
    const equityCurve = rows.slice().reverse().map(r=>{ eq+=r.pnl_pct||0; return parseFloat(eq.toFixed(2)); });

    // Monthly breakdown
    const monthly = {};
    rows.forEach(r=>{
      const d = new Date(r.evaluated_at||r.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if(!monthly[key]) monthly[key]={wins:0,losses:0,pnl:0};
      monthly[key].pnl += r.pnl_pct||0;
      if(r.outcome==='WIN') monthly[key].wins++; else monthly[key].losses++;
    });
    const monthlyArr = Object.entries(monthly).map(([m,d])=>({month:m,wins:d.wins,losses:d.losses,pnl:parseFloat(d.pnl.toFixed(2)),wr:parseFloat((d.wins/(d.wins+d.losses)*100).toFixed(1))})).sort((a,b)=>a.month.localeCompare(b.month));

    res.json({ok:true, total, wins:wins.length, losses:losses.length, wr, totalPnl, avgWin, avgLoss, bestTrade, worstTrade, profitFactor, sharpe, symbolStats, longWR, shortWR, equityCurve, monthlyArr, lastUpdated: new Date().toISOString()});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/notifications/config', (req,res)=>{
  const {onTradeOpen,onTradeClose,onSLHit,onTPHit,onRiskBlock,onDailyReport,minPnLAlert} = req.body;
  if(onTradeOpen   !== undefined) notifConfig.onTradeOpen   = !!onTradeOpen;
  if(onTradeClose  !== undefined) notifConfig.onTradeClose  = !!onTradeClose;
  if(onSLHit       !== undefined) notifConfig.onSLHit       = !!onSLHit;
  if(onTPHit       !== undefined) notifConfig.onTPHit       = !!onTPHit;
  if(onRiskBlock   !== undefined) notifConfig.onRiskBlock   = !!onRiskBlock;
  if(onDailyReport !== undefined) notifConfig.onDailyReport = !!onDailyReport;
  if(minPnLAlert   !== undefined) notifConfig.minPnLAlert   = parseFloat(minPnLAlert)||0;
  console.log('[NOTIF] Config updated:', notifConfig);
  res.json({ok:true, notifConfig});
});

app.get('/api/notifications/config', (req,res)=>res.json({ok:true, notifConfig}));

// ── KELLY + VOLATILITY FILTER API ───────────────────────────────
app.get('/api/kelly', async(req,res)=>{
  const capital = parseFloat(req.query.capital||100);
  const regime  = req.query.regime || 'SIDEWAYS';
  const result  = await calcKellySize(capital, regime);
  res.json({ok:true, kelly:result, config:kellyConfig});
});

app.post('/api/kelly/config', (req,res)=>{
  const {enabled, minPct, maxPct, fraction} = req.body;
  if(enabled !== undefined) kellyConfig.enabled = !!enabled;
  if(minPct !== undefined) kellyConfig.minPct = parseFloat(minPct);
  if(maxPct !== undefined) kellyConfig.maxPct = parseFloat(maxPct);
  if(fraction !== undefined) kellyConfig.fraction = parseFloat(fraction);
  console.log('[KELLY] Config updated:', kellyConfig);
  res.json({ok:true, kellyConfig});
});

app.post('/api/volfilter/config', (req,res)=>{
  const {enabled, minATR, maxATR, minBBWidth, minVolRatio} = req.body;
  if(enabled !== undefined) volFilterConfig.enabled = !!enabled;
  if(minATR !== undefined) volFilterConfig.minATR = parseFloat(minATR);
  if(maxATR !== undefined) volFilterConfig.maxATR = parseFloat(maxATR);
  if(minBBWidth !== undefined) volFilterConfig.minBBWidth = parseFloat(minBBWidth);
  if(minVolRatio !== undefined) volFilterConfig.minVolRatio = parseFloat(minVolRatio);
  console.log('[VOL FILTER] Config updated:', volFilterConfig);
  res.json({ok:true, volFilterConfig});
});

// ── RISK MANAGEMENT API ─────────────────────────────────────────
app.get('/api/risk/status', async(req,res)=>{
  let openCount = 0;
  try { const r = await db.execute({sql:`SELECT COUNT(*) as cnt FROM active_trades WHERE status='OPEN'`,args:[]}); openCount = r.rows[0]?.cnt||0; } catch(e){}
  const riskStatus = !riskConfig.enabled ? 'DISABLED'
    : dailyStats.dailyPnL <= riskConfig.dailyLossLimit ? 'DANGER'
    : dailyStats.dailyPnL <= riskConfig.dailyLossLimit * 0.6 ? 'WARNING'
    : openCount >= riskConfig.maxOpenPositions ? 'WARNING'
    : 'SAFE';
  res.json({ok:true, riskConfig, dailyPnL:dailyStats.dailyPnL, openPositions:openCount, riskStatus, closedToday:dailyStats.closedPnL.length});
});

app.post('/api/risk/config', (req,res)=>{
  const {dailyLossLimit, maxOpenPositions, maxDrawdown, atrSLMultiplier, enabled} = req.body;
  if(dailyLossLimit !== undefined) riskConfig.dailyLossLimit = parseFloat(dailyLossLimit);
  if(maxOpenPositions !== undefined) riskConfig.maxOpenPositions = parseInt(maxOpenPositions);
  if(maxDrawdown !== undefined) riskConfig.maxDrawdown = parseFloat(maxDrawdown);
  if(atrSLMultiplier !== undefined) riskConfig.atrSLMultiplier = parseFloat(atrSLMultiplier);
  if(enabled !== undefined) riskConfig.enabled = !!enabled;
  console.log('[RISK] Config updated:', riskConfig);
  sendTelegramFiltered(`⚙️ <b>Risk Config Updated</b>\nDaily Limit: $${riskConfig.dailyLossLimit} | Max Pos: ${riskConfig.maxOpenPositions} | Max DD: ${riskConfig.maxDrawdown}% | ATR Mult: ${riskConfig.atrSLMultiplier}`, 'general');
  res.json({ok:true, riskConfig});
});

// Test Telegram
app.get('/api/telegram/test', async(req,res)=>{
  if(!TG_TOKEN||!TG_CHAT) return res.json({ok:false,error:'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in env'});
  await sendTelegramFiltered('🤖 <b>NEXUS PRO</b> connected! Notifications active ✅', 'general');
  res.json({ok:true, msg:'Test message sent'});
});

// ═══════════════════════════════════════════════════════════════
// GRID BOT — Sideways market range trading
// ═══════════════════════════════════════════════════════════════
let gridBots = {}; // { symbol: { low, high, grids, sizePerGrid, orders[], running, profit } }

function createGridLevels(low, high, grids) {
  const step = (high - low) / grids;
  return Array.from({length: grids + 1}, (_, i) => parseFloat((low + i * step).toFixed(8)));
}

async function startGridBot(symbol, low, high, grids, totalUsdt) {
  if(gridBots[symbol]?.running) return {ok:false, error:'Grid already running for '+symbol};
  const levels = createGridLevels(low, high, grids);
  const sizePerGrid = totalUsdt / grids;
  const coin = marketCache.find(c=>c.symbol===symbol);
  if(!coin) return {ok:false, error:'Coin not found in market data'};
  const currentPrice = coin.price;

  gridBots[symbol] = {
    symbol, low, high, grids, levels, sizePerGrid, totalUsdt,
    currentPrice, running: true, profit: 0, trades: 0,
    orders: [], startTime: Date.now(), startPrice: currentPrice
  };
  console.log(`[GRID] Started ${symbol} Low:${low} High:${high} Grids:${grids} Size:$${sizePerGrid.toFixed(2)}/grid`);
  sendTelegramFiltered(`🔲 <b>GRID BOT STARTED</b>
<b>${symbol}</b> Range: $${low} - $${high}
Grids: ${grids} | Size/Grid: $${sizePerGrid.toFixed(2)}`);
  return {ok:true};
}

function stopGridBot(symbol) {
  if(!gridBots[symbol]) return {ok:false, error:'No grid for '+symbol};
  const g = gridBots[symbol];
  g.running = false;
  const runtime = Math.round((Date.now() - g.startTime) / 60000);
  sendTelegramFiltered(`🔲 <b>GRID BOT STOPPED</b>
<b>${symbol}</b> Profit: $${g.profit.toFixed(2)} | Trades: ${g.trades} | Runtime: ${runtime}min`);
  console.log(`[GRID] Stopped ${symbol} profit=${g.profit.toFixed(2)}`);
  return {ok:true, profit: g.profit, trades: g.trades};
}

// Grid checker — runs every 10s alongside Guardian
async function runGridChecker() {
  for(const [sym, g] of Object.entries(gridBots)) {
    if(!g.running) continue;
    const coin = marketCache.find(c=>c.symbol===sym);
    if(!coin) continue;
    const price = coin.price;
    const prevPrice = g.currentPrice;
    g.currentPrice = price;

    // Check if price crossed any grid level
    for(let i = 0; i < g.levels.length - 1; i++) {
      const buyLevel  = g.levels[i];
      const sellLevel = g.levels[i + 1];

      // Price crossed DOWN through buyLevel — place BUY (paper)
      if(prevPrice > buyLevel && price <= buyLevel) {
        const qty = g.sizePerGrid / price;
        g.orders.push({type:'BUY', price: buyLevel, qty, time: Date.now()});
        console.log(`[GRID] ${sym} BUY @ $${buyLevel} qty=${qty.toFixed(4)}`);
        if(tradingMode==='live') {
          // Place real order
          try {
            await placeMarketOrder(sym, 'buy', g.sizePerGrid);
          } catch(e){ console.error('[GRID] Buy order failed:', e.message); }
        }
      }

      // Price crossed UP through sellLevel — place SELL (paper)
      if(prevPrice < sellLevel && price >= sellLevel) {
        // Find matching buy order
        const buyOrder = g.orders.find(o=>o.type==='BUY' && o.price < sellLevel);
        if(buyOrder) {
          const gridProfit = (sellLevel - buyOrder.price) * buyOrder.qty;
          g.profit += gridProfit;
          g.trades++;
          g.orders = g.orders.filter(o=>o!==buyOrder);
          console.log(`[GRID] ${sym} SELL @ $${sellLevel} profit=$${gridProfit.toFixed(4)} total=$${g.profit.toFixed(4)}`);
          if(tradingMode==='live') {
            try {
              await placeMarketOrder(sym, 'sell', null, buyOrder.qty);
            } catch(e){ console.error('[GRID] Sell order failed:', e.message); }
          }
        }
      }
    }

    // Auto-stop if price goes outside range
    if(price < g.low * 0.97 || price > g.high * 1.03) {
      console.log(`[GRID] ${sym} price ${price} outside range — auto-stopping`);
      sendTelegramFiltered(`⚠️ <b>GRID AUTO-STOPPED</b>
<b>${sym}</b> price $${price} outside range ($${g.low}-$${g.high})
Profit: $${g.profit.toFixed(2)}`);
      g.running = false;
    }
  }
}

// Grid Bot API routes
app.post('/api/grid/start', async(req,res)=>{
  try {
    const {symbol, low, high, grids=10, totalUsdt=100} = req.body;
    if(!symbol||!low||!high) return res.status(400).json({ok:false,error:'symbol, low, high required'});
    if(low>=high) return res.status(400).json({ok:false,error:'low must be less than high'});
    if(grids<3||grids>50) return res.status(400).json({ok:false,error:'grids must be 3-50'});
    const result = await startGridBot(symbol, parseFloat(low), parseFloat(high), parseInt(grids), parseFloat(totalUsdt));
    res.json(result);
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/grid/stop', (req,res)=>{
  const {symbol} = req.body;
  if(!symbol) return res.status(400).json({ok:false,error:'symbol required'});
  res.json(stopGridBot(symbol));
});

app.get('/api/grid/status', (req,res)=>{
  const bots = Object.values(gridBots).map(g=>({
    symbol:g.symbol, running:g.running, low:g.low, high:g.high,
    grids:g.grids, profit:parseFloat(g.profit.toFixed(4)),
    trades:g.trades, currentPrice:g.currentPrice,
    sizePerGrid:parseFloat(g.sizePerGrid.toFixed(2)),
    runtime: Math.round((Date.now()-g.startTime)/60000)
  }));
  res.json({ok:true, bots});
});

// ═══════════════════════════════════════════════════════════════
// TRADINGVIEW WEBHOOK
// ═══════════════════════════════════════════════════════════════
// TradingView alert URL: https://nexus-3c9q.onrender.com/api/webhook/tv
// Alert message format: {"symbol":"BTC","action":"BUY","price":75000,"sl":73000,"tp":78000,"secret":"YOUR_SECRET"}
const TV_SECRET = process.env.TV_WEBHOOK_SECRET || 'nexus_tv_2024';

app.post('/api/webhook/tv', async(req,res)=>{
  try {
    const {symbol, action, price, sl, tp, secret, confidence=7.5} = req.body;
    // Auth check
    if(secret !== TV_SECRET) return res.status(403).json({ok:false,error:'Invalid secret'});
    if(!symbol||!action) return res.status(400).json({ok:false,error:'symbol and action required'});

    const dir = action.toUpperCase()==='BUY'||action.toUpperCase()==='LONG' ? 'LONG' : 'SHORT';
    const coinPrice = price || marketCache.find(c=>c.symbol===symbol)?.price;
    if(!coinPrice) return res.status(400).json({ok:false,error:'Price not found'});

    const slPct  = sl  ? Math.abs((coinPrice-sl)/coinPrice*100).toFixed(2)  : 2;
    const tpPct  = tp  ? Math.abs((tp-coinPrice)/coinPrice*100).toFixed(2)  : 4;
    const slPrice = sl  || (dir==='LONG' ? coinPrice*(1-slPct/100) : coinPrice*(1+slPct/100));
    const tpPrice = tp  || (dir==='LONG' ? coinPrice*(1+tpPct/100) : coinPrice*(1-tpPct/100));

    console.log(`[TV WEBHOOK] ${symbol} ${dir} @ $${coinPrice} SL:${slPct}% TP:${tpPct}%`);

    // Save signal to DB — use decideTradeType to determine if futures or spot
    try {
      const tvCoin = marketCache.find(c => c.symbol === symbol);
      const tradeDecision = decideTradeType(tvCoin);
      const tvTradeType = tradeDecision.type || 'spot';
      await db.execute({
        sql:`INSERT INTO signals (symbol,signal,entry,tp,sl,confidence,reasoning,outcome,trade_type) VALUES (?,?,?,?,?,?,?,'PENDING',?)`,
        args:[symbol, dir, coinPrice, tpPrice, slPrice, confidence, `TradingView webhook: ${action}`, tvTradeType]
      });
    } catch(e){}

    sendTelegramFiltered(`📡 <b>TV WEBHOOK</b> ${dir} <b>${symbol}</b>
@ $${coinPrice} | SL: $${slPrice} | TP: $${tpPrice}`);
    res.json({ok:true, symbol, direction:dir, entry:coinPrice, sl:slPrice, tp:tpPrice});
  } catch(e){
    console.error('[TV WEBHOOK] Error:', e.message);
    res.status(500).json({ok:false,error:e.message});
  }
});

// ═══════════════════════════════════════════════════════════════
// NOTIFICATION SETTINGS
// ═══════════════════════════════════════════════════════════════

// Override sendTelegram to respect notification settings
// ── PERFORMANCE REPORT API ───────────────────────────────────────
app.get('/api/performance/report', async(req,res)=>{
  if(!process.env.TURSO_DATABASE_URL) return res.json({ok:false,error:'No DB'});
  try {
    // All closed signals
    const all = await db.execute({
      sql:`SELECT symbol,signal,pnl_pct,outcome,confidence,trade_type,created_at,evaluated_at
           FROM signals WHERE outcome IN ('WIN','LOSS') ORDER BY id DESC LIMIT 200`,
      args:[]
    });
    const rows = all.rows;
    if(!rows.length) return res.json({ok:true, empty:true});

    const wins   = rows.filter(r=>r.outcome==='WIN');
    const losses = rows.filter(r=>r.outcome==='LOSS');
    const total  = rows.length;
    const wr     = parseFloat((wins.length/total*100).toFixed(1));
    const totalPnl = parseFloat(rows.reduce((s,r)=>s+(r.pnl_pct||0),0).toFixed(2));
    const avgWin   = wins.length  ? parseFloat((wins.reduce((s,r)=>s+(r.pnl_pct||0),0)/wins.length).toFixed(2)) : 0;
    const avgLoss  = losses.length? parseFloat((losses.reduce((s,r)=>s+Math.abs(r.pnl_pct||0),0)/losses.length).toFixed(2)) : 0;
    const bestTrade  = rows.length ? parseFloat(Math.max(...rows.map(r=>r.pnl_pct||0)).toFixed(2)) : 0;
    const worstTrade = rows.length ? parseFloat(Math.min(...rows.map(r=>r.pnl_pct||0)).toFixed(2)) : 0;
    const profitFactor = avgLoss > 0 ? parseFloat((avgWin/avgLoss).toFixed(2)) : null;

    // Sharpe Ratio (simplified — pnl_pct as returns)
    const pnls = rows.map(r=>r.pnl_pct||0);
    const mean = pnls.reduce((s,v)=>s+v,0)/pnls.length;
    const variance = pnls.reduce((s,v)=>s+Math.pow(v-mean,2),0)/pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? parseFloat((mean/stdDev).toFixed(2)) : null;

    // Per symbol stats
    const bySymbol = {};
    rows.forEach(r=>{
      if(!bySymbol[r.symbol]) bySymbol[r.symbol]={wins:0,losses:0,pnl:0,trades:0};
      bySymbol[r.symbol].trades++;
      bySymbol[r.symbol].pnl += r.pnl_pct||0;
      if(r.outcome==='WIN') bySymbol[r.symbol].wins++;
      else bySymbol[r.symbol].losses++;
    });
    const symbolStats = Object.entries(bySymbol)
      .map(([sym,d])=>({symbol:sym, trades:d.trades, wr:parseFloat((d.wins/d.trades*100).toFixed(1)), pnl:parseFloat(d.pnl.toFixed(2))}))
      .sort((a,b)=>b.wr-a.wr).slice(0,10);

    // By direction
    const longs  = rows.filter(r=>r.signal==='LONG');
    const shorts = rows.filter(r=>r.signal==='SHORT');
    const longWR  = longs.length  ? parseFloat((longs.filter(r=>r.outcome==='WIN').length/longs.length*100).toFixed(1)) : 0;
    const shortWR = shorts.length ? parseFloat((shorts.filter(r=>r.outcome==='WIN').length/shorts.length*100).toFixed(1)) : 0;

    // Equity curve (cumulative pnl_pct)
    let eq=100;
    const equityCurve = rows.slice().reverse().map(r=>{ eq+=r.pnl_pct||0; return parseFloat(eq.toFixed(2)); });

    // Monthly breakdown
    const monthly = {};
    rows.forEach(r=>{
      const d = new Date(r.evaluated_at||r.created_at);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      if(!monthly[key]) monthly[key]={wins:0,losses:0,pnl:0};
      monthly[key].pnl += r.pnl_pct||0;
      if(r.outcome==='WIN') monthly[key].wins++; else monthly[key].losses++;
    });
    const monthlyArr = Object.entries(monthly).map(([m,d])=>({month:m,wins:d.wins,losses:d.losses,pnl:parseFloat(d.pnl.toFixed(2)),wr:parseFloat((d.wins/(d.wins+d.losses)*100).toFixed(1))})).sort((a,b)=>a.month.localeCompare(b.month));

    res.json({ok:true, total, wins:wins.length, losses:losses.length, wr, totalPnl, avgWin, avgLoss, bestTrade, worstTrade, profitFactor, sharpe, symbolStats, longWR, shortWR, equityCurve, monthlyArr, lastUpdated: new Date().toISOString()});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post('/api/notifications/config', (req,res)=>{
  const {onTradeOpen,onTradeClose,onSLHit,onTPHit,onRiskBlock,onDailyReport,minPnLAlert} = req.body;
  if(onTradeOpen   !== undefined) notifConfig.onTradeOpen   = !!onTradeOpen;
  if(onTradeClose  !== undefined) notifConfig.onTradeClose  = !!onTradeClose;
  if(onSLHit       !== undefined) notifConfig.onSLHit       = !!onSLHit;
  if(onTPHit       !== undefined) notifConfig.onTPHit       = !!onTPHit;
  if(onRiskBlock   !== undefined) notifConfig.onRiskBlock   = !!onRiskBlock;
  if(onDailyReport !== undefined) notifConfig.onDailyReport = !!onDailyReport;
  if(minPnLAlert   !== undefined) notifConfig.minPnLAlert   = parseFloat(minPnLAlert)||0;
  console.log('[NOTIF] Config updated:', notifConfig);
  res.json({ok:true, notifConfig});
});

app.get('/api/notifications/config', (req,res)=>res.json({ok:true, notifConfig}));

// ── KELLY + VOLATILITY FILTER API ───────────────────────────────
app.get('/api/kelly', async(req,res)=>{
  const capital = parseFloat(req.query.capital||100);
  const result = await calcKellySize(capital);
  res.json({ok:true, kelly:result, config:kellyConfig});
});

app.post('/api/kelly/config', (req,res)=>{
  const {enabled, minPct, maxPct, fraction} = req.body;
  if(enabled !== undefined) kellyConfig.enabled = !!enabled;
  if(minPct !== undefined) kellyConfig.minPct = parseFloat(minPct);
  if(maxPct !== undefined) kellyConfig.maxPct = parseFloat(maxPct);
  if(fraction !== undefined) kellyConfig.fraction = parseFloat(fraction);
  console.log('[KELLY] Config updated:', kellyConfig);
  res.json({ok:true, kellyConfig});
});

app.post('/api/volfilter/config', (req,res)=>{
  const {enabled, minATR, maxATR, minBBWidth, minVolRatio} = req.body;
  if(enabled !== undefined) volFilterConfig.enabled = !!enabled;
  if(minATR !== undefined) volFilterConfig.minATR = parseFloat(minATR);
  if(maxATR !== undefined) volFilterConfig.maxATR = parseFloat(maxATR);
  if(minBBWidth !== undefined) volFilterConfig.minBBWidth = parseFloat(minBBWidth);
  if(minVolRatio !== undefined) volFilterConfig.minVolRatio = parseFloat(minVolRatio);
  console.log('[VOL FILTER] Config updated:', volFilterConfig);
  res.json({ok:true, volFilterConfig});
});

// ── RISK MANAGEMENT API ─────────────────────────────────────────
app.get('/api/risk/status', async(req,res)=>{
  let openCount = 0;
  try { const r = await db.execute({sql:`SELECT COUNT(*) as cnt FROM active_trades WHERE status='OPEN'`,args:[]}); openCount = r.rows[0]?.cnt||0; } catch(e){}
  const riskStatus = !riskConfig.enabled ? 'DISABLED'
    : dailyStats.dailyPnL <= riskConfig.dailyLossLimit ? 'DANGER'
    : dailyStats.dailyPnL <= riskConfig.dailyLossLimit * 0.6 ? 'WARNING'
    : openCount >= riskConfig.maxOpenPositions ? 'WARNING'
    : 'SAFE';
  res.json({ok:true, riskConfig, dailyPnL:dailyStats.dailyPnL, openPositions:openCount, riskStatus, closedToday:dailyStats.closedPnL.length});
});

app.post('/api/risk/config', (req,res)=>{
  const {dailyLossLimit, maxOpenPositions, maxDrawdown, atrSLMultiplier, enabled} = req.body;
  if(dailyLossLimit !== undefined) riskConfig.dailyLossLimit = parseFloat(dailyLossLimit);
  if(maxOpenPositions !== undefined) riskConfig.maxOpenPositions = parseInt(maxOpenPositions);
  if(maxDrawdown !== undefined) riskConfig.maxDrawdown = parseFloat(maxDrawdown);
  if(atrSLMultiplier !== undefined) riskConfig.atrSLMultiplier = parseFloat(atrSLMultiplier);
  if(enabled !== undefined) riskConfig.enabled = !!enabled;
  console.log('[RISK] Config updated:', riskConfig);
  sendTelegramFiltered(`⚙️ <b>Risk Config Updated</b>\nDaily Limit: $${riskConfig.dailyLossLimit} | Max Pos: ${riskConfig.maxOpenPositions} | Max DD: ${riskConfig.maxDrawdown}% | ATR Mult: ${riskConfig.atrSLMultiplier}`, 'general');
  res.json({ok:true, riskConfig});
});

// Test Telegram
app.get('/api/telegram/test', async(req,res)=>{
  if(!TG_TOKEN||!TG_CHAT) return res.json({ok:false,error:'TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set in env'});
  await sendTelegramFiltered('🤖 <b>NEXUS PRO</b> connected! Notifications active ✅', 'general');
  res.json({ok:true, msg:'Test message sent'});
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.get('/api/health',(req,res)=>{
  const btc=marketCache.find(c=>c.symbol==='BTC');
  res.json({ok:true,coins:marketCache.length,wsConnected,liveCoins:marketCache.filter(c=>c.liveAge<60).length,
    btc:btc?{price:btc.price,h4:btc.h4?.trend,h1:btc.h1?.trend,rsi:btc.h1?.rsi,macd:btc.h1?.macdBull?'BULL':'BEAR'}:null,
    keys:{claude:!!CLAUDE_KEY,news:!!NEWSDATA_KEY,turso:!!process.env.TURSO_DATABASE_URL}});
});
app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
app.use((err,req,res,next)=>res.status(500).json({ok:false,error:String(err.message)}));

// ── START ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════
// CLOSE TRADE — works for both PAPER and LIVE mode
// Paper: just marks DB closed
// Live: cancels KuCoin SL/TP orders + places market close order + marks DB
// ════════════════════════════════════════════════════════════════
async function closeTrade(trade, exitPrice, reason) {
  const isLong = trade.direction === 'LONG';
  const pnlPct = trade.entry_price > 0
    ? parseFloat((((exitPrice - trade.entry_price) / trade.entry_price) * 100 * (isLong ? 1 : -1)).toFixed(2))
    : null;

  // ── LIVE MODE: place actual close order ─────────────────────────
  if(tradingMode === 'live') {
    const isFutures = trade.trade_type === 'futures';
    const exch = trade.exchange || 'kucoin';
    try {
      if(exch === 'bingx') {
        // BingX close
        const qty = trade.size_usdt && trade.entry_price
          ? (trade.size_usdt * (trade.leverage||1)) / trade.entry_price : 0;
        if(qty > 0) {
          if(isFutures) {
            await bxFuturesClose(trade.symbol, trade.direction, qty);
            console.log('[CLOSE] BingX futures close sent');
          } else {
            const closeSide = isLong ? 'sell' : 'buy';
            await bxPlaceOrder(trade.symbol, closeSide, null, qty);
            console.log('[CLOSE] BingX spot close sent');
          }
        }
      } else {
        // KuCoin close
        if(trade.kucoin_sl_id) await cancelKuOrder(trade.kucoin_sl_id).catch(e=>console.log('[CLOSE] Cancel SL:',e.message));
        if(trade.kucoin_tp_id) await cancelKuOrder(trade.kucoin_tp_id).catch(e=>console.log('[CLOSE] Cancel TP:',e.message));
        const closeSide = isLong ? 'sell' : 'buy';
        const qty = trade.size_usdt && trade.entry_price ? trade.size_usdt / trade.entry_price : 0;
        if(qty > 0) {
          const closeId = await placeMarketOrder(trade.symbol, closeSide, null, qty);
          console.log('[CLOSE] KuCoin market order placed:', closeId);
        }
      }
    } catch(e) {
      console.error('[CLOSE] Close order failed:', e.message, '— DB still updated');
    }
  }

  // ── BOTH MODES: update DB ──────────────────────────────────────
  await db.execute({
    sql: `UPDATE active_trades
          SET status='CLOSED', closed_at=CURRENT_TIMESTAMP,
              close_reason=?, close_price=?, pnl_pct=?
          WHERE id=?`,
    args: [reason, parseFloat(exitPrice.toFixed(8)), pnlPct, trade.id]
  });

  // Update signals table — properly link by signal_id to avoid mismatches
  if(pnlPct !== null) {
    const outcome = pnlPct > 0 ? 'WIN' : 'LOSS';
    const tradeType = trade.trade_type || 'spot';
    
    // FIX: Use signal_id from active_trades (direct link) not symbol match
    if(trade.signal_id) {
      await db.execute({
        sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, trade_type=?, evaluated_at=CURRENT_TIMESTAMP
              WHERE id=?`,
        args: [outcome, parseFloat(exitPrice.toFixed(8)), pnlPct, tradeType, trade.signal_id]
      });
      console.log(`[CLOSE] Signal ${trade.signal_id} updated: ${outcome} PnL=${pnlPct}% Type=${tradeType}`);
    } else {
      // Fallback if signal_id missing: use symbol + direction + entry price match (safer)
      await db.execute({
        sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, trade_type=?, evaluated_at=CURRENT_TIMESTAMP
              WHERE symbol=? AND signal=? AND outcome='PENDING'
              AND ABS(entry - ?) < ?
              LIMIT 1`,
        args: [outcome, parseFloat(exitPrice.toFixed(8)), pnlPct, tradeType, 
              trade.symbol, trade.direction, trade.entry_price, 0.01]
      });
      console.log(`[CLOSE] Signal matched by symbol/price: ${outcome} PnL=${pnlPct}% Type=${tradeType}`);
    }

    // Telegram notification — trade closed
    const emoji = pnlPct > 0 ? '✅' : '❌';
    const tgDir = trade.direction==='LONG' ? 'LONG' : 'SHORT';
    const tgType = trade.trade_type==='futures' ? `FUTURES ${trade.leverage||3}x` : 'SPOT';
    sendTelegram(`${emoji} <b>TRADE CLOSED</b> [${tgType}]\n${tgDir} <b>${trade.symbol}</b>\nEntry: $${parseFloat(trade.entry_price).toFixed(4)} → Exit: $${parseFloat(exitPrice).toFixed(4)}\nPnL: <b>${pnlPct > 0 ? '+' : ''}${pnlPct}%</b> | Reason: ${reason}`);
  } else {
    // pnlPct null — still send telegram
    sendTelegram(`🔄 <b>TRADE CLOSED</b>\n${trade.direction} <b>${trade.symbol}</b>\nExit: $${parseFloat(exitPrice).toFixed(4)} | Reason: ${reason}`);
  }

  // Track daily PnL
  if(pnlPct !== null) {
    const pnlDollar = (pnlPct / 100) * (trade.size_usdt || 0);
    dailyStats.dailyPnL = parseFloat((dailyStats.dailyPnL + pnlDollar).toFixed(2));
    dailyStats.closedPnL.push(pnlDollar);
    console.log(`[RISK] Daily PnL updated: $${dailyStats.dailyPnL.toFixed(2)}`);
  }

  console.log('[GUARDIAN]', reason, trade.symbol, trade.direction,
    '@ $'+exitPrice.toFixed(6), 'PnL='+pnlPct+'%',
    tradingMode==='live' ? '(LIVE ORDER SENT)' : '(PAPER)');
}

// ════════════════════════════════════════════════════════════════
// RISK CHECK — returns {ok, reason} before placing trade
function checkRiskLimits(openPositionsCount) {
  if(!riskConfig.enabled) return {ok:true};
  
  // Check daily loss limit
  if(dailyStats.dailyPnL <= riskConfig.dailyLossLimit) {
    return {ok:false, reason:`Daily loss limit hit: $${dailyStats.dailyPnL.toFixed(2)}`};
  }
  
  // Check max open positions
  if(openPositionsCount >= riskConfig.maxOpenPositions) {
    return {ok:false, reason:`Max open positions (${riskConfig.maxOpenPositions}) reached`};
  }
  
  // Check drawdown
  if(dailyStats.lowestEquity < 0) {
    const dd = ((dailyStats.lowestEquity - dailyStats.highestEquity) / dailyStats.highestEquity * 100).toFixed(1);
    if(parseFloat(dd) <= riskConfig.maxDrawdown) {
      return {ok:false, reason:`Max drawdown (${riskConfig.maxDrawdown}%) breached: ${dd}%`};
    }
  }
  
  return {ok:true};
}

// ════════════════════════════════════════════════════════════════
// SMART TRADE GUARDIAN — Full trade management on server
// Runs every 10 seconds, 24/7 — browser/phone state doesn't matter
// Paper + Live both handled — same logic, different execution
// ════════════════════════════════════════════════════════════════
async function smartTradeGuardian() {
  if(!process.env.TURSO_DATABASE_URL || !marketCache.length) return;
  try {
    const rows = await db.execute({
      sql:`SELECT * FROM active_trades WHERE status='OPEN'`, args:[]
    });
    // Log every 60 runs (~10 min) so we know guardian is alive
    if(typeof smartTradeGuardian._tick === 'undefined') smartTradeGuardian._tick = 0;
    smartTradeGuardian._tick++;
    if(smartTradeGuardian._tick % 60 === 1)
      console.log('[GUARDIAN] alive | open trades:', rows.rows.length);
    if(!rows.rows.length) return;

    for(const trade of rows.rows){
      const coin = marketCache.find(c=>c.symbol===trade.symbol);
      if(!coin||!coin.price) continue;

      const price    = coin.price;
      const isLong   = trade.direction==='LONG';
      const entry    = trade.entry_price;
      let   sl       = trade.sl_price;
      let   tp       = trade.tp_price;
      const slPct    = trade.sl_pct || 2;
      const trailAct = 2; // activate trailing at 2% gain (matches frontend default)

      // ── 1. TRAILING STOP — har 1% gain par trail karo ──
      // Har complete 1% step par SL aur TP dono aage badhate hain
      // lockPct = gain ka kitna % lock karein (step-based, 5x multiplier)
      const gainPct = isLong ? (price-entry)/entry*100 : (entry-price)/entry*100;
      if(gainPct >= trailAct){
        // Step: har 1% par next level (1%=1, 2%=2, 3%=3...)
        const gainStep = Math.floor(gainPct); // integer step (1,2,3...)

        // 5x multiplier trail — step ke hisab se lock badhata hai
        // Step 1: lock 20% | Step 2: 35% | Step 3: 50% | Step 4: 65% | Step 5+: 75%
        let lockPct;
        if     (gainStep >= 5) lockPct = gainPct * 0.75;
        else if(gainStep >= 4) lockPct = gainPct * 0.65;
        else if(gainStep >= 3) lockPct = gainPct * 0.50;
        else if(gainStep >= 2) lockPct = gainPct * 0.35;
        else                   lockPct = gainPct * 0.20;

        // TP bhi trail karo — har step par TP distance bhi aage badhao (5x)
        const tpTrailPct = gainStep * 1.0; // har 1% gain par TP 1% aage
        const origTpPct  = trade.tp_pct || 5;
        const newTpPct   = origTpPct + tpTrailPct;

        const breakeven = isLong ? entry*1.001 : entry*0.999;
        let newSL, newTP;
        if(isLong){
          newSL = Math.max(sl, breakeven, price*(1-lockPct/100));
          newTP = Math.max(tp||0, entry*(1+newTpPct/100));
          const slMoved = newSL > sl;
          const tpMoved = newTP > (tp||0);
          if(slMoved || tpMoved){
            if(slMoved) sl = parseFloat(newSL.toFixed(8));
            if(tpMoved) tp = parseFloat(newTP.toFixed(8));
            await db.execute({
              sql:`UPDATE active_trades SET sl_price=?, tp_price=?, trailing=1 WHERE id=?`,
              args:[sl, tp, trade.id]
            });
            console.log('[GUARDIAN] TRAIL LONG '+trade.symbol+
              ' step='+gainStep+'% SL→$'+sl.toFixed(6)+
              ' TP→$'+tp.toFixed(6)+
              ' (gain='+gainPct.toFixed(2)+'% lock='+lockPct.toFixed(1)+'%)');
            // Live mode: update KuCoin stop order
            if(tradingMode==='live' && process.env.KUCOIN_API_KEY && trade.kucoin_sl_id && slMoved) {
              try {
                await cancelKuOrder(trade.kucoin_sl_id).catch(()=>{});
                const qty = trade.size_usdt && trade.entry_price ? trade.size_usdt/trade.entry_price : 0;
                if(qty > 0) {
                  const newSlId = await placeStopOrder(trade.symbol,'sell',sl,qty);
                  await db.execute({sql:`UPDATE active_trades SET kucoin_sl_id=? WHERE id=?`,args:[newSlId,trade.id]});
                }
              } catch(e){ console.error('[GUARDIAN] Trail SL update failed:',e.message); }
            }
          }
        } else {
          newSL = Math.min(sl, breakeven, price*(1+lockPct/100));
          newTP = Math.min(tp||Infinity, entry*(1-newTpPct/100));
          const slMoved = newSL < sl;
          const tpMoved = newTP < (tp||Infinity);
          if(slMoved || tpMoved){
            if(slMoved) sl = parseFloat(newSL.toFixed(8));
            if(tpMoved) tp = parseFloat(newTP.toFixed(8));
            await db.execute({
              sql:`UPDATE active_trades SET sl_price=?, tp_price=?, trailing=1 WHERE id=?`,
              args:[sl, tp, trade.id]
            });
            console.log('[GUARDIAN] TRAIL SHORT '+trade.symbol+
              ' step='+gainStep+'% SL→$'+sl.toFixed(6)+
              ' TP→$'+tp.toFixed(6)+
              ' (gain='+gainPct.toFixed(2)+'% lock='+lockPct.toFixed(1)+'%)');
            // Live mode: update KuCoin stop order
            if(tradingMode==='live' && process.env.KUCOIN_API_KEY && trade.kucoin_sl_id && slMoved) {
              try {
                await cancelKuOrder(trade.kucoin_sl_id).catch(()=>{});
                const qty = trade.size_usdt && trade.entry_price ? trade.size_usdt/trade.entry_price : 0;
                if(qty > 0) {
                  const newSlId = await placeStopOrder(trade.symbol,'buy',sl,qty);
                  await db.execute({sql:`UPDATE active_trades SET kucoin_sl_id=? WHERE id=?`,args:[newSlId,trade.id]});
                }
              } catch(e){ console.error('[GUARDIAN] Trail SL update failed:',e.message); }
            }
          }
        }
      }

      // ── 2. PARTIAL TP1 — close 50% at 60% of TP distance ──
      if(!trade.tp1_hit && tp){
        const tp1 = isLong
          ? entry + (tp-entry)*0.6
          : entry - (entry-tp)*0.6;
        const tp1Hit = isLong ? price>=tp1 : price<=tp1;
        if(tp1Hit){
          const partialPnlPct = parseFloat((gainPct*0.5).toFixed(2));
          const newSlBreak = isLong ? entry*1.002 : entry*0.998;
          await db.execute({
            sql:`UPDATE active_trades SET tp1_hit=1, sl_price=? WHERE id=?`,
            args:[parseFloat(newSlBreak.toFixed(8)), trade.id]
          });
          sl = newSlBreak;
          // Live mode: sell 50% of position at market
          if(tradingMode==='live') {
            try {
              const qty = trade.size_usdt && trade.entry_price ? (trade.size_usdt/trade.entry_price)*0.5 : 0;
              if(qty > 0) {
                const exch = trade.exchange || 'kucoin';
                const isFut = trade.trade_type === 'futures';
                if(exch === 'bingx') {
                  if(isFut) await bxFuturesClose(trade.symbol, trade.direction, qty);
                  else await bxPlaceOrder(trade.symbol, isLong?'sell':'buy', null, qty);
                } else if(process.env.KUCOIN_API_KEY) {
                  await placeMarketOrder(trade.symbol, isLong?'sell':'buy', null, qty);
                }
              }
            } catch(e){ console.error('[GUARDIAN] Partial TP1 order failed:',e.message); }
          }
          console.log('[GUARDIAN] PARTIAL TP1 '+trade.symbol+' @ $'+price.toFixed(6)+' ~'+partialPnlPct+'% SL→breakeven'+(tradingMode==='live'?' (LIVE 50% SOLD)':''));
        }
      }

      // ── 3. FULL EXIT — SL or TP hit ──
      let exitReason = null, exitPrice = price;

      if(isLong){
        if(price <= sl){ exitReason = trade.trailing ? 'TRAIL_SL' : 'STOP_LOSS'; exitPrice=sl; }
        else if(tp && price >= tp){ exitReason='TAKE_PROFIT'; exitPrice=tp; }
      } else {
        if(price >= sl){ exitReason = trade.trailing ? 'TRAIL_SL' : 'STOP_LOSS'; exitPrice=sl; }
        else if(tp && price <= tp){ exitReason='TAKE_PROFIT'; exitPrice=tp; }
      }

      if(exitReason){
        await closeTrade(trade, exitPrice, exitReason);
        continue; // Skip AI check if already exited
      }

      // ── 3.5. SMART EARLY EXIT — loss + momentum against = cut early ──
      // No API call — pure indicator logic, runs every 10s
      // Saves from full SL loss when trade is clearly going wrong
      if(gainPct < 0) {
        const m15e = coin.m15, h1e = coin.h1;
        if(m15e && h1e) {
          const lossPct = Math.abs(gainPct);
          const momentumAgainst = isLong
            ? (h1e.trend==='DOWN' || m15e.mom10 < -0.5)
            : (h1e.trend==='UP'   || m15e.mom10 > 0.5);
          const trendAgainst = isLong
            ? (h1e.trend==='DOWN' && m15e.trend==='DOWN')
            : (h1e.trend==='UP'   && m15e.trend==='UP');
          const macdAgainst = isLong ? !h1e.macdBull : h1e.macdBull;

          // Exit condition: losing AND 2+ confirming signals against direction
          let earlyExitSignals = 0;
          if(momentumAgainst) earlyExitSignals++;
          if(macdAgainst)     earlyExitSignals++;
          if(trendAgainst)    earlyExitSignals++;

          // Cut early if: loss > 1% with strong counter-signals
          // OR loss > 1.5% with any counter-signal (trade is failing)
          const shouldCutEarly =
            (lossPct >= 1.0 && earlyExitSignals >= 2) ||
            (lossPct >= 1.5 && earlyExitSignals >= 1) ||
            (lossPct >= slPct * 0.8); // 80% of SL = cut before full SL hit

          if(shouldCutEarly) {
            const reason = lossPct >= slPct*0.8 ? 'NEAR_SL_CUT'
              : trendAgainst ? 'TREND_REVERSAL'
              : 'MOMENTUM_EXIT';
            console.log('[GUARDIAN] EARLY_EXIT '+trade.symbol+' loss='+gainPct.toFixed(2)+'% signals='+earlyExitSignals+' reason='+reason);
            await closeTrade(trade, price, reason);
            continue;
          }
        }
      }

      // ── 4. AI SMART EXIT — check reversal signals ──
      // Only run AI check every 5 minutes per trade (not every 10s — save API calls)
      const lastAiCheck = trade.last_ai_check || 0;
      if(CLAUDE_KEY && Date.now()-lastAiCheck > 5*60*1000){
        await db.execute({
          sql:`UPDATE active_trades SET last_ai_check=? WHERE id=?`,
          args:[Date.now(), trade.id]
        });
        const m15=coin.m15, h1=coin.h1;
        if(m15&&h1){
          // Check for reversal signals
          const reversals=[];
          if(isLong){
            if(h1.rsi>75)             reversals.push('RSI overbought '+h1.rsi);
            if(h1.macdCrossDn)         reversals.push('MACD death cross h1');
            if(m15.macdCrossDn)        reversals.push('MACD death cross 15m');
            if(h1.trend==='DOWN')      reversals.push('h1 trend flipped DOWN');
            if(['BEAR_ENGULF','EVENING_STAR','SHOOT_STAR'].includes(m15.pattern))
                                       reversals.push('bearish pattern: '+m15.pattern);
          } else {
            if(h1.rsi<25)             reversals.push('RSI oversold '+h1.rsi);
            if(h1.macdCrossUp)         reversals.push('MACD golden cross h1');
            if(m15.macdCrossUp)        reversals.push('MACD golden cross 15m');
            if(h1.trend==='UP')        reversals.push('h1 trend flipped UP');
            if(['BULL_ENGULF','MORNING_STAR','HAMMER'].includes(m15.pattern))
                                       reversals.push('bullish pattern: '+m15.pattern);
          }
          // Only call AI if 2+ reversal signals (save API)
          if(reversals.length>=2){
            try {
              const r = await axios.post('https://api.anthropic.com/v1/messages',{
                model:'claude-haiku-4-5-20251001',
                max_tokens:200,
                system:'Trading exit manager. Return ONLY: {"exit":true,"reason":"..."} OR {"exit":false,"reason":"..."}',
                messages:[{role:'user',content:
                  trade.symbol+' '+trade.direction+' PnL:'+gainPct.toFixed(2)+'%'+
                  ' Entry:$'+entry+' Now:$'+price+' SL:$'+sl+
                  ' | Reversals: '+reversals.join(', ')+
                  ' | h1['+h1.trend+' RSI='+h1.rsi+'] m15['+m15.trend+' RSI='+m15.rsi+']'+
                  ' Should exit now? Only if reversal is strong.'
                }]
              },{
                headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
                timeout:12000
              });
              const txt=r.data.content[0]?.text||'';
              const mj=txt.match(/\{[\s\S]*?\}/);
              if(mj){
                const dec=JSON.parse(mj[0]);
                if(dec.exit===true){
                  await closeTrade(trade, price, 'AI_EXIT');
                }
              }
            } catch(aiErr){ /* AI check failed — trade stays open, safe */ }
          }
        }
      }
    }
  } catch(e){ console.error('[GUARDIAN] Error:',e.message); }
}

app.listen(PORT,async()=>{
  console.log(`NEXUS PRO on port ${PORT}`);
  await initDB();
  await initialLoad();
  setInterval(evaluatePendingSignals,5*60*1000);
  resetDailyStats(); // start midnight reset timer

  // Daily performance report via Telegram
  function scheduleDailyReport(){
    const now = new Date();
    const msToMidnight = new Date(now.getFullYear(),now.getMonth(),now.getDate()+1,0,1,0).getTime() - now.getTime();
    setTimeout(async()=>{
      if(notifConfig.onDailyReport && TG_TOKEN && TG_CHAT){
        try {
          const rows = await db.execute({sql:`SELECT outcome,pnl_pct FROM signals WHERE outcome IN ('WIN','LOSS') AND DATE(evaluated_at)=DATE('now')`,args:[]});
          const today = rows.rows;
          const tw = today.filter(r=>r.outcome==='WIN').length;
          const tl = today.filter(r=>r.outcome==='LOSS').length;
          const tpnl = today.reduce((s,r)=>s+(r.pnl_pct||0),0).toFixed(2);
          sendTelegram(`📊 <b>Daily Report</b>\nTrades: ${tw+tl} | W:${tw} L:${tl}\nWin Rate: ${tw+tl>0?((tw/(tw+tl))*100).toFixed(1):0}%\nTotal PnL: ${tpnl>0?'+':''}${tpnl}%\nDaily Cash PnL: $${dailyStats.dailyPnL.toFixed(2)}`);
        } catch(e){ console.error('[DAILY REPORT]', e.message); }
      }
      scheduleDailyReport(); // recurse
    }, msToMidnight);
  }
  scheduleDailyReport();
  // Grid bot checker — runs every 10s
  setInterval(runGridChecker, 10*1000);

  // Auto-backtest top 50 coins — runs after market data loads
  // First run: 3 min after startup (market data needs time to load)
  setTimeout(async()=>{
    await autoBacktest();
    // Repeat every 6 hours
    setInterval(autoBacktest, 6*60*60*1000);
  }, 3*60*1000);
  // Refresh candle data every 20 min WITHOUT reconnecting WebSocket
  setInterval(async()=>{
    console.log('Refreshing candle data...');
    try {
      // Only reload candles — do NOT call connectWebSocket again
      const exclude=['USDT','USDC','BUSD','DAI','TUSD','3L','3S','2L','2S','UP','DOWN','BEAR','BULL'];
      let kuCoins=[];
      try {
        const r=await axios.get('https://api.kucoin.com/api/v1/market/allTickers',{timeout:10000});
        if(r.data.code==='200000'){
          kuCoins=r.data.data.ticker
            .filter(t=>t.symbol.endsWith('-USDT')&&!exclude.some(e=>t.symbol.replace('-USDT','').includes(e))&&parseFloat(t.volValue)>2000000)
            .sort((a,b)=>parseFloat(b.volValue)-parseFloat(a.volValue))
            .slice(0,70).map(t=>t.symbol.replace('-USDT',''));
        }
      } catch(e){}
      let bxCoins=[];
      try {
        const tickers=await fetchBingXTickers();
        bxCoins=tickers.filter(t=>t.symbol&&t.symbol.endsWith('-USDT')&&!exclude.some(e=>t.symbol.replace('-USDT','').includes(e))&&parseFloat(t.quoteVolume||0)>2000000).sort((a,b)=>parseFloat(b.quoteVolume||0)-parseFloat(a.quoteVolume||0)).slice(0,50).map(t=>t.symbol.replace('-USDT',''));
      } catch(e){}
      const merged=[...new Set([...kuCoins,...bxCoins])];
      if(merged.length) activeSymbols=merged;
      global.bxOnlyCoins=new Set(bxCoins.filter(s=>!kuCoins.includes(s)));
      // Reload candles for all coins
      for(const sym of activeSymbols){
        if(!store[sym]) store[sym]={tick:{},m15:[],h1:[],h4:[],d1:[]};
        try {
          store[sym].m15=await loadCandles(sym,'15min',100); await sleep(300);
          store[sym].h1=await loadCandles(sym,'1hour',100);  await sleep(300);
          store[sym].h4=await loadCandles(sym,'4hour',60);   await sleep(300);
          store[sym].d1=await loadCandles(sym,'1day',60);    await sleep(300);
        } catch(e){}
      }
      buildCache();
      console.log('Candle refresh done:', activeSymbols.length, 'coins');
    } catch(e){ console.error('Candle refresh error:',e.message); }
  }, 20*60*1000);

  // ── SMART TRADE GUARDIAN (every 10s) ─────────────────────────────
  // Runs 24/7 on server — phone band ho, browser close ho, koi fark nahi
  // Handles: Trailing SL, Partial TP, SL/TP exit, Hard DD protection
  setInterval(smartTradeGuardian, 10*1000);
  console.log('[GUARDIAN] Smart Trade Guardian started — checking every 10s');

  // Auto-cleanup stale PENDING signals every 30 minutes — no frontend call needed
  setInterval(async()=>{
    if(!process.env.TURSO_DATABASE_URL) return;
    try {
      const d = await db.execute({
        sql: `DELETE FROM signals
              WHERE outcome = 'PENDING'
                AND created_at < datetime('now', '-30 minutes')
                AND id NOT IN (
                  SELECT DISTINCT signal_id FROM active_trades
                  WHERE status='OPEN' AND signal_id IS NOT NULL
                )`,
        args: []
      });
      if(d.rowsAffected>0) console.log(`Auto-cleanup: ${d.rowsAffected} stale PENDING signals deleted`);
    } catch(e){ console.error('Auto-cleanup error:',e.message); }
  }, 30*60*1000);
  const SELF = process.env.RENDER_EXTERNAL_URL || 'https://nexus-3c9q.onrender.com';
  // Ping every 5 min — Render free tier sleeps after 15 min inactivity
  setInterval(()=>{
    axios.get(`${SELF}/health`, {timeout:8000, httpsAgent})
      .then(()=>console.log('[PING] health ok —', new Date().toISOString()))
      .catch(e=>console.error('[PING] failed:', e.message));
  }, 5*60*1000);
  // Startup ping
  setTimeout(()=>{
    axios.get(`${SELF}/health`, {timeout:10000, httpsAgent})
      .then(()=>console.log('[PING] startup ping ok'))
      .catch(e=>console.error('[PING] startup failed:', e.message));
  }, 5000);
});
