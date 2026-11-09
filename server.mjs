import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestWaWebVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

// Config
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 
    'You are a smart, professional, and friendly AI assistant on WhatsApp. Answer concisely and clearly with natural formatting and emojis.';

let currentQR = null;
let currentPairingCode = null;
let isConnected = false;
let sock = null;

// Conversation memory (per user JID)
const conversationMemory = new Map();

// Helper: Call AI (Groq default, fallback to OpenRouter)
async function callLLM(jid, userText) {
    if (!conversationMemory.has(jid)) {
        conversationMemory.set(jid, [
            { role: 'system', content: SYSTEM_PROMPT }
        ]);
    }

    const history = conversationMemory.get(jid);
    history.push({ role: 'user', content: userText });

    // Keep context window tight (last 8 messages max)
    if (history.length > 9) {
        history.splice(1, 2);
    }

    const isGroq = Boolean(GROQ_API_KEY);
    const endpoint = isGroq 
        ? 'https://api.groq.com/openai/v1/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    
    const apiKey = isGroq ? GROQ_API_KEY : OPENROUTER_API_KEY;
    const model = isGroq ? 'llama-3.3-70b-versatile' : 'meta-llama/llama-3.3-70b-instruct:free';

    if (!apiKey) {
        return "⚠️ AI service is not configured. Please set GROQ_API_KEY or OPENROUTER_API_KEY.";
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            ...(isGroq ? {} : { 'HTTP-Referer': 'https://localhost', 'X-Title': 'WhatsApp Bot' })
        },
        body: JSON.stringify({
            model,
            messages: history,
            max_tokens: 800,
            temperature: 0.7
        })
    });

    if (!response.ok) {
        const errText = await response.text();
        console.error('LLM API Error:', response.status, errText);
        return "Sorry, I am having trouble connecting to my AI brain right now.";
    }

    const data = await response.json();
    const reply = data.choices?.[0]?.message?.content || "No response received.";
    history.push({ role: 'assistant', content: reply });
    return reply;
}

// -------------------------------------------------------------
// WhatsApp Socket Initialization
// -------------------------------------------------------------
async function initWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('./session_auth');
    
    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestWaWebVersion();
        if (latest?.version) version = latest.version;
    } catch (e) {
        // Fallback to default version
    }

    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            currentQR = qr;
        }

        if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            currentPairingCode = null;
            console.log('🎉 WhatsApp AI Bot successfully connected and listening!');
        } else if (connection === 'close') {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed (code: ${statusCode}). Checking reconnect...`);

            if (statusCode !== DisconnectReason.loggedOut) {
                setTimeout(initWhatsApp, 3000);
            } else {
                console.log('Session logged out. Waiting for new scan.');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue;
            const jid = msg.key.remoteJid;
            if (!jid || jid.endsWith('@broadcast')) continue;

            const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
            if (!text || text.trim() === '') continue;

            try {
                // 1. Simulate human presence (typing indicator)
                await sock.sendPresenceUpdate('composing', jid);

                // 2. Generate AI response
                const reply = await callLLM(jid, text.trim());

                // 3. Natural human typing delay (proportional to length, bounded 1-3.5s)
                const delayMs = Math.min(Math.max(reply.length * 20, 1200), 3500);
                await new Promise(r => setTimeout(r, delayMs));

                // 4. Send reply
                await sock.sendMessage(jid, { text: reply }, { quoted: msg });
                await sock.sendPresenceUpdate('paused', jid);

            } catch (err) {
                console.error(`Error replying to ${jid}:`, err.message);
            }
        }
    });
}

// -------------------------------------------------------------
// Web Portal Endpoints (Client Facing)
// -------------------------------------------------------------

// Health check endpoint for UptimeRobot / Cron-job.org
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: isConnected,
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// Clean Web QR & Pairing Portal for the Client
app.get('/', async (req, res) => {
    res.redirect('/scan');
});

app.get('/scan', async (req, res) => {
    if (isConnected) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - Connected</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                    .card { background: #111b21; padding: 40px; border-radius: 16px; text-align: center; max-width: 440px; box-shadow: 0 4px 24px rgba(0,0,0,0.4); border: 1px solid #202c33; }
                    .badge { display: inline-block; background: #00a884; color: #fff; padding: 6px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; margin-bottom: 20px; }
                    h1 { margin: 0 0 10px; font-size: 24px; color: #e9edef; }
                    p { color: #8696a0; font-size: 15px; line-height: 1.5; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div class="badge">● LIVE</div>
                    <h1>WhatsApp Bot is Active!</h1>
                    <p>Your WhatsApp account is successfully connected to the AI. Any incoming message will now be answered automatically.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (!currentQR) {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Bot - Starting...</title>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
                    .card { background: #111b21; padding: 40px; border-radius: 16px; text-align: center; max-width: 440px; border: 1px solid #202c33; }
                    .spinner { border: 4px solid #202c33; border-top: 4px solid #00a884; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 0 auto 20px; }
                    @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    h2 { margin: 0 0 10px; font-size: 20px; }
                    p { color: #8696a0; font-size: 14px; }
                </style>
                <script>setTimeout(() => location.reload(), 3000);</script>
            </head>
            <body>
                <div class="card">
                    <div class="spinner"></div>
                    <h2>Generating Connection Code...</h2>
                    <p>Connecting to WhatsApp servers. This page will auto-refresh in a few seconds.</p>
                </div>
            </body>
            </html>
        `);
    }

    const qrImage = await QRCode.toDataURL(currentQR, { width: 300, margin: 2 });

    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Connect WhatsApp AI</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0b141a; color: #e9edef; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
                .card { background: #111b21; padding: 35px; border-radius: 16px; text-align: center; max-width: 460px; width: 100%; border: 1px solid #202c33; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
                h1 { margin: 0 0 8px; font-size: 22px; }
                p { color: #8696a0; font-size: 14px; margin: 0 0 20px; }
                .qr-box { background: #fff; padding: 12px; border-radius: 12px; display: inline-block; margin-bottom: 20px; }
                .qr-box img { display: block; max-width: 100%; height: auto; }
                .steps { text-align: left; background: #202c33; padding: 16px; border-radius: 10px; font-size: 13px; color: #d1d7db; line-height: 1.6; }
                .steps ol { margin: 0; padding-left: 20px; }
                .refresh-note { font-size: 12px; color: #8696a0; margin-top: 15px; }
            </style>
            <script>setTimeout(() => location.reload(), 20000);</script>
        </head>
        <body>
            <div class="card">
                <h1>Link Your WhatsApp</h1>
                <p>Scan this QR code with WhatsApp on your phone</p>
                
                <div class="qr-box">
                    <img src="${qrImage}" alt="WhatsApp QR Code"/>
                </div>

                <div class="steps">
                    <ol>
                        <li>Open <b>WhatsApp</b> on your phone</li>
                        <li>Tap <b>Settings</b> or <b>3 dots (⋮)</b></li>
                        <li>Select <b>Linked Devices</b> & tap <b>Link a Device</b></li>
                        <li>Point your phone camera at this screen</li>
                    </ol>
                </div>

                <div class="refresh-note">⏳ Auto-refreshes every 20 seconds</div>
            </div>
        </body>
        </html>
    `);
});

// Start server and initialize WhatsApp
app.listen(PORT, () => {
    console.log(`🌐 Web portal listening on port ${PORT}`);
    console.log(`👉 Open http://localhost:${PORT}/scan to link WhatsApp`);
    initWhatsApp();
});
