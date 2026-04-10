const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Rate limiting state
let lastApiCallTime = 0;
const API_CALL_COOLDOWN = 3000; // 3 second cooldown between calls

// Claude API call endpoint with rate limiting
app.post('/api/claude', async (req, res) => {
  const { prompt, model, apiKey } = req.body;

  if (!apiKey || !prompt || !model) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Rate limiting check
  const now = Date.now();
  const timeSinceLastCall = now - lastApiCallTime;
  
  if (timeSinceLastCall < API_CALL_COOLDOWN) {
    // Too many requests, return cached/default response
    return res.json({ 
      success: true, 
      decision: 'HOLD',
      reason: 'Rate limited - cooling down'
    });
  }

  try {
    lastApiCallTime = Date.now();
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: model,
        max_tokens: 100,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        timeout: 10000 // 10 second timeout
      }
    );

    const decision = response.data.content[0].text.trim();
    res.json({ success: true, decision });
  } catch (error) {
    // Handle different error types
    if (error.response?.status === 429) {
      // Rate limited by Claude API
      res.json({ 
        success: true, 
        decision: 'HOLD',
        reason: 'Claude API rate limited'
      });
    } else if (error.response?.status === 502 || error.response?.status === 503) {
      // API server error - return HOLD
      res.json({ 
        success: true, 
        decision: 'HOLD',
        reason: 'Claude API temporary issue'
      });
    } else if (error.code === 'ECONNABORTED') {
      // Timeout
      res.json({ 
        success: true, 
        decision: 'HOLD',
        reason: 'Request timeout'
      });
    } else {
      // Other errors
      res.status(500).json({ 
        error: error.message,
        code: error.response?.status || 'UNKNOWN'
      });
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 NEXUS running on port ${PORT}`);
});
