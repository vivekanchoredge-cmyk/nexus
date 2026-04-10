/**
 * NEXUS ULTIMATE — Browser Automation Server
 * ============================================
 * ONE-TIME SETUP:
 *   npm install express puppeteer cors
 *   node server.js
 *
 * Phir NEXUS mein "Browser" badge green ho jayega.
 * Agent ab real browser control kar sakta hai.
 */

const express   = require('express');
const puppeteer = require('puppeteer');
const cors      = require('cors');
const { exec, spawn } = require('child_process');
const path      = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ── Serve HTML files from same folder ─────────────
// Koi bhi .html file same folder mein ho to serve hogi
app.use(express.static(path.join(__dirname)));

// ── Root route → serve nexus-ultimate-scalping.html ─
app.get('/', (req, res) => {
  const htmlFiles = [
    'nexus-ultimate-scalping.html',
    'nexus-ultimate.html',
    'index.html'
  ];
  for (const file of htmlFiles) {
    const filePath = path.join(__dirname, file);
    if (require('fs').existsSync(filePath)) {
      console.log(`[NEXUS] Serving: ${file}`);
      return res.sendFile(filePath);
    }
  }
  res.send(`
    <h2>NEXUS Server is running ✅</h2>
    <p>HTML file not found in: ${__dirname}</p>
    <p>Rakh do <b>nexus-ultimate-scalping.html</b> isi folder mein jahan server.js hai</p>
    <ul>
      ${require('fs').readdirSync(__dirname).map(f=>`<li>${f}</li>`).join('')}
    </ul>
  `);
});

let browser = null;

// ── Browser launch helper ──────────────────────────
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',          // Required for Render.com
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browser;
}

// ── Ping — health check ───────────────────────────
app.get('/ping', (req, res) => {
  res.json({ status: 'online', server: 'NEXUS Browser Agent', version: '1.0' });
});

// ── Main browse endpoint ──────────────────────────
app.post('/browse', async (req, res) => {
  let { task, url, actions = [], extract = 'text' } = req.body;

  // Fix: url optional — default to google
  url = url || 'https://www.google.com';

  let page = null;
  try {
    const b   = await getBrowser();
    page      = await b.newPage();

    // Stealth: override webdriver flag
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Set real-looking user agent
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.setViewport({ width: 1280, height: 800 });

    console.log(`[NEXUS] Opening: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const results = { url, task, steps: [] };

    // ── Execute actions ──────────────────────────
    for (const action of actions) {
      try {
        const { type, selector, value, wait_for } = action;

        if (type === 'click') {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector);
          results.steps.push({ action: 'click', selector, status: 'done' });

        } else if (type === 'type') {
          await page.waitForSelector(selector, { timeout: 5000 });
          await page.click(selector, { clickCount: 3 }); // select all first
          await page.type(selector, value, { delay: 40 });
          results.steps.push({ action: 'type', selector, value, status: 'done' });

        } else if (type === 'wait') {
          await page.waitForSelector(selector, { timeout: parseInt(value) || 5000 });
          results.steps.push({ action: 'wait', selector, status: 'found' });

        } else if (type === 'scroll') {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          results.steps.push({ action: 'scroll', status: 'done' });

        } else if (type === 'select') {
          await page.select(selector, value);
          results.steps.push({ action: 'select', selector, value, status: 'done' });

        } else if (type === 'press') {
          await page.keyboard.press(value || 'Enter');
          results.steps.push({ action: 'press', key: value, status: 'done' });

        } else if (type === 'wait_nav') {
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
          results.steps.push({ action: 'wait_nav', status: 'done', url: page.url() });
        }

        // Small pause between actions
        await new Promise(r => setTimeout(r, 300));

      } catch (stepErr) {
        results.steps.push({ action: action.type, selector: action.selector, status: 'failed', error: stepErr.message });
      }
    }

    // ── Extract data ─────────────────────────────
    const extracted = await page.evaluate((extractType) => {
      const data = {};

      // Always get title + URL
      data.title      = document.title;
      data.currentUrl = window.location.href;

      if (extractType === 'text' || extractType === 'all') {
        // Clean readable text (remove scripts/styles)
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script,style,nav,footer,header,[aria-hidden="true"]').forEach(e => e.remove());
        data.text = (clone.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 5000);
      }

      if (extractType === 'links' || extractType === 'all') {
        data.links = Array.from(document.querySelectorAll('a[href]'))
          .slice(0, 30)
          .map(a => ({ text: a.innerText.trim(), href: a.href }))
          .filter(l => l.text && l.href.startsWith('http'));
      }

      if (extractType === 'images' || extractType === 'all') {
        data.images = Array.from(document.querySelectorAll('img[src]'))
          .slice(0, 10)
          .map(i => ({ alt: i.alt, src: i.src }));
      }

      if (extractType === 'table' || extractType === 'all') {
        const tables = [];
        document.querySelectorAll('table').forEach(t => {
          const rows = [];
          t.querySelectorAll('tr').forEach(r => {
            rows.push(Array.from(r.querySelectorAll('td,th')).map(c => c.innerText.trim()));
          });
          if (rows.length) tables.push(rows);
        });
        data.tables = tables.slice(0, 3);
      }

      // Forms on page
      data.forms = Array.from(document.querySelectorAll('form')).slice(0, 3).map(f => ({
        action: f.action,
        inputs: Array.from(f.querySelectorAll('input,select,textarea')).map(i => ({
          type: i.type, name: i.name, id: i.id, placeholder: i.placeholder
        }))
      }));

      return data;
    }, extract);

    results.extracted = extracted;
    results.success   = true;
    results.message   = `✅ Browser task done: ${task}`;

    console.log(`[NEXUS] Done: ${task} — ${page.url()}`);
    res.json(results);

  } catch (err) {
    console.error('[NEXUS] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ── Real File System ops ─────────────────────────────
const fs = require('fs');
const fsPromises = require('fs').promises;
const os = require('os');

// For Render.com: use temp directory or current directory
const getWritablePath = (filepath) => {
  // If filepath is absolute and not in /app, use /tmp
  if (filepath.startsWith('/') && !filepath.startsWith('/app') && !filepath.startsWith(__dirname)) {
    return path.join('/tmp', path.basename(filepath));
  }
  // Use current working directory for relative paths
  if (!filepath.startsWith('/')) {
    return path.join(process.cwd(), filepath);
  }
  return filepath;
};

app.post('/file-ops', async (req, res) => {
  const { op, filepath, content, encoding='utf8', dirpath='.' } = req.body;

  // Safety: block dangerous paths
  const dangerous=['../', '/etc/', '/sys/', '/proc/', 'C:\\Windows', 'C:\\System'];
  const pathToCheck = filepath || dirpath || '';
  if(dangerous.some(d => pathToCheck.includes(d))) {
    return res.status(403).json({ error: 'Blocked: dangerous path', path: pathToCheck });
  }

  try {
    if(op === 'write') {
      if(!filepath || content===undefined) return res.status(400).json({ error: 'filepath and content required' });
      
      // Get writable path (for Render.com compatibility)
      const writePath = getWritablePath(filepath);
      
      // Create parent dirs if needed
      const dir = require('path').dirname(writePath);
      if(dir && dir !== '.') await fsPromises.mkdir(dir, { recursive: true }).catch(()=>{});
      
      await fsPromises.writeFile(writePath, content, encoding);
      const stat = await fsPromises.stat(writePath);
      const lines = encoding==='utf8' ? content.split('\n').length : 0;
      console.log(`[NEXUS] File written: ${writePath} (${stat.size} bytes)`);
      res.json({ success: true, filepath: writePath, size: stat.size, lines, message: `Written: ${writePath}` });

    } else if(op === 'read') {
      if(!filepath) return res.status(400).json({ error: 'filepath required' });
      const readPath = getWritablePath(filepath);
      const data = await fsPromises.readFile(readPath, encoding);
      const lines = encoding==='utf8' ? data.split('\n').length : 0;
      console.log(`[NEXUS] File read: ${readPath}`);
      res.json({ success: true, filepath: readPath, content: data.slice(0, 50000), size: data.length, lines });

    } else if(op === 'list') {
      const entries = await fsPromises.readdir(dirpath, { withFileTypes: true });
      const files = entries.map(e => (e.isDirectory() ? '[DIR] ' : '') + e.name);
      console.log(`[NEXUS] Dir listed: ${dirpath} (${files.length} entries)`);
      res.json({ success: true, dirpath, files, count: files.length });

    } else if(op === 'delete') {
      if(!filepath) return res.status(400).json({ error: 'filepath required' });
      const delPath = getWritablePath(filepath);
      await fsPromises.unlink(delPath);
      console.log(`[NEXUS] File deleted: ${delPath}`);
      res.json({ success: true, filepath: delPath, message: `Deleted: ${delPath}` });

    } else if(op === 'exists') {
      const checkPath = getWritablePath(filepath);
      const exists = await fsPromises.access(checkPath).then(()=>true).catch(()=>false);
      res.json({ success: true, filepath: checkPath, exists });

    } else if(op === 'mkdir') {
      const mkPath = getWritablePath(filepath);
      await fsPromises.mkdir(mkPath, { recursive: true });
      res.json({ success: true, filepath: mkPath, message: `Directory created: ${mkPath}` });

    } else {
      res.status(400).json({ error: 'Unknown op: '+op, validOps: ['write','read','list','delete','exists','mkdir'] });
    }
  } catch(e) {
    console.error('[NEXUS] File op error:', e.message);
    res.status(500).json({ success: false, error: e.message, op, filepath });
  }
});

// ── Shell command execution ──────────────────────────
app.post('/run-command', async (req, res) => {
  const { command, cwd } = req.body;
  if (!command) return res.status(400).json({ error: 'command required' });

  // Security: block dangerous commands
  const blocked = ['rm -rf /', 'sudo', 'format', 'mkfs', 'dd if='];
  if (blocked.some(b => command.includes(b))) {
    return res.status(403).json({ error: 'Blocked command for safety', command });
  }

  const workDir = cwd || process.cwd();
  console.log(`[NEXUS] Shell: ${command} (in ${workDir})`);

  try {
    await new Promise((resolve, reject) => {
      exec(command, {
        cwd: workDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024 * 5,  // 5MB
        env: { ...process.env, PATH: process.env.PATH }
      }, (error, stdout, stderr) => {
        const exitCode = error ? (error.code || 1) : 0;
        console.log(`[NEXUS] Shell done: exit ${exitCode}`);
        res.json({
          success: exitCode === 0,
          exitCode,
          stdout: stdout.slice(0, 10000),
          stderr: stderr.slice(0, 3000),
          command,
          cwd: workDir
        });
        resolve();
      });
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message, command });
  }
});

// ── /run alias — same as /browse (backward compat) ─
app.post('/run', (req, res, next) => {
  req.url = '/browse';
  app._router.handle(req, res, next);
});

// ── Screenshot endpoint ───────────────────────────
app.post('/screenshot', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const shot = await page.screenshot({ encoding: 'base64', type: 'jpeg', quality: 80 });
    res.json({ success: true, screenshot: `data:image/jpeg;base64,${shot}`, url });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ── PDF endpoint ──────────────────────────────────
app.post('/pdf', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ── /api/market/candles — Binance klines proxy ──────
app.get('/api/market/candles', async (req, res) => {
  const { symbol = 'BTCUSDT', interval = '5m', limit = 60 } = req.query;
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=${Math.min(parseInt(limit)||60, 200)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ success: false, error: `Binance error: ${err.slice(0,200)}` });
    }
    const raw = await response.json();
    const candles = raw.map(c => ({
      t: c[0],
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
      closeTime: c[6]
    }));
    const latest = candles[candles.length - 1];
    console.log(`[NEXUS] Candles: ${symbol} ${interval} | latest H:${latest.high} L:${latest.low} C:${latest.close}`);
    res.json({ success: true, symbol, interval, count: candles.length, latest, candles });
  } catch (e) {
    console.error('[NEXUS] /api/market/candles error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ── /api/market/price — quick spot price ────────────
app.get('/api/market/price', async (req, res) => {
  const { symbol = 'BTCUSDT' } = req.query;
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol.toUpperCase()}`);
    const data = await response.json();
    if (data.code) return res.status(400).json({ success: false, error: data.msg });
    res.json({ success: true, symbol: data.symbol, price: parseFloat(data.price) });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(); });

// ── Start ─────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('  ⬡  NEXUS Browser Server');
  console.log(`  🟢 Running on port ${PORT}`);
  console.log('  ✅ NEXUS agent ab real browser use kar sakta hai');
  console.log('');
  console.log('  Endpoints:');
  console.log(`    GET  /ping           — health check`);
  console.log(`    POST /browse         — execute browser task`);
  console.log(`    POST /run-command    — run shell commands (node, npm, python)`);
  console.log(`    POST /file-ops       — real fs: write/read/list/delete files`);
  console.log(`    POST /screenshot     — take screenshot`);
  console.log(`    GET  /api/market/candles  — Binance klines proxy (?symbol=BTCUSDT&interval=5m&limit=60)`);
  console.log(`    GET  /api/market/price    — spot price (?symbol=BTCUSDT)`);
  console.log('');
  console.log('  Ctrl+C to stop');
  console.log('');
});

// ── CoinGecko API Endpoint (FREE - No Auth Required) ───────────────────────────
app.get('/api/coingecko/:endpoint', async (req, res) => {
  try {
    const { endpoint } = req.params;
    const query = new URLSearchParams(req.query).toString();
    
    // Allowed endpoints
    const allowed = ['ping', 'simple/price', 'coins/markets', 'search/trending', 'global', 'simple/supported_vs_currencies'];
    if (!allowed.includes(endpoint)) {
      return res.status(400).json({ error: 'Invalid endpoint', allowed });
    }
    
    const url = `https://api.coingecko.com/api/v3/${endpoint}${query ? '?' + query : ''}`;
    console.log(`[NEXUS] CoinGecko API: ${url}`);
    
    const response = await fetch(url, {
      headers: { 'accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!response.ok) {
      return res.status(response.status).json({ error: `CoinGecko API error: ${response.statusText}` });
    }
    
    const data = await response.json();
    res.json(data);
  } catch (e) {
    console.error('[NEXUS] CoinGecko error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Close browser on exit ─────────────────────────
process.on('SIGINT',  async () => { if (browser) await browser.close(); process.exit(); });
process.on('SIGTERM', async () => { if (browser) await browser.close(); process.exit(); });
