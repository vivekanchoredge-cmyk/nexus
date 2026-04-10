/**
 * NEXUS ULTIMATE - REAL AI AGENT SERVER
 * =====================================
 * Claude API Integrated
 * Trading Capabilities
 * Autonomous Decision Making
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

// Configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ═════════════════════════════════════════════════════════════════
// REAL AGENT STATE
// ═════════════════════════════════════════════════════════════════

let agentState = {
  mode: 'demo',
  portfolio: 10000,
  cash: 10000,
  holdings: {},
  trades: 0,
  tradeHistory: []
};

// Demo Coins Database
const COINS = {
  BTC: { price: 45123, change: 8.5, name: 'Bitcoin' },
  ETH: { price: 2850, change: 6.3, name: 'Ethereum' },
  SOL: { price: 102, change: 9.1, name: 'Solana' },
  ADA: { price: 0.98, change: 7.2, name: 'Cardano' },
  XRP: { price: 0.52, change: 10.4, name: 'Ripple' },
};

// ═════════════════════════════════════════════════════════════════
// CLAUDE API INTEGRATION
// ═════════════════════════════════════════════════════════════════

async function callClaude(prompt) {
  if (!CLAUDE_API_KEY) {
    return "⚠️ Claude API key not configured. Set CLAUDE_API_KEY environment variable.";
  }

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-opus-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: prompt }
        ]
      },
      {
        headers: {
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error('Claude API Error:', error.message);
    throw error;
  }
}

// ═════════════════════════════════════════════════════════════════
// TRADING ENGINE
// ═════════════════════════════════════════════════════════════════

function analyzeCoin(symbol) {
  const coin = COINS[symbol];
  if (!coin) return null;

  let score = 0;
  if (coin.change > 8) score += 30;
  else if (coin.change > 5) score += 20;
  else if (coin.change > 0) score += 10;

  if (coin.change < 15) score += 20;

  return {
    symbol,
    price: coin.price,
    change: coin.change,
    score: Math.min(100, score)
  };
}

function buyCoin(symbol, amount) {
  const coin = COINS[symbol];
  if (!coin) throw new Error(`Unknown coin: ${symbol}`);
  if (agentState.cash < amount) throw new Error(`Insufficient funds: need $${amount}, have $${agentState.cash}`);

  const shares = amount / coin.price;
  agentState.holdings[symbol] = {
    amount: shares,
    entryPrice: coin.price,
    invested: amount
  };
  agentState.cash -= amount;
  agentState.trades++;

  agentState.tradeHistory.push({
    type: 'BUY',
    symbol,
    shares,
    price: coin.price,
    amount,
    timestamp: new Date().toISOString(),
    mode: agentState.mode
  });

  return {
    success: true,
    message: `Bought ${shares.toFixed(4)} ${symbol} for $${amount}`,
    holding: agentState.holdings[symbol]
  };
}

function sellCoin(symbol) {
  if (!agentState.holdings[symbol]) throw new Error(`No holdings of ${symbol}`);

  const holding = agentState.holdings[symbol];
  const coin = COINS[symbol];
  const saleAmount = holding.amount * coin.price;
  const profit = saleAmount - holding.invested;

  agentState.cash += saleAmount;
  delete agentState.holdings[symbol];
  agentState.trades++;

  agentState.tradeHistory.push({
    type: 'SELL',
    symbol,
    shares: holding.amount,
    price: coin.price,
    amount: saleAmount,
    profit,
    profitPercent: (profit / holding.invested * 100).toFixed(2),
    timestamp: new Date().toISOString(),
    mode: agentState.mode
  });

  return {
    success: true,
    message: `Sold ${holding.amount.toFixed(4)} ${symbol} for $${saleAmount.toFixed(2)}, profit: ${profit >= 0 ? '+' : ''}$${profit.toFixed(2)}`,
    profit
  };
}

// ═════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═════════════════════════════════════════════════════════════════

// Serve HTML file - FIXED TO LOOK FOR CORRECT NAME
app.get('/', (req, res) => {
  const possibleFiles = [
    'nexus-ultimate.html',
    'nexus-ultimate-REAL-AGENT.html',
    'index.html'
  ];
  
  for (const file of possibleFiles) {
    const filePath = path.join(__dirname, file);
    if (fs.existsSync(filePath)) {
      console.log(`[NEXUS] Serving: ${file}`);
      return res.sendFile(filePath);
    }
  }
  
  res.status(404).send(`
    <h2>❌ NEXUS Error - HTML file not found</h2>
    <p>Expected files: nexus-ultimate.html or nexus-ultimate-REAL-AGENT.html</p>
    <p>Server running in: ${__dirname}</p>
  `);
});

// Health check
app.get('/ping', (req, res) => {
  res.json({ status: 'online', agent: 'NEXUS REAL', version: '1.0' });
});

// Process agent command
app.post('/agent/command', async (req, res) => {
  const { command, mode } = req.body;

  if (mode === 'demo' || mode === 'real') {
    agentState.mode = mode;
  }

  try {
    // Route command to appropriate handler
    let response;

    if (command.toLowerCase().includes('analyze')) {
      const analysis = Object.keys(COINS).map(sym => analyzeCoin(sym)).sort((a, b) => b.score - a.score);
      response = `📊 ANALYSIS:\n${analysis.map(a => `${a.symbol}: $${a.price} (${a.change}%) - Score: ${a.score}`).join('\n')}`;
    }
    
    else if (command.toLowerCase().includes('buy')) {
      const match = command.match(/buy\s+(\w+)\s+(?:for\s+)?(\d+)/i);
      if (match) {
        const [_, symbol, amount] = match;
        const result = buyCoin(symbol.toUpperCase(), parseInt(amount));
        response = `✅ ${result.message}`;
      } else {
        response = "❌ Invalid buy command. Use: 'Buy BTC for 500'";
      }
    }

    else if (command.toLowerCase().includes('sell')) {
      const match = command.match(/sell\s+(\w+)/i);
      if (match) {
        const result = sellCoin(match[1].toUpperCase());
        response = `✅ ${result.message}`;
      } else {
        response = "❌ Invalid sell command. Use: 'Sell BTC'";
      }
    }

    else if (command.toLowerCase().includes('portfolio')) {
      const value = agentState.cash + Object.entries(agentState.holdings).reduce((a, [sym, h]) => a + h.amount * COINS[sym].price, 0);
      const pl = value - 10000;
      response = `📈 PORTFOLIO:\nValue: $${value.toFixed(2)}\nP&L: ${pl >= 0 ? '+' : ''}$${pl.toFixed(2)}\nTrades: ${agentState.trades}`;
    }

    else if (command.toLowerCase().includes('reset')) {
      agentState = { mode: agentState.mode, portfolio: 10000, cash: 10000, holdings: {}, trades: 0, tradeHistory: [] };
      response = "♻️ Portfolio reset to $10,000";
    }

    else if (command.toLowerCase().includes('image') || command.toLowerCase().includes('generate')) {
      response = `🖼️ Image Generation Request:\nPrompt: "${command}"\nNote: Requires DALL-E API key. Configure OPENAI_API_KEY.`;
    }

    else if (command.toLowerCase().includes('news')) {
      response = `📰 Fetching latest crypto news...\n[News would load from API here]`;
    }

    else {
      // Use Claude for complex commands
      const claudePrompt = `You are NEXUS TRADING AGENT. User command: "${command}"\n\nCurrent state:\n- Mode: ${agentState.mode}\n- Portfolio: $${agentState.cash}\n- Trades: ${agentState.trades}\n\nRespond with action to take.`;
      response = await callClaude(claudePrompt);
    }

    res.json({
      success: true,
      response,
      state: agentState
    });

  } catch (error) {
    res.json({
      success: false,
      error: error.message,
      state: agentState
    });
  }
});

// Get agent state
app.get('/agent/state', (req, res) => {
  const value = agentState.cash + Object.entries(agentState.holdings).reduce((a, [sym, h]) => a + h.amount * COINS[sym].price, 0);
  res.json({
    ...agentState,
    totalValue: value,
    pl: value - 10000
  });
});

// Reset agent
app.post('/agent/reset', (req, res) => {
  agentState = { mode: agentState.mode, portfolio: 10000, cash: 10000, holdings: {}, trades: 0, tradeHistory: [] };
  res.json({ success: true, state: agentState });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n╔════════════════════════════════════╗`);
  console.log(`║  NEXUS ULTIMATE - REAL AGENT      ║`);
  console.log(`║  Server running on port ${PORT}        ║`);
  console.log(`║  Claude API: ${CLAUDE_API_KEY ? '✅ CONFIGURED' : '❌ NOT SET'} ║`);
  console.log(`║  Mode: ${agentState.mode.toUpperCase()}                        ║`);
  console.log(`╚════════════════════════════════════╝\n`);
});

module.exports = { agentState, callClaude, buyCoin, sellCoin };
