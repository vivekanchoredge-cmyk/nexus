/**
 * NEXUS REAL AUTONOMOUS AGENT
 * ===========================
 * Claude API integrated backend
 * Real autonomous trading loop
 * Proper decision making
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ═════════════════════════════════════════════════════════════════
// AGENT STATE - Persistent across cycles
// ═════════════════════════════════════════════════════════════════

let agentState = {
  active: false,
  model: 'claude-sonnet-4-20250514',
  mode: 'demo',
  portfolio: 10000,
  cash: 10000,
  holdings: {},
  ownedCoins: new Set(),
  trades: 0,
  maxPositions: 5,
  tradeHistory: [],
  logs: []
};

// Simulated real-time coin prices (update every minute in production)
const COINS = {
  BTC: { price: 45123, change: 8.5, mcap: 900000000000 },
  ETH: { price: 2850, change: 6.3, mcap: 342000000000 },
  SOL: { price: 102, change: 9.1, mcap: 45000000000 },
  ADA: { price: 0.98, change: 7.2, mcap: 34000000000 },
  XRP: { price: 0.52, change: 10.4, mcap: 28000000000 }
};

// ═════════════════════════════════════════════════════════════════
// CLAUDE API - REAL CALLS
// ═════════════════════════════════════════════════════════════════

async function callClaudeForTradingDecision(analysisData) {
  const apiKey = process.env.CLAUDE_API_KEY;
  
  if (!apiKey) {
    addLog('❌ CLAUDE_API_KEY not set in environment variables', 'error');
    return null;
  }

  const prompt = `You are an autonomous cryptocurrency trading agent.

CURRENT STATE:
- Portfolio Value: $${agentState.portfolio.toFixed(2)}
- Available Cash: $${agentState.cash.toFixed(2)}
- Currently Own: ${Array.from(agentState.ownedCoins).join(', ') || 'Nothing'}
- Max Positions: ${agentState.maxPositions}
- Current Holdings: ${agentState.ownedCoins.size}/${agentState.maxPositions}

MARKET DATA:
${analysisData}

DECISION RULES:
1. Only recommend coins NOT currently owned
2. Only if we have positions available (${agentState.ownedCoins.size} < ${agentState.maxPositions})
3. Recommend only if strong signals
4. Format: "BUY BTC" or "BUY ETH" or "HOLD"

Make ONE decision only.`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: agentState.model,
        max_tokens: 50,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const decision = response.data.content[0].text.trim();
    addLog(`🤖 Claude (${agentState.model}): "${decision}"`, 'claude');
    return decision;
  } catch (error) {
    addLog(`⚠️ Claude Error: ${error.message}`, 'error');
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════
// AGENT LOGIC
// ═════════════════════════════════════════════════════════════════

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  agentState.logs.push(logEntry);
  if (agentState.logs.length > 100) agentState.logs.shift();
  console.log(`[${timestamp}] ${message}`);
}

function analyzeCoin(symbol) {
  const coin = COINS[symbol];
  let score = 0;

  // Momentum
  if (coin.change > 8) score += 35;
  else if (coin.change > 5) score += 25;
  else if (coin.change > 0) score += 15;

  // Market cap
  if (coin.mcap > 100000000000) score += 30;
  else if (coin.mcap > 50000000000) score += 20;
  else if (coin.mcap > 20000000000) score += 10;

  // Volatility
  score += 20;

  return Math.min(100, score);
}

function getMarketAnalysis() {
  let analysis = '📊 MARKET ANALYSIS:\n';
  
  Object.entries(COINS).forEach(([symbol, coin]) => {
    const score = analyzeCoin(symbol);
    const status = agentState.ownedCoins.has(symbol) ? '✓ OWNED' : '📍 Available';
    analysis += `${symbol}: $${coin.price} (${coin.change}%) Score: ${score} - ${status}\n`;
  });

  return analysis;
}

async function autonomousLoop() {
  if (!agentState.active) return;

  addLog('🔄 Starting autonomous analysis cycle...', 'cycle');

  // Step 1: Get market analysis
  const analysis = getMarketAnalysis();
  addLog(analysis, 'analysis');

  // Step 2: Call Claude for decision
  const decision = await callClaudeForTradingDecision(analysis);

  // Step 3: Execute decision
  if (decision) {
    if (decision.includes('BUY')) {
      const match = decision.match(/BTC|ETH|SOL|ADA|XRP/);
      if (match) {
        const coin = match[0];
        if (!agentState.ownedCoins.has(coin) && agentState.ownedCoins.size < agentState.maxPositions) {
          executeBuy(coin);
        } else if (agentState.ownedCoins.has(coin)) {
          addLog(`⏭️ Skip: Already own ${coin}`, 'skip');
        } else {
          addLog(`📍 Max positions reached (${agentState.ownedCoins.size}/${agentState.maxPositions})`, 'skip');
        }
      }
    } else {
      addLog('⏸️ Claude says HOLD', 'hold');
    }
  }

  // Step 4: Schedule next cycle
  setTimeout(autonomousLoop, 10000); // Every 10 seconds
}

function executeBuy(symbol) {
  const coin = COINS[symbol];
  const amount = Math.min(agentState.cash * 0.3, agentState.portfolio * 0.15);

  if (amount < coin.price) {
    addLog(`❌ Insufficient funds for ${symbol}`, 'error');
    return;
  }

  const shares = amount / coin.price;
  agentState.holdings[symbol] = {
    shares,
    entryPrice: coin.price,
    invested: amount,
    timestamp: new Date()
  };

  agentState.ownedCoins.add(symbol);
  agentState.cash -= amount;
  agentState.trades++;

  agentState.tradeHistory.push({
    action: 'BUY',
    symbol,
    shares,
    price: coin.price,
    amount,
    timestamp: new Date()
  });

  addLog(`✅ EXECUTED BUY: ${shares.toFixed(4)} ${symbol} @ $${coin.price} | Invested: $${amount.toFixed(2)}`, 'buy');
}

// ═════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// Start agent
app.post('/api/agent/start', (req, res) => {
  const { model, maxPositions, mode } = req.body;

  if (!process.env.CLAUDE_API_KEY) {
    return res.status(400).json({ error: 'CLAUDE_API_KEY not set' });
  }

  agentState.active = true;
  agentState.model = model || 'claude-sonnet-4-20250514';
  agentState.maxPositions = maxPositions || 5;
  agentState.mode = mode || 'demo';

  addLog(`🚀 AGENT STARTED`, 'startup');
  addLog(`🤖 Model: ${agentState.model}`, 'startup');
  addLog(`📊 Mode: ${agentState.mode.toUpperCase()}`, 'startup');
  addLog(`📍 Max Positions: ${agentState.maxPositions}`, 'startup');

  autonomousLoop();

  res.json({ success: true, message: 'Agent started', state: agentState });
});

// Get state
app.get('/api/agent/state', (req, res) => {
  const totalValue = agentState.cash + 
    Object.entries(agentState.holdings).reduce((a, [sym, h]) => a + h.shares * COINS[sym].price, 0);
  
  res.json({
    ...agentState,
    ownedCoins: Array.from(agentState.ownedCoins),
    totalValue,
    pl: totalValue - 10000,
    pct: ((totalValue - 10000) / 10000 * 100).toFixed(2)
  });
});

// Stop agent
app.post('/api/agent/stop', (req, res) => {
  agentState.active = false;
  addLog('⏸️ AGENT STOPPED', 'shutdown');
  res.json({ success: true });
});

// Reset
app.post('/api/agent/reset', (req, res) => {
  agentState = {
    active: false,
    model: 'claude-sonnet-4-20250514',
    mode: 'demo',
    portfolio: 10000,
    cash: 10000,
    holdings: {},
    ownedCoins: new Set(),
    trades: 0,
    maxPositions: 5,
    tradeHistory: [],
    logs: []
  };
  addLog('♻️ Portfolio reset', 'reset');
  res.json({ success: true });
});

// Get logs
app.get('/api/logs', (req, res) => {
  res.json(agentState.logs);
});

// Serve frontend
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'nexus-dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  NEXUS REAL AUTONOMOUS AGENT      ║`);
  console.log(`║  Backend Server @ port ${PORT}        ║`);
  console.log(`║  Claude API: ${process.env.CLAUDE_API_KEY ? '✅' : '❌'}               ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});

module.exports = { agentState, autonomousLoop };
