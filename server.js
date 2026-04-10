const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const agentState = {
  marketData: {},
  shortTermMemory: {
    currentPositions: {},
    recentTrades: [],
    currentMarketRegime: null
  },
  longTermMemory: {
    tradeHistory: [],
    strategyPerformance: {},
    learnedPatterns: [],
    riskLessons: []
  },
  portfolio: {
    totalCash: 10000,
    holdings: {},
    totalValue: 10000,
    pnl: 0,
    trades: 0
  },
  agentConfig: {
    minConfidence: 7,
    maxPositions: 5,
    riskPerTrade: 20
  }
};

async function marketAnalysisTool(topCoins) {
  const prompt = `You are NEXUS, an autonomous trading agent. Analyze these top coins:

${topCoins.map(c => `${c.symbol}: $${c.price.toFixed(2)} (Vol: ${c.vol.toFixed(1)}%, Rank: #${c.rank})`).join('\n')}

Current Portfolio State:
- Cash: $${agentState.portfolio.totalCash.toFixed(2)}
- Holdings: ${Object.keys(agentState.portfolio.holdings).join(', ') || 'None'}
- Positions: ${Object.keys(agentState.portfolio.holdings).length}/${agentState.agentConfig.maxPositions}

Analyze these coins and rate each 1-10 for buying.

Response format ONLY (JSON):
{
  "market_analysis": "brief analysis",
  "risk_level": "low/medium/high",
  "coin_scores": [
    {"symbol": "BTC", "score": 8, "confidence": "HIGH", "rationale": "strong momentum"}
  ],
  "buy_recommendations": [
    {"symbol": "BTC", "position_size_percent": 20, "reason": "bullish signal"}
  ],
  "portfolio_risk": "acceptable",
  "next_action": "monitor and wait"
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

function riskCalculatorTool() {
  const holdings = agentState.portfolio.holdings;
  let maxPosition = 0;
  
  Object.values(holdings).forEach(h => {
    const value = h.shares * h.currentPrice;
    const pct = (value / agentState.portfolio.totalValue) * 100;
    maxPosition = Math.max(maxPosition, pct);
  });

  return {
    concentration_risk: maxPosition > 25 ? 'HIGH' : maxPosition > 15 ? 'MEDIUM' : 'LOW',
    max_position_percent: maxPosition,
    portfolio_drawdown: (agentState.portfolio.pnl / 10000) * 100,
    diversification_score: Object.keys(holdings).length,
    recommended_action: maxPosition > 25 ? 'REDUCE_POSITIONS' : 'NORMAL'
  };
}

function strategyEvaluatorTool() {
  const trades = agentState.longTermMemory.tradeHistory;
  
  if (trades.length === 0) {
    return {
      win_rate: 0,
      total_trades: 0,
      total_pnl: 0,
      recommended_strategy: 'CONSERVATIVE'
    };
  }

  let wins = 0;
  let totalPnL = 0;

  trades.forEach(trade => {
    if (trade.pnl > 0) wins++;
    totalPnL += trade.pnl;
  });

  return {
    win_rate: (wins / trades.length) * 100,
    total_trades: trades.length,
    total_pnl: totalPnL,
    recommended_strategy: totalPnL > 0 ? 'AGGRESSIVE' : 'CONSERVATIVE'
  };
}

async function agenticReasoning(topCoins) {
  console.log('\n=== AGENTIC REASONING CYCLE ===\n');

  const analysis = await marketAnalysisTool(topCoins);
  if (!analysis) {
    console.log('Analysis failed');
    return;
  }

  const riskMetrics = riskCalculatorTool();
  const strategyMetrics = strategyEvaluatorTool();

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

        agentState.portfolio.holdings[rec.symbol] = {
          shares: shares,
          entryPrice: coin.price,
          currentPrice: coin.price,
          bought: new Date()
        };

        agentState.portfolio.totalCash -= amount;
        agentState.portfolio.trades++;

        console.log(`✅ BUY: ${rec.symbol} @ $${coin.price.toFixed(4)}`);
      }
    }
  }

  agentState.shortTermMemory.currentMarketRegime = analysis.market_analysis;
  console.log('\n=== CYCLE COMPLETE ===\n');
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
      ...agentState.portfolio,
      totalValue: totalValue,
      pnl: totalValue - 10000
    },
    memory: agentState.shortTermMemory,
    trades: agentState.longTermMemory.tradeHistory.length
  });
});

app.post('/api/agent/cycle', async (req, res) => {
  if (!agentState.apiKey) {
    return res.status(400).json({ error: 'Agent not initialized' });
  }

  try {
    const coins = req.body.coins || [];
    
    await agenticReasoning(coins);

    Object.entries(agentState.portfolio.holdings).forEach(([symbol, holding]) => {
      const coin = coins.find(c => c.symbol === symbol);
      if (!coin) return;

      holding.currentPrice = coin.price;
      
      if (coin.price <= holding.entryPrice * 0.97) {
        const pnl = (coin.price - holding.entryPrice) * holding.shares;
        agentState.longTermMemory.tradeHistory.push({
          symbol, entryPrice: holding.entryPrice, exitPrice: coin.price,
          shares: holding.shares, pnl, reason: 'STOP_LOSS'
        });
        
        agentState.portfolio.totalCash += coin.price * holding.shares;
        delete agentState.portfolio.holdings[symbol];
      } else if (coin.price >= holding.entryPrice * 1.05) {
        const pnl = (coin.price - holding.entryPrice) * holding.shares;
        agentState.longTermMemory.tradeHistory.push({
          symbol, entryPrice: holding.entryPrice, exitPrice: coin.price,
          shares: holding.shares, pnl, reason: 'PROFIT_TARGET'
        });
        
        agentState.portfolio.totalCash += coin.price * holding.shares;
        delete agentState.portfolio.holdings[symbol];
      }
    });

    res.json({
      status: 'Agent cycle completed',
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
  console.log('Ready for autonomous trading...');
});
