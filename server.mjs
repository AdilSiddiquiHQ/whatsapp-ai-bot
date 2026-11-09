import express from 'express';
import makeWASocket, { 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestWaWebVersion, 
    Browsers,
    jidNormalizedUser
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import 'dotenv/config';

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || 
    'You are a helpful, professional, and friendly WhatsApp AI assistant. Answer concisely with clean WhatsApp formatting (*bold*, _italic_, bullet points, emojis). Avoid markdown hashtags.';

// Active Groq models fallback chain
const GROQ_MODELS = [
    'llama-3.1-8b-instant',      // Fastest, 100% active, reliable on all tiers
    'llama-3.3-70b-versatile',   // High intelligence (used if account has access)
    'openai/gpt-oss-20b'         // Backup fallback
];

let currentQR = null;
let isConnected = false;
let sock = null;
let isShuttingDown = false;

// Per-contact conversation memory
const conversationMemory = new Map();

// =============================================================
// 1. STATISTICAL HUMAN PACER & TYPING CADENCE
// =============================================================
class HumanMath {
    // Box-Muller transform for realistic Gaussian distribution
    static normal(mean, stdDev) {
        let u1 = 0, u2 = 0;
        while (u1 === 0) u1 = Math.random();
        while (u2 === 0) u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return mean + z0 * stdDev;
    }

    // Log-normal distribution for human reaction times (skewed right)
    static logNormal(median, sigma = 0.35) {
        const mu = Math.log(median);
        let u1 = 0, u2 = 0;
        while (u1 === 0) u1 = Math.random();
        while (u2 === 0) u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return Math.exp(mu + z0 * sigma);
    }

    static clamp(val, min, max) {
        return Math.min(Math.max(val, min), max);
    }

    static sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, Math.round(ms))));
    }
}

class HumanTypingSimulator {
    // 1. Dwell time before sending read receipt (blue tick)
    static getReadDwellTime() {
        return HumanMath.clamp(HumanMath.logNormal(1400, 0.35), 800, 2800);
    }

    // 2. Reading comprehension + cognitive formulation time before typing starts
    static getThinkingDelay(incomingText) {
        const charCount = (incomingText || '').trim().length;
        // Average reading speed: ~45ms per character (240 WPM)
        const readingTime = charCount * HumanMath.normal(45, 8);
        const formulationTime = HumanMath.logNormal(1800, 0.35);
        const motorPrep = HumanMath.normal(350, 80);
        return HumanMath.clamp(readingTime + formulationTime + motorPrep, 1200, 4500);
    }

    // 3. Realistic typing duration calculation based on mobile 36.5 WPM baseline
    static calculateTypingPlan(replyText) {
        const targetWpm = HumanMath.clamp(HumanMath.normal(36.5, 4), 28, 45);
        const baseIki = (60000 / (targetWpm * 5)); // ms per character (~330ms)

        const words = (replyText || '').split(/\s+/);
        const actions = [];
        let currentComposing = 0;
        let wordCounter = 0;
        const wordsUntilPause = Math.round(HumanMath.normal(8, 2));

        for (let w = 0; w < words.length; w++) {
            const word = words[w];
            wordCounter++;

            for (let i = 0; i < word.length; i++) {
                const char = word[i];
                let multiplier = 1.0;
                if (/[.,?!:;"']/.test(char)) {
                    multiplier = HumanMath.normal(2.0, 0.3); // Punctuation takes longer
                } else if (/[A-Z0-9]/.test(char)) {
                    multiplier = HumanMath.normal(1.4, 0.2); // Shift / uppercase takes longer
                } else {
                    multiplier = HumanMath.logNormal(1.0, 0.2);
                }
                currentComposing += baseIki * multiplier;
            }

            // Spacebar pause
            currentComposing += baseIki * HumanMath.normal(1.3, 0.2);

            // Natural cognitive micro-pause every 7-10 words on long text
            if (wordCounter >= wordsUntilPause && w < words.length - 1) {
                actions.push({ type: 'composing', duration: Math.round(currentComposing) });
                currentComposing = 0;
                const pauseDuration = HumanMath.clamp(HumanMath.logNormal(1600, 0.3), 1000, 2500);
                actions.push({ type: 'paused', duration: Math.round(pauseDuration) });
                wordCounter = 0;
            }
        }

        if (currentComposing > 0) {
            actions.push({ type: 'composing', duration: Math.round(currentComposing) });
        }

        return actions;
    }
}

// =============================================================
// 2. INBOUND DEBOUNCER & SINGLE-CONCURRENCY QUEUE
// =============================================================
class WhatsAppDebouncer {
    constructor(idleTimeoutMs = 3500, maxWaitMs = 12000) {
        this.idleTimeoutMs = idleTimeoutMs;
        this.maxWaitMs = maxWaitMs;
        this.buffers = new Map();
        this.handler = null;
    }

    onBatch(handler) {
        this.handler = handler;
    }

    enqueue(jid, messageKey, text) {
        let entry = this.buffers.get(jid);
        if (!entry) {
            entry = {
                texts: [],
                keys: [],
                idleTimer: null,
                maxWaitTimer: null
            };

            entry.maxWaitTimer = setTimeout(() => {
                this.flush(jid, 'maxWait');
            }, this.maxWaitMs);

            this.buffers.set(jid, entry);
        }

        entry.texts.push(text);
        entry.keys.push(messageKey);

        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => {
            this.flush(jid, 'idle');
        }, this.idleTimeoutMs);
    }

    flush(jid, reason) {
        const entry = this.buffers.get(jid);
        if (!entry || entry.texts.length === 0) {
            this.cleanup(jid);
            return;
        }

        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);

        const mergedText = entry.texts.join('\n');
        const lastKey = entry.keys[entry.keys.length - 1];
        const allKeys = [...entry.keys];
        this.cleanup(jid);

        if (this.handler) {
            this.handler(jid, mergedText, lastKey, allKeys);
        }
    }

    cleanup(jid) {
        const entry = this.buffers.get(jid);
        if (entry) {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
            this.buffers.delete(jid);
        }
    }
}

// Per-JID Sequential Execution Queue (enforces concurrency = 1)
class PerJidQueue {
    constructor() {
        this.queues = new Map();
    }

    add(jid, task) {
        const currentQueue = this.queues.get(jid) || Promise.resolve();
        const nextQueue = currentQueue
            .then(() => task())
            .catch(err => console.error(`[Queue Error] Error on JID ${jid}:`, err))
            .finally(() => {
                if (this.queues.get(jid) === nextQueue) {
                    this.queues.delete(jid);
                }
            });

        this.queues.set(jid, nextQueue);
    }
}

const debouncer = new WhatsAppDebouncer(3500, 12000);
const jidQueue = new PerJidQueue();

// =============================================================
// 3. GROQ MULTI-MODEL FALLBACK ENGINE
// =============================================================
async function callLLMWithFallback(jid, userPrompt) {
    if (!conversationMemory.has(jid)) {
        conversationMemory.set(jid, [
            { role: 'system', content: SYSTEM_PROMPT }
        ]);
    }

    const history = conversationMemory.get(jid);
    history.push({ role: 'user', content: userPrompt });

    // Keep context window tight (last 8 turns max)
    if (history.length > 9) {
        history.splice(1, 2);
    }

    // 1. Try Groq with multi-model fallback chain
    if (GROQ_API_KEY) {
        for (const modelId of GROQ_MODELS) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

                const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${GROQ_API_KEY}`
                    },
                    body: JSON.stringify({
                        model: modelId,
                        messages: history,
                        max_tokens: 800,
                        temperature: 0.7
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (response.ok) {
                    const data = await response.json();
                    let reply = data.choices?.[0]?.message?.content?.trim();
                    if (reply) {
                        // Clean up markdown hashes for WhatsApp formatting
                        reply = reply.replace(/^#+\s*(.*)$/gm, '*$1*');
                        history.push({ role: 'assistant', content: reply });
                        return reply;
                    }
                }

                const errBody = await response.json().catch(() => ({}));
                console.warn(`[Groq Warning] Model '${modelId}' returned ${response.status}:`, errBody?.error?.message || response.statusText);

                // If fatal auth error, do not loop
                if (response.status === 401) {
                    console.error('[Groq Fatal] Invalid GROQ_API_KEY.');
                    break;
                }

                // If 404 (model_not_found) or 429 (rate_limit), continue to next model in chain!
            } catch (err) {
                console.warn(`[Groq Catch] Model '${modelId}' failed:`, err.message);
            }
        }
    }

    // 2. OpenRouter fallback if configured
    if (OPENROUTER_API_KEY) {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://localhost',
                    'X-Title': 'WhatsApp Bot'
                },
                body: JSON.stringify({
                    model: 'meta-llama/llama-3.3-70b-instruct:free',
                    messages: history,
                    max_tokens: 800,
                    temperature: 0.7
                })
            });

            if (response.ok) {
                const data = await response.json();
                let reply = data.choices?.[0]?.message?.content?.trim();
                if (reply) {
                    reply = reply.replace(/^#+\s*(.*)$/gm, '*$1*');
                    history.push({ role: 'assistant', content: reply });
                    return reply;
                }
            }
        } catch (e) {
            console.error('[OpenRouter Error]:', e.message);
        }
    }

    return "⚠️ I am momentarily experiencing high demand. Please ask your question again in a few seconds!";
}

// =============================================================
// 4. WHATSAPP SOCKET & RECONNECTION STATE MACHINE
// =============================================================
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 8;

async function initWhatsApp() {
    if (isShuttingDown) return;

    try {
        const { state, saveCreds } = await useMultiFileAuthState('./session_auth');

        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestWaWebVersion();
            if (latest?.version) version = latest.version;
        } catch {}

        sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'), // High-trust official desktop signature
            syncFullHistory: false,             // Prevent history replay overload
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,         // STEALTH: Never broadcast 24/7 online presence (defeats bot heuristics)
            keepAliveIntervalMs: 30000,         // Standard 30s heartbeat
            connectTimeoutMs: 30000,
            appStateMacVerification: {
                patch: false,
                snapshot: false
            }
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                currentQR = qr;
            }

            if (connection === 'open') {
                isConnected = true;
                currentQR = null;
                reconnectAttempts = 0;
                console.log('🎉 WhatsApp AI Bot successfully connected and listening!');
            } else if (connection === 'close') {
                isConnected = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.warn(`Connection closed with status code: ${statusCode}`);

                // Code 515: Restart Required -> Immediate reconnect (normal protocol event)
                if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                    console.log('Server requested restart (code 515). Reconnecting immediately...');
                    setTimeout(initWhatsApp, 400);
                    return;
                }

                // Code 401: Logged Out -> STOP. Do NOT loop reconnect.
                if (statusCode === 401 || statusCode === DisconnectReason.loggedOut) {
                    console.error('Session logged out or unlinked (code 401). Awaiting new QR scan.');
                    currentQR = null;
                    return;
                }

                // Code 403: Forbidden / Banned -> STOP.
                if (statusCode === 403 || statusCode === DisconnectReason.forbidden) {
                    console.error('CRITICAL: Access forbidden/banned (code 403). Halting all reconnection.');
                    return;
                }

                // Code 440: Connection Replaced -> STOP (prevents split-brain ping pong)
                if (statusCode === 440 || statusCode === DisconnectReason.connectionReplaced) {
                    console.error('Conflict: Connection replaced by another instance (code 440).');
                    return;
                }

                // Transient Disconnects (408, 428, 503): Exponential backoff with jitter
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    reconnectAttempts++;
                    const backoffMs = Math.min(60000, Math.pow(2, reconnectAttempts) * 1000 + Math.floor(Math.random() * 1500));
                    console.log(`Reconnecting attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${backoffMs}ms...`);
                    setTimeout(initWhatsApp, backoffMs);
                } else {
                    console.error('Max reconnection attempts reached. Pausing socket.');
                }
            }
        });

        // Inbound message listener
        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return; // Ignore background sync

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid) continue;

                // Ignore broadcast lists, status updates, newsletters
                if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

                // Group Chat Armor: Only respond if directly tagged (@bot) or quoted
                const isGroup = jid.endsWith('@g.us');
                if (isGroup) {
                    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
                    const botPnJid = jidNormalizedUser(sock.user?.id || '');
                    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const isMentioned = mentionedJids.some(j => jidNormalizedUser(j) === botPnJid);
                    const isQuoted = jidNormalizedUser(msg.message.extendedTextMessage?.contextInfo?.participant || '') === botPnJid;
                    const hasPrefix = text.startsWith('!ai') || text.startsWith('/ask');

                    if (!isMentioned && !isQuoted && !hasPrefix) {
                        continue; // Silently ignore group chatter to prevent spam bans!
                    }
                }

                const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim();
                if (!text) continue;

                // Pass into sliding debouncer
                debouncer.enqueue(jid, msg.key, text);
            }
        });

    } catch (err) {
        console.error('Fatal initialization error:', err.message);
    }
}

// Handle debounced message batches
debouncer.onBatch((jid, mergedText, lastKey, allKeys) => {
    // Add to strict Single-Concurrency Queue per JID
    jidQueue.add(jid, async () => {
        if (!sock || !isConnected) return;

        try {
            // 1. Dwell delay before Blue Tick (read receipt)
            const readDwell = HumanTypingSimulator.getReadDwellTime();
            await HumanMath.sleep(readDwell);

            // Mark incoming messages as read
            try {
                await sock.readMessages(allKeys);
            } catch {}

            // 2. Thinking Delay (reading time + decision formulation)
            const thinkingDelay = HumanTypingSimulator.getThinkingDelay(mergedText);
            await HumanMath.sleep(thinkingDelay);

            // 3. Generate AI response (using multi-model fallback)
            const replyText = await callLLMWithFallback(jid, mergedText);

            // 4. Execute Human Typing Cadence (composing -> paused -> composing)
            const typingActions = HumanTypingSimulator.calculateTypingPlan(replyText);
            for (const action of typingActions) {
                try {
                    await sock.sendPresenceUpdate(action.type, jid);
                } catch {}
                await HumanMath.sleep(action.duration);
            }

            // 5. Pre-send review dwell (user looks at drafted text before hitting send)
            const preSendReview = HumanMath.clamp(HumanMath.logNormal(400, 0.25), 250, 700);
            await HumanMath.sleep(preSendReview);

            // 6. Send the message
            await sock.sendMessage(jid, { text: replyText }, { quoted: { key: lastKey } });

            // 7. Clear presence
            await sock.sendPresenceUpdate('paused', jid);

        } catch (err) {
            console.error(`Error processing batch for ${jid}:`, err.message);
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}
        }
    });
});

// =============================================================
// 5. WEB PORTAL & HEALTH CHECK (RENDER 24/7)
// =============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: isConnected,
        activeModel: GROQ_MODELS[0],
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => res.redirect('/scan'));

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
                    <p>Protected by Anti-Ban presence emulation, message debouncing, and Groq fallback.</p>
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
                    <p>Connecting to WhatsApp servers. Auto-refreshing in 3 seconds...</p>
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

// Graceful container shutdown (protects session keys on Render restart)
process.on('SIGTERM', async () => {
    console.log('SIGTERM received. Closing WhatsApp socket gracefully...');
    isShuttingDown = true;
    if (sock) {
        try { sock.end(undefined); } catch {}
    }
    process.exit(0);
});

// Start Express and Socket
app.listen(PORT, () => {
    console.log(`🌐 Web portal listening on port ${PORT}`);
    initWhatsApp();
});
