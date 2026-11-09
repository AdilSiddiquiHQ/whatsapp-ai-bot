# WhatsApp AI Bot (24/7 Cloud Assistant)

A lightweight, production-ready WhatsApp AI bot powered by **Groq Llama 3.3** (or OpenRouter) and **Baileys WebSockets**. Includes a clean web portal for clients to scan the QR code and keep-alive health endpoints for 24/7 free cloud hosting.

---

## Features
- 🚀 **Blazing Fast**: Powered by Groq Cloud LPUs (~500 tokens/sec).
- 📱 **Client Web Portal**: Send your client a clean link (`/scan`) where they can scan the QR code directly from their browser.
- 🛡️ **Anti-Ban Protections**: Human-like typing presence (`composing`), natural cadence delays, and no cold messaging.
- 🧠 **Smart Memory**: Retains conversation context per user.
- 🔄 **24/7 Keep-Alive**: Includes `/health` endpoint to pair with free services like UptimeRobot to prevent cloud sleeping.
- ⚡ **Lightweight**: Consumes ~45 MB RAM (no heavy Chromium/Puppeteer).

---

## 1-Click Deploy to Render

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

1. Click **Deploy to Render** (or connect this repo on [render.com](https://render.com)).
2. Set `GROQ_API_KEY` in Environment Variables (Get free key at [console.groq.com](https://console.groq.com)).
3. Once deployed, open `https://your-bot.onrender.com/scan` and scan the QR code with WhatsApp.
4. Keep it awake 24/7 by adding `https://your-bot.onrender.com/health` to [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) (ping every 5 minutes).

---

## Local Development

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
cp .env.example .env
# Edit .env with your GROQ_API_KEY

# 3. Start the bot
npm start

# 4. Open browser
# Visit http://localhost:3000/scan
```
