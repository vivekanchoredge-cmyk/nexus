const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const agentState = {
  portfolio: {
    totalCash: 10000,
    holdings: {},
    totalValue: 10000,
    pnl: 0,
    trades: [],
    tradeDetails: []
  },
  agentConfig: {
    minConfidence: 7,
    maxPositions: 5,
    riskPerTrade: 20
  },
  memory: {
    tradeHistory: [],
    marketAnalysis: {},
    learnedPatterns: []
  }
};

async function marketAnalysisTool(topCoins) {
  const prompt = `You are NEXUS, an autonomous trading agent. Analyze these top coins:

${topCoins.map(c => `${c.symbol}: $${c.price.toFixed(2)} (Vol: ${c.vol.toFixed(1)}%)`).join('\n')}

Rate each coin 1-10 for buying. ONLY JSON response:
{
  "coin_scores": [
    {"symbol": "BTC", "score": 8, "rationale": "strong momentum"}
  ],
  "buy_recommendations": [
    {"symbol": "BTC", "position_size_percent": 20}
  ]
}`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': agentState.apiKey,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    const content = response.data.content[0].text;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return null;
  } catch (error) {
    console.error('Market analysis error:', error.message);
    return null;
  }
}

async function agenticReasoning(topCoins) {
  console.log('\n=== AGENTIC CYCLE ===\n');

  const analysis = await marketAnalysisTool(topCoins);
  if (!analysis) {
    console.log('Analysis failed');
    return { trades: [], exits: [] };
  }

  const trades = [];
  const exits = [];

  if (analysis.buy_recommendations) {
    for (const rec of analysis.buy_recommendations) {
      const coin = topCoins.find(c => c.symbol === rec.symbol);
      if (!coin) continue;

      const scoreIndex = analysis.coin_scores.findIndex(s => s.symbol === rec.symbol);
      const score = scoreIndex >= 0 ? analysis.coin_scores[scoreIndex].score : 0;

      if (
        score >= agentState.agentConfig.minConfidence &&
        !agentState.portfolio.holdings[rec.symbol] &&
        Object.keys(agentState.portfolio.holdings).length < agentState.agentConfig.maxPositions &&
        agentState.portfolio.totalCash > coin.price
      ) {
        const amount = agentState.portfolio.totalCash * (rec.position_size_percent / 100);
        const shares = amount / coin.price;
        const entryPrice = coin.price;
        const stopLoss = entryPrice * 0.97;
        const profitTarget = entryPrice * 1.05;

        agentState.portfolio.holdings[rec.symbol] = {
          shares,
          entryPrice,
          currentPrice: coin.price,
          stopLoss,
          profitTarget,
          bought: new Date()
        };

        agentState.portfolio.totalCash -= amount;
        agentState.portfolio.trades.push({ symbol: rec.symbol, type: 'buy' });

        trades.push({
          symbol: rec.symbol,
          type: 'buy',
          price: entryPrice,
          entry: entryPrice,
          exit: null,
          stopLoss,
          profitTarget,
          shares,
          reason: 'Claude signal',
          score
        });

        console.log(`✅ BUY: ${rec.symbol} @ $${entryPrice.toFixed(4)} | SL: $${stopLoss.toFixed(4)} | TP: $${profitTarget.toFixed(4)}`);
      }
    }
  }

  // Check exits
  Object.entries(agentState.portfolio.holdings).forEach(([symbol, holding]) => {
    const coin = topCoins.find(c => c.symbol === symbol);
    if (!coin) return;

    holding.currentPrice = coin.price;

    if (coin.price <= holding.stopLoss) {
      const pnl = (coin.price - holding.entryPrice) * holding.shares;
      agentState.portfolio.totalCash += coin.price * holding.shares;
      
      exits.push({
        symbol,
        exitPrice: coin.price,
        reason: 'STOP_LOSS',
        pnl,
        entry: holding.entryPrice,
        stopLoss: holding.stopLoss,
        profitTarget: holding.profitTarget
      });

      agentState.portfolio.tradeDetails.push({
        symbol, type: 'sell', price: coin.price, entry: holding.entryPrice,
        exit: coin.price, stopLoss: holding.stopLoss, profitTarget: holding.profitTarget,
        pnl, reason: 'STOP_LOSS'
      });

      delete agentState.portfolio.holdings[symbol];
      console.log(`🛑 STOP_LOSS: ${symbol} @ $${coin.price.toFixed(4)} | P&L: $${pnl.toFixed(2)}`);
    } 
    else if (coin.price >= holding.profitTarget) {
      const pnl = (coin.price - holding.entryPrice) * holding.shares;
      agentState.portfolio.totalCash += coin.price * holding.shares;
      
      exits.push({
        symbol,
        exitPrice: coin.price,
        reason: 'PROFIT_TARGET',
        pnl,
        entry: holding.entryPrice,
        stopLoss: holding.stopLoss,
        profitTarget: holding.profitTarget
      });

      agentState.portfolio.tradeDetails.push({
        symbol, type: 'sell', price: coin.price, entry: holding.entryPrice,
        exit: coin.price, stopLoss: holding.stopLoss, profitTarget: holding.profitTarget,
        pnl, reason: 'PROFIT_TARGET'
      });

      delete agentState.portfolio.holdings[symbol];
      console.log(`✅ PROFIT_TARGET: ${symbol} @ $${coin.price.toFixed(4)} | P&L: $${pnl.toFixed(2)}`);
    }
  });

  console.log('\n=== CYCLE COMPLETE ===\n');
  return { trades, exits };
}

app.post('/api/agent/init', (req, res) => {
  agentState.apiKey = req.body.apiKey;
  agentState.agentConfig.minConfidence = req.body.minConfidence || 7;
  agentState.agentConfig.maxPositions = req.body.maxPositions || 5;
  
  res.json({ status: 'Agent initialized', config: agentState.agentConfig });
});

app.get('/api/agent/state', (req, res) => {
  const totalValue = agentState.portfolio.totalCash + 
    Object.entries(agentState.portfolio.holdings).reduce((sum, [sym, h]) => {
      return sum + (h.shares * h.currentPrice);
    }, 0);

  res.json({
    portfolio: {
      totalValue,
      totalCash: agentState.portfolio.totalCash,
      pnl: totalValue - 10000,
      holdings: agentState.portfolio.holdings,
      trades: agentState.portfolio.trades,
      tradeDetails: agentState.portfolio.tradeDetails
    },
    config: agentState.agentConfig
  });
});

app.post('/api/agent/cycle', async (req, res) => {
  if (!agentState.apiKey) {
    return res.status(400).json({ error: 'Agent not initialized' });
  }

  try {
    const coins = req.body.coins || [];
    const result = await agenticReasoning(coins);

    res.json({
      status: 'success',
      trades: result.trades,
      exits: result.exits,
      holdings: agentState.portfolio.holdings,
      cash: agentState.portfolio.totalCash
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🤖 NEXUS Agentic Agent running on port ${PORT}`);
});

