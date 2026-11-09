---
title: WhatsApp AI Bot
emoji: 💬
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# WhatsApp AI Bot (24/7 Cloud Assistant)

A lightweight, production-ready WhatsApp AI bot powered by **Groq Llama 3.3** (or OpenRouter) and **Baileys WebSockets**. Includes a clean web portal for clients to scan the QR code and keep-alive health endpoints for 24/7 free cloud hosting.

---

## Deploy to Hugging Face Spaces (100% Free - No Credit Card)

1. Create a free account on [huggingface.co](https://huggingface.co).
2. Click **Create new Space**:
   - **Space Name**: `whatsapp-ai-bot`
   - **SDK**: Select **Docker** (Blank)
   - **Visibility**: Public
3. Connect your GitHub repository (`AdilSiddiquiHQ/whatsapp-ai-bot`) or clone the Space repo.
4. Go to **Settings** -> **Variables and Secrets**:
   - Add Secret `GROQ_API_KEY`: *(Your key from console.groq.com)*
5. Once built, open:
   `https://<your-username>-whatsapp-ai-bot.hf.space/scan`
6. Scan the QR code with WhatsApp, and your bot is live!
