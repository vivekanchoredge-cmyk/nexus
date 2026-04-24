# Backtest Two-Toggle System

## Overview

**Two Independent Toggles:**
1. **Auto** - Controls automatic backtest running (6h interval)
2. **Manual** - Controls manual "▶ Run" button functionality

---

## UI Changes

**Backtesting panel header now shows:**
```
📊 Backtesting          ☑️ Auto    ☑️ Manual    ✅ 0 approved
```

Two checkboxes side-by-side:
- ☑️ **Auto** (purple) - Enable/disable auto-backtest
- ☑️ **Manual** (green) - Enable/disable manual backtest button

---

## Behavior Matrix

| Auto | Manual | Auto API | Manual API | Agent Data | Notes |
|------|--------|----------|------------|------------|-------|
| ✅ ON | ✅ ON | ~800/day | Per click | ✅ Uses both | Full backtest mode |
| ✅ ON | ❌ OFF | ~800/day | 0 | ✅ Auto only | Manual button disabled |
| ❌ OFF | ✅ ON | 0 | Per click | ✅ Manual only | Manual button enabled |
| ❌ OFF | ❌ OFF | 0 | 0 | ❌ No backtest | Trading without backtest data |

---

## How It Works

### Auto Toggle ✅
- When **ON** (default): Runs backtest every 6 hours automatically
  - Tests top 50 coins
  - ~800 API calls/day
  - Builds `approvedCoins` list for agent
  
- When **OFF**: Auto-run stops
  - No automatic API calls
  - Manual button still works (if Manual is ON)
  - Existing backtest data can still be used

### Manual Toggle ✅
- When **ON** (default): "▶ Run" button is enabled
  - User can click to backtest any coin
  - Each click = ~4 API calls (candles for 4 timeframes)
  - Results added to `approvedCoins`
  
- When **OFF**: "▶ Run" button is disabled
  - Button appears grayed out / not-allowed cursor
  - Clicking shows: "📊 Manual backtest is DISABLED"
  - No manual API calls possible

---

## Agent Behavior

Agent uses backtest data **whenever available**, regardless of source:

- If **Auto ON**: Uses approved coins from auto-backtest
- If **Manual ON + user clicks Run**: Uses approved coins from manual
- If **Both ON**: Uses data from both sources
- If **Both OFF**: Trades normally but without backtest preference data

**Important:** Agent doesn't know or care if data came from auto or manual. It just uses whatever `approvedCoins` exist in memory.

---

## API Endpoints Added

### `/api/backtest/auto-toggle` (POST)
```javascript
{ enabled: true/false }
// Toggles auto-backtest loop
// Server checks this before running 6h interval
```

### `/api/backtest/manual-toggle` (POST)
```javascript
{ enabled: true/false }
// Toggles manual backtest endpoint
// Server checks this before processing manual request
```

---

## Code Changes

### index.html
- Added toggle checkbox for Manual backtest
- Added `manualBacktestEnabled` flag
- Updated toggle handler to track both
- Added check in `runBacktest()`: returns if `!manualBacktestEnabled`
- Button disabled state tied to toggle
- Both states saved to localStorage (persist on refresh)

### server.js
- Added `manualBacktestEnabled = true` flag
- Added check in `autoBacktest()`: returns if `!autoBacktestEnabled`
- Added check in `/api/backtest` endpoint: returns 403 if `!manualBacktestEnabled`
- Added `/api/backtest/manual-toggle` endpoint

---

## Use Cases

### Scenario 1: Save API, Manual Control
```
Auto: ❌ OFF  →  No auto API calls
Manual: ✅ ON  →  User can click "Run" before trading
Result: ~0 API/day from backtest (only per manual click)
Agent uses: Whatever user manually tests
```

### Scenario 2: Full Auto, No Manual
```
Auto: ✅ ON  →  Auto runs every 6h (~800 API/day)
Manual: ❌ OFF  →  User can't click "Run"
Result: Agent uses auto-backtest data only
```

### Scenario 3: Full Mode (Default)
```
Auto: ✅ ON  →  Auto runs every 6h (~800 API/day)
Manual: ✅ ON  →  User can also click "Run"
Result: Agent uses combined data, most comprehensive
```

### Scenario 4: No Backtest
```
Auto: ❌ OFF  →  No auto
Manual: ❌ OFF  →  No manual
Result: 0 API for backtest, agent trades on technicals only
```

---

## User Preferences Storage

Saved in browser localStorage:
- `autoBacktestEnabled` - true/false
- `manualBacktestEnabled` - true/false

Persists across page refreshes, but not across different browsers/devices.

---

## Default Settings

- **Auto**: ✅ ON (runs automatically)
- **Manual**: ✅ ON (button enabled)

No breaking changes - everything works like before by default.

---

## Testing Checklist

- [ ] Both toggles visible in UI
- [ ] Toggle OFF → button disabled (grayed out)
- [ ] Toggle ON → button enabled
- [ ] Manual OFF → clicking "Run" shows error message
- [ ] Auto OFF → no console logs about auto-backtest
- [ ] Toggle states persist on page refresh
- [ ] Agent still trades normally
- [ ] Backtest data (if exists) still used by agent

Done! ✅
