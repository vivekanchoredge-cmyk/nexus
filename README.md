# ⬡ NEXUS ULTIMATE — Real AI Agent

Claude AI powered autonomous agent with browser control, memory, and multi-tool execution.

## 🚀 Render.com par Deploy karna

### Step 1 — GitHub par upload karo

```bash
# Pehli baar setup
git init
git add .
git commit -m "NEXUS ULTIMATE initial commit"

# GitHub par new repo banao, phir:
git remote add origin https://github.com/TUMHARA_USERNAME/nexus-ultimate.git
git branch -M main
git push -u origin main
```

### Step 2 — Render.com par deploy karo

1. **render.com** par jao → Sign up/Login
2. **"New +"** → **"Web Service"** click karo
3. **Connect GitHub** → apna `nexus-ultimate` repo select karo
4. Settings:
   - **Name:** `nexus-ultimate` (ya koi bhi)
   - **Runtime:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** `Free`
5. **"Create Web Service"** click karo
6. Deploy hone do (2-3 minutes)
7. Live URL milegi: `https://nexus-ultimate-xxxx.onrender.com`

## 🔑 API Key kaise use karein

API key **kabhi GitHub par mat daalo**. Browser mein:
1. NEXUS open karo
2. Sidebar mein 🔑 **Key** button click karo
3. Apni Anthropic API key daalo
4. Key **sirf tumhare browser mein** save hoti hai (localStorage) — server tak nahi jaati

## 📁 Project Files

```
nexus-ultimate/
├── server.js              ← Express + Puppeteer server
├── nexus-ultimate.html    ← Main UI (Claude AI agent)
├── package.json           ← Dependencies
├── .gitignore             ← api.txt aur secrets exclude
└── README.md
```

## ⚠️ Important

- `api.txt` — is file ko **delete karo** ya `.gitignore` mein already hai
- Free Render instance 15 min inactivity pe sleep hoti hai — first load slow ho sakta hai
- Puppeteer (browser automation) Render free tier pe kaam karta hai

## 💻 Local Development

```bash
npm install
node server.js
# http://localhost:3000 par open karo
```
