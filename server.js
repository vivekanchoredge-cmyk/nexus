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

    return `\n\nYOUR MEMORY (only verified WIN/LOSS data — no NULL/PENDING noise):\n1. ${symbol} HISTORY (last 200):${streakStr}\n${symLines||'  No history yet'}\n2. SYMBOL WIN RATES (min 2 trades):\n${statsLines||'  No completed trades yet'}\n3. OPEN PENDING TRADES: ${openTrades}\nRULES: <40% winrate=SKIP symbol | same losing pattern=SKIP | 2+ consecutive losses=REDUCE SIZE | >65% winrate=+0.5 conf bonus`;
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

const app  = express();
const PORT = process.env.PORT || 3000;
const CLAUDE_KEY   = process.env.CLAUDE_API_KEY || '';
const NEWSDATA_KEY = process.env.Newsdata || '';

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
function preFilter(coin, aggressive=false) {
  const m15=coin.m15, h1=coin.h1, h4=coin.h4, d1=coin.d1;
  if(!m15||!h1||!h4) return {score:0, reason:'No data'};

  const reasons = [];
  let score = 0;

  // ── Daily trend hard reject (most important filter) ───────────
  // If daily trend is strongly against our setup direction, skip
  const dailyTrend = d1?.trend || 'SIDE';
  const dailyST    = d1?.supertrend?.trend || 'SIDE';

  // ── Hard rejects ──────────────────────────────────────────────
  if(!aggressive){
    if(h4.trend==='SIDE'&&h1.trend==='SIDE') return {score:0, reason:'Both h4+h1 SIDE'};
    if(h4.trend!==h1.trend&&h4.trend!=='SIDE'&&h1.trend!=='SIDE') return {score:0, reason:'h4/h1 conflict'};
    if(m15.atr>5) return {score:0, reason:`ATR too high ${m15.atr}%`};
    if(m15.volRatio<0.9) return {score:0, reason:`Low volume ${m15.volRatio}x`};
  } else {
    if(h4.trend==='SIDE'&&h1.trend==='SIDE'&&m15.trend==='SIDE') return {score:0, reason:'All 3TF SIDE'};
    if(m15.atr>8) return {score:0, reason:`ATR extreme ${m15.atr}%`};
    if(m15.volRatio<0.6) return {score:0, reason:`Volume too low ${m15.volRatio}x`};
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
    const {token,endpoint}=await getWsToken();
    wsConnection=new WebSocket(`${endpoint}?token=${token}&connectId=nexus${Date.now()}`);
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
  console.log('Loading top coins...');
  try {
    const r=await axios.get('https://api.kucoin.com/api/v1/market/allTickers',{timeout:10000});
    if(r.data.code!=='200000') throw new Error('Tickers failed');
    const exclude=['USDT','USDC','BUSD','DAI','TUSD','3L','3S','2L','2S','UP','DOWN','BEAR','BULL'];
    activeSymbols=r.data.data.ticker
      .filter(t=>t.symbol.endsWith('-USDT')&&!exclude.some(e=>t.symbol.replace('-USDT','').includes(e))&&parseFloat(t.volValue)>5000000)
      .sort((a,b)=>parseFloat(b.volValue)-parseFloat(a.volValue))
      .slice(0,65).map(t=>t.symbol.replace('-USDT',''));
    console.log(`Top coins: ${activeSymbols.slice(0,10).join(', ')} ...`);
  } catch(e){
    console.error('Top coins failed:',e.message);
    activeSymbols=['BTC','ETH','BNB','SOL','XRP','DOGE','ADA','AVAX','LINK','DOT'];
  }
  let loaded=0;
  for(const sym of activeSymbols){
    store[sym]={tick:{},m15:[],h1:[],h4:[],d1:[]};
    try {
      store[sym].m15=await loadCandles(sym,'15min',100); await sleep(150);
      store[sym].h1=await loadCandles(sym,'1hour',100);  await sleep(150);
      store[sym].h4=await loadCandles(sym,'4hour',60);   await sleep(150);
      store[sym].d1=await loadCandles(sym,'1day',60);    await sleep(150);
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
  const {symbols, aggressive=false} = req.body;
  const coins = symbols
    ? symbols.map(s=>marketCache.find(c=>c.symbol===s)).filter(Boolean)
    : marketCache.slice(0,20);
  const results = coins.map(coin=>{
    const pf = preFilter(coin, aggressive);
    return {symbol:coin.symbol, ...pf, price:coin.price};
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
    const {prompt,model,aggressive=false} = req.body;
    const knownSyms=activeSymbols.length?activeSymbols:['BTC','ETH','SOL','BNB','XRP'];
    const allMatches=prompt?.match(/\b([A-Z]{2,10})\b/g)||[];
    const promptSymbol=allMatches.find(s=>knownSyms.includes(s))||'N/A';
    const memory=await loadMemory(promptSymbol);

    const r=await axios.post('https://api.anthropic.com/v1/messages',{
      model:model||'claude-sonnet-4-20250514',
      max_tokens:2000,
      system:`You are NEXUS PRO, an elite crypto trading agent optimized for profit.
You receive pre-filtered high-quality setups with advanced indicators (MACD, Bollinger Bands, Stochastic RSI).
These coins already passed a strict pre-filter — your job is to pick the BEST ones and set precise SL/TP.
Return ONLY raw JSON. No markdown.
FORMAT: {"market_read":"...","signals":[{"symbol":"...","direction":"LONG/SHORT","confidence":8.5,"sl_pct":2.0,"tp_pct":5.0,"reason":"..."}],"skip_reason":"..."}
${memory}`,
      messages:[{role:'user',content:prompt}]
    },{
      headers:{'x-api-key':CLAUDE_KEY,'anthropic-version':'2023-06-01','Content-Type':'application/json'},
      timeout:30000
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
          messages:[{role:'user',content:`Fix this to valid JSON with "signals" array and "market_read":\n${text.slice(0,500)}`}]
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
          await db.execute({
            sql:`INSERT INTO signals (symbol,signal,entry,tp,sl,confidence,reasoning) VALUES (?,?,?,?,?,?,?)`,
            args:[sig.symbol,sig.direction,price,tpPrice,slPrice,sig.confidence||null,sig.reason||null]
          });
          console.log(`Signal saved: ${sig.symbol} ${sig.direction} conf=${sig.confidence}`);
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
  res.json({ok:true,mode:tradingMode,keysConfigured:!!(process.env.KUCOIN_API_KEY&&process.env.KUCOIN_API_SECRET&&process.env.KUCOIN_PASSPHRASE)});
});
app.post('/api/mode',(req,res)=>{
  const {mode}=req.body;
  if(!['paper','live'].includes(mode)) return res.status(400).json({ok:false,error:'Mode must be paper or live'});
  if(mode==='live'){
    const missing=['KUCOIN_API_KEY','KUCOIN_API_SECRET','KUCOIN_PASSPHRASE'].filter(k=>!process.env[k]);
    if(missing.length) return res.status(400).json({ok:false,error:`Missing: ${missing.join(', ')}`});
  }
  tradingMode=mode;
  res.json({ok:true,mode});
});

// ── ORDER ROUTES ──────────────────────────────────────────────────
app.post('/api/order',async(req,res)=>{
  if(tradingMode!=='live') return res.json({ok:false,error:'Not in live mode'});
  const missing=['KUCOIN_API_KEY','KUCOIN_API_SECRET','KUCOIN_PASSPHRASE'].filter(k=>!process.env[k]);
  if(missing.length) return res.status(400).json({ok:false,error:`Missing keys: ${missing.join(', ')}`});
  try {
    const {symbol,direction,sizeUsdt,sl,tp,qty}=req.body;
    const side=direction==='LONG'?'buy':'sell';
    const entryId=await placeMarketOrder(symbol,side,sizeUsdt);
    const slSide=direction==='LONG'?'sell':'buy';
    const slId=await placeStopOrder(symbol,slSide,sl,qty);
    const tpId=await placeLimitOrder(symbol,slSide,tp,qty);
    res.json({ok:true,entryId,slId,tpId});
  } catch(e){res.status(500).json({ok:false,error:e.message});}
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
           kucoin_entry_id,kucoin_sl_id,kucoin_tp_id} = req.body;
    if (!symbol||!direction||!entry_price) return res.status(400).json({ok:false,error:'symbol/direction/entry_price required'});
    const result = await db.execute({
      sql: `INSERT INTO active_trades
              (signal_id,symbol,direction,entry_price,tp_price,sl_price,sl_pct,tp_pct,
               confidence,size_usdt,reasoning,trailing,tp1_hit,
               kucoin_entry_id,kucoin_sl_id,kucoin_tp_id,status)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN')`,
      args: [signal_id||null, symbol, direction, entry_price, tp_price||null, sl_price||null,
             sl_pct||null, tp_pct||null, confidence||null, size_usdt||null, reasoning||null,
             trailing?1:0, tp1_hit?1:0,
             kucoin_entry_id||null, kucoin_sl_id||null, kucoin_tp_id||null]
    });
    res.json({ok:true, trade_id: Number(result.lastInsertRowid)});
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
    res.json({ok:true});
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

  // ── LIVE MODE: place actual KuCoin sell/buy order ──────────────
  if(tradingMode === 'live' && process.env.KUCOIN_API_KEY) {
    try {
      // 1. Cancel existing SL/TP orders so they don't double-execute
      if(trade.kucoin_sl_id) await cancelKuOrder(trade.kucoin_sl_id).catch(e => console.log('[CLOSE] Cancel SL failed:',e.message));
      if(trade.kucoin_tp_id) await cancelKuOrder(trade.kucoin_tp_id).catch(e => console.log('[CLOSE] Cancel TP failed:',e.message));
      // 2. Place market close order
      const closeSide = isLong ? 'sell' : 'buy';
      const qty = trade.size_usdt && trade.entry_price ? trade.size_usdt / trade.entry_price : 0;
      if(qty > 0) {
        const closeId = await placeMarketOrder(trade.symbol, closeSide, null, qty);
        console.log('[CLOSE] KuCoin market order placed:', closeId);
      }
    } catch(e) {
      console.error('[CLOSE] KuCoin close failed:', e.message, '— DB still updated');
      // Even if KuCoin fails, continue to update DB (don't leave trade hanging in DB)
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

  // Update signals table for agent learning (WIN/LOSS)
  if(pnlPct !== null) {
    const outcome = pnlPct > 0 ? 'WIN' : 'LOSS';
    await db.execute({
      sql: `UPDATE signals SET outcome=?, exit_price=?, pnl_pct=?, evaluated_at=CURRENT_TIMESTAMP
            WHERE symbol=? AND outcome='PENDING'
            AND id=(SELECT MAX(id) FROM signals WHERE symbol=? AND outcome='PENDING')`,
      args: [outcome, parseFloat(exitPrice.toFixed(8)), pnlPct, trade.symbol, trade.symbol]
    });
  }

  console.log('[GUARDIAN]', reason, trade.symbol, trade.direction,
    '@ $'+exitPrice.toFixed(6), 'PnL='+pnlPct+'%',
    tradingMode==='live' ? '(LIVE ORDER SENT)' : '(PAPER)');
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

      // ── 1. TRAILING STOP ──
      const gainPct = isLong ? (price-entry)/entry*100 : (entry-price)/entry*100;
      if(gainPct >= trailAct){
        // Gap tightens as profit grows — SL always above entry
        let lockPct;
        if     (gainPct >= slPct*2) lockPct = gainPct * 0.70;
        else if(gainPct >= slPct*1) lockPct = gainPct * 0.50;
        else                         lockPct = gainPct * 0.30;

        const breakeven = isLong ? entry*1.001 : entry*0.999;
        let newSL;
        if(isLong){
          newSL = Math.max(sl, breakeven, price*(1-lockPct/100));
          if(newSL > sl){
            sl = parseFloat(newSL.toFixed(8));
            await db.execute({
              sql:`UPDATE active_trades SET sl_price=?, trailing=1 WHERE id=?`,
              args:[sl, trade.id]
            });
            console.log('[GUARDIAN] TRAIL '+trade.symbol+' SL → $'+sl.toFixed(6)+' (gain='+gainPct.toFixed(1)+'% lock='+lockPct.toFixed(1)+'%)');
            // Live mode: update KuCoin stop order
            if(tradingMode==='live' && process.env.KUCOIN_API_KEY && trade.kucoin_sl_id) {
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
          if(newSL < sl){
            sl = parseFloat(newSL.toFixed(8));
            await db.execute({
              sql:`UPDATE active_trades SET sl_price=?, trailing=1 WHERE id=?`,
              args:[sl, trade.id]
            });
            console.log('[GUARDIAN] TRAIL SHORT '+trade.symbol+' SL → $'+sl.toFixed(6)+' (gain='+gainPct.toFixed(1)+'% lock='+lockPct.toFixed(1)+'%)');
            // Live mode: update KuCoin stop order
            if(tradingMode==='live' && process.env.KUCOIN_API_KEY && trade.kucoin_sl_id) {
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
          if(tradingMode==='live' && process.env.KUCOIN_API_KEY) {
            try {
              const qty = trade.size_usdt && trade.entry_price ? (trade.size_usdt/trade.entry_price)*0.5 : 0;
              if(qty > 0) {
                const closeSide = isLong ? 'sell' : 'buy';
                await placeMarketOrder(trade.symbol, closeSide, null, qty);
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
  setInterval(async()=>{await initialLoad();},20*60*1000);

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
  const SELF=process.env.RENDER_EXTERNAL_URL||`http://localhost:${PORT}`;
  // Health ping every 14 min — keeps Render free tier awake
  setInterval(()=>{
    axios.get(`${SELF}/health`,{timeout:5000})
      .then(()=>console.log('[PING] health ok —',new Date().toISOString()))
      .catch(e=>console.error('[PING] failed:',e.message));
  }, 14*60*1000);
  // Also ping immediately on startup to verify URL is correct
  setTimeout(()=>{
    axios.get(`${SELF}/health`,{timeout:10000})
      .then(()=>console.log('[PING] startup ping ok — server staying awake'))
      .catch(e=>console.error('[PING] startup ping failed:',e.message,'SELF=',SELF));
  }, 5000);
});
