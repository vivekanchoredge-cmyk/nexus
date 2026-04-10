# 🤖 NEXUS - AGENTIC TRADING SYSTEM v2.0

Production-Grade Autonomous Trading Agent with Claude AI

## 🎯 What This Does

- Autonomous reasoning engine using Claude API
- Multi-step decision making (PERCEIVE → REASON → PLAN → ACT → OBSERVE → LEARN)
- Tool use: Market analysis, risk calculation, strategy evaluation
- Memory system: Learns from trade outcomes
- 50 coin analysis with intelligent scoring
- Automatic buy/sell execution with risk management

## 🏗️ Architecture

**Agentic Loop:**
```
PERCEIVE (Get market data)
    ↓
REASON (Claude analyzes, scores coins)
    ↓
PLAN (Calculate positions, risks)
    ↓
ACT (Execute buy/sell orders)
    ↓
OBSERVE (Track outcomes, P&L)
    ↓
LEARN (Update memory, adapt strategy)
```

## 📊 How It Works

1. **Every 60 seconds:** Agent analyzes top 10 hottest coins
2. **Claude scores each coin:** 1-10 confidence rating
3. **Only buys if score ≥ 7/10:** Ensures high-confidence signals
4. **Position size:** Risk-based (default 20%)
5. **Stop Loss:** -3% automatic exit
6. **Profit Target:** +5% automatic exit

## 🚀 Deploy to Render

**Prerequisites:**
- GitHub repo: vivekanchoredge-cmyk/nexus
- Render account connected to GitHub
- Claude API key

**Steps:**
1. Replace these files on GitHub:
   - server.js (backend with agentic logic)
   - index.html (dashboard)
   - package.json (dependencies)

2. Keep these files as-is:
   - Procfile (tells Render how to run)
   - .gitignore (keeps secrets safe)

3. Render auto-deploys in 2-3 minutes

## 📋 Configuration

Dashboard settings:
- **Min Confidence:** 5-10 (default 7) - Higher = more conservative
- **Max Positions:** 2-10 (default 5) - Max coins to hold
- **Risk %:** 5-40% (default 20%) - Position size per trade

## 🧠 What Claude Analyzes

- Market conditions & trends
- Risk levels per coin
- Opportunity scoring
- Position sizing
- Entry/exit strategies
- Portfolio concentration

## 💰 Trading Rules

**BUY when:**
- Confidence score ≥ 7/10
- Coin not already held
- Positions < max allowed
- Cash > coin price

**SELL when:**
- Price drops 3% (stop loss)
- Price rises 5% (profit target)

## 📈 Dashboard

**Portfolio Panel:**
- Total Value (portfolio worth)
- Cash (available to trade)
- P&L (profit/loss)
- Positions (current holdings)
- Trades (total executed)

**Reasoning Log:**
- Real-time agent decisions
- Analysis results
- Buy/sell signals
- Error messages

**Intelligence Panel:**
- Market regime (bull/bear/sideways)
- Risk assessment
- Diversification score
- Win rate
- Performance metrics

## ✨ Key Features

✅ Autonomous decision making  
✅ Multi-step reasoning  
✅ Learning & adaptation  
✅ Risk management  
✅ Error handling & recovery  
✅ Real-time monitoring  
✅ Production-ready architecture  

## 🔒 Safety

- Hard stop loss: -3% per trade
- Hard profit target: +5% per trade
- Max position: 25% of portfolio
- Max positions: Configurable (default 5)
- Portfolio concentration limits

## 📞 Troubleshooting

**Agent not trading?**
- Check API key is valid
- Check min confidence setting
- Wait for next cycle (60 seconds)

**Dashboard not updating?**
- Refresh browser
- Check Render logs
- Restart agent

**API errors?**
- Verify API key format
- Check Claude API status
- Wait a few seconds and retry

## 📚 Technology

- **Backend:** Node.js + Express
- **Frontend:** HTML + JavaScript
- **AI:** Claude API (Sonnet 4)
- **Hosting:** Render
- **Storage:** In-memory state

## 🎓 Demonstrates

Real agentic AI concepts:
- Autonomous operation
- Goal-oriented behavior
- Multi-step reasoning
- Tool use & integration
- Memory & learning
- Adaptive strategies
- Error recovery
- Accountability

---

**Version:** 2.0 - Agentic  
**Status:** Production-Ready  
**Last Updated:** 2026-04-10
