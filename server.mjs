import express from 'express';
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers,
    jidNormalizedUser,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import { MongoClient } from 'mongodb';
import fs from 'fs/promises';
import QRCode from 'qrcode';
import pino from 'pino';
import 'dotenv/config';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;

// Configuration
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const MONGODB_URI = process.env.MONGODB_URI || '';
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'whatsapp_bot';
const SESSION_ID = process.env.SESSION_ID || 'default';
const SCAN_SECRET = process.env.SCAN_SECRET || '';
const BOT_API_SECRET = process.env.BOT_API_SECRET || '';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
    'You are a helpful, professional, and friendly AI assistant. Answer concisely with clean formatting (*bold*, _italic_, bullet points, emojis). Avoid markdown hashtags.';

// Active Groq models fallback chain: Flagship 120B first for maximum intelligence
const GROQ_MODELS = [
    'openai/gpt-oss-120b',       // Flagship 120B model (GPT-4 class intelligence, ~500 tokens/sec)
    'openai/gpt-oss-20b',        // High-speed fallback (1000 tokens/sec)
    'qwen/qwen3.8-27b'           // High reasoning multilingual fallback
];

const baileysLogger = pino({ level: 'silent' });

let currentQR = null;
let isConnected = false;
let sock = null;
let isShuttingDown = false;
let mongoClient = null;
let authCollection = null;
let memoryCollection = null;

// Bounded in-memory cache for conversation history (max 500 users to prevent RAM bloat)
const MAX_CACHED_CHATS = 500;
const conversationMemory = new Map();

// =============================================================
// 0. DATABASE CONNECTION & MONGODB AUTH ADAPTER
// =============================================================
async function initDatabase() {
    if (!MONGODB_URI) {
        console.log('⚠️ MONGODB_URI not set. Using local ./session_auth (recommended only on VPS with persistent disk).');
        return;
    }

    try {
        mongoClient = new MongoClient(MONGODB_URI, {
            serverSelectionTimeoutMS: 10000,
            maxPoolSize: 10
        });
        await mongoClient.connect();
        const db = mongoClient.db(MONGODB_DB_NAME);
        authCollection = db.collection('auth_state');
        memoryCollection = db.collection('chat_memory');
        console.log(`✅ Connected to MongoDB (${MONGODB_DB_NAME}) — WhatsApp sessions & chat memory are now persistent!`);
    } catch (err) {
        console.error('❌ MongoDB connection failed, falling back to local disk:', err.message);
        mongoClient = null;
        authCollection = null;
        memoryCollection = null;
    }
}

/**
 * Custom Baileys AuthState adapter backed by MongoDB Atlas.
 * Survives Render restarts, redeploys, and spin-downs without re-scanning QR!
 */
async function useMongoAuthState(collection, sessionId) {
    const docId = (key) => `${sessionId}:${key}`;

    const readData = async (key) => {
        const doc = await collection.findOne({ _id: docId(key) });
        if (!doc?.data) return null;
        return JSON.parse(doc.data, BufferJSON.reviver);
    };

    const writeData = async (data, key) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await collection.updateOne(
            { _id: docId(key) },
            { $set: { _id: docId(key), sessionId, data: serialized, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const creds = (await readData('creds')) || initAuthCreds();

    const rawKeys = {
        get: async (type, ids) => {
            const data = {};
            if (!ids.length) return data;

            const lookupIds = ids.map((id) => docId(`${type}-${id}`));
            const docs = await collection.find({ _id: { $in: lookupIds } }).toArray();
            const docMap = new Map(docs.map((d) => [d._id, d.data]));

            for (const id of ids) {
                const raw = docMap.get(docId(`${type}-${id}`));
                if (raw) {
                    let value = JSON.parse(raw, BufferJSON.reviver);
                    if (type === 'app-state-sync-key' && value) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    data[id] = value;
                }
            }
            return data;
        },
        set: async (data) => {
            const ops = [];
            const now = new Date();

            for (const category in data) {
                for (const id in data[category]) {
                    const value = data[category][id];
                    const fullId = docId(`${category}-${id}`);
                    if (value) {
                        ops.push({
                            updateOne: {
                                filter: { _id: fullId },
                                update: {
                                    $set: {
                                        _id: fullId,
                                        sessionId,
                                        data: JSON.stringify(value, BufferJSON.replacer),
                                        updatedAt: now
                                    }
                                },
                                upsert: true
                            }
                        });
                    } else {
                        ops.push({ deleteOne: { filter: { _id: fullId } } });
                    }
                }
            }

            if (ops.length > 0) {
                await collection.bulkWrite(ops, { ordered: false });
            }
        }
    };

    return {
        state: {
            creds,
            // Wrap with Baileys native RAM cache so Signal key lookups are instant
            keys: makeCacheableSignalKeyStore(rawKeys, baileysLogger)
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
}

async function clearSessionAuth() {
    if (authCollection) {
        await authCollection.deleteMany({ sessionId: SESSION_ID }).catch(() => {});
        console.log('🧹 Cleared stale MongoDB session auth.');
    } else {
        await fs.rm('./session_auth', { recursive: true, force: true }).catch(() => {});
        console.log('🧹 Cleared stale local ./session_auth directory.');
    }
}

async function getChatHistory(sessionKey) {
    if (conversationMemory.has(sessionKey)) {
        const existing = conversationMemory.get(sessionKey);
        // Refresh LRU order
        conversationMemory.delete(sessionKey);
        conversationMemory.set(sessionKey, existing);
        return existing;
    }

    let history = [{ role: 'system', content: SYSTEM_PROMPT }];
    if (memoryCollection) {
        try {
            const doc = await memoryCollection.findOne({ _id: sessionKey });
            if (Array.isArray(doc?.messages) && doc.messages.length > 0) {
                // Always keep latest SYSTEM_PROMPT at index 0
                history = [{ role: 'system', content: SYSTEM_PROMPT }, ...doc.messages.slice(-8)];
            }
        } catch (err) {
            console.warn('[Memory Read Error]:', err.message);
        }
    }

    if (conversationMemory.size >= MAX_CACHED_CHATS) {
        const oldestKey = conversationMemory.keys().next().value;
        conversationMemory.delete(oldestKey);
    }
    conversationMemory.set(sessionKey, history);
    return history;
}

async function persistChatHistory(sessionKey, history) {
    if (!memoryCollection) return;
    try {
        // Store turns without repeating system prompt
        const turns = history.slice(1).slice(-8);
        await memoryCollection.updateOne(
            { _id: sessionKey },
            { $set: { _id: sessionKey, messages: turns, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (err) {
        console.warn('[Memory Write Error]:', err.message);
    }
}

// =============================================================
// 1. STATISTICAL HUMAN PACER & TYPING CADENCE
// =============================================================
class HumanMath {
    static normal(mean, stdDev) {
        let u1 = 0, u2 = 0;
        while (u1 === 0) u1 = Math.random();
        while (u2 === 0) u2 = Math.random();
        const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
        return mean + z0 * stdDev;
    }

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
        return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
    }
}

class HumanTypingSimulator {
    static getReadDwellTime() {
        return HumanMath.clamp(HumanMath.logNormal(1400, 0.35), 800, 2800);
    }

    static getThinkingDelay(incomingText) {
        const charCount = (incomingText || '').trim().length;
        const readingTime = charCount * HumanMath.normal(45, 8);
        const formulationTime = HumanMath.logNormal(1800, 0.35);
        const motorPrep = HumanMath.normal(350, 80);
        return HumanMath.clamp(readingTime + formulationTime + motorPrep, 1200, 4500);
    }

    static getTypingDuration(replyText) {
        const chars = (replyText || '').length;
        const duration = chars * 15;
        const jitter = HumanMath.normal(200, 100);
        return HumanMath.clamp(duration + jitter, 1200, 3500);
    }
}

// =============================================================
// 2. INBOUND DEBOUNCER & SINGLE-CONCURRENCY QUEUE
// =============================================================
class WhatsAppDebouncer {
    constructor(idleTimeoutMs = 1500, maxWaitMs = 6000) {
        this.idleTimeoutMs = idleTimeoutMs;
        this.maxWaitMs = maxWaitMs;
        this.buffers = new Map();
        this.handler = null;
    }

    onBatch(handler) {
        this.handler = handler;
    }

    enqueue(jid, msg, text) {
        let entry = this.buffers.get(jid);
        if (!entry) {
            entry = {
                texts: [],
                messages: [],
                idleTimer: null,
                maxWaitTimer: null
            };

            entry.maxWaitTimer = setTimeout(() => {
                this.flush(jid, 'maxWait');
            }, this.maxWaitMs);

            this.buffers.set(jid, entry);
        }

        entry.texts.push(text);
        entry.messages.push(msg);

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
        const lastMsg = entry.messages[entry.messages.length - 1];
        const allKeys = entry.messages.map((m) => m.key).filter(Boolean);
        this.cleanup(jid);

        if (this.handler) {
            this.handler(jid, mergedText, lastMsg, allKeys);
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

class PerJidQueue {
    constructor() {
        this.queues = new Map();
    }

    add(jid, task) {
        const currentQueue = this.queues.get(jid) || Promise.resolve();
        const nextQueue = currentQueue
            .then(() => task())
            .catch((err) => console.error(`[Queue Error] Error on JID ${jid}:`, err))
            .finally(() => {
                if (this.queues.get(jid) === nextQueue) {
                    this.queues.delete(jid);
                }
            });

        this.queues.set(jid, nextQueue);
    }
}

const debouncer = new WhatsAppDebouncer(1500, 6000);
const jidQueue = new PerJidQueue();

// =============================================================
// 3. MULTI-PROVIDER AI ENGINE (GROQ -> OPENROUTER -> GEMINI)
// =============================================================
function formatForChannel(text, channel = 'wa') {
    let cleaned = text.replace(/^#+\s*(.*)$/gm, '*$1*');
    if (channel !== 'wa') {
        // IG/FB don't render WhatsApp *bold* syntax; strip single asterisks cleanly if plain text preferred
        cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
    }
    return cleaned;
}

async function callLLMWithFallback(sessionKey, userPrompt, channel = 'wa') {
    const history = await getChatHistory(sessionKey);
    history.push({ role: 'user', content: userPrompt });

    // Keep context window tight (last 8 turns max)
    if (history.length > 9) {
        history.splice(1, 2);
    }

    const finalize = async (rawReply) => {
        const formatted = formatForChannel(rawReply, channel);
        history.push({ role: 'assistant', content: formatted });
        await persistChatHistory(sessionKey, history);
        return formatted;
    };

    // 1. Try Groq with multi-model fallback chain
    if (GROQ_API_KEY) {
        for (const modelId of GROQ_MODELS) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);

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
                    const reply = data.choices?.[0]?.message?.content?.trim();
                    if (reply) return await finalize(reply);
                }

                const errBody = await response.json().catch(() => ({}));
                console.warn(`[Groq Warning] Model '${modelId}' returned ${response.status}:`, errBody?.error?.message || response.statusText);
                if (response.status === 401) break;
            } catch (err) {
                console.warn(`[Groq Catch] Model '${modelId}' failed:`, err.message);
            }
        }
    }

    // 2. OpenRouter free tier fallback
    if (OPENROUTER_API_KEY) {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'https://localhost',
                    'X-Title': 'Omnichannel AI Bot'
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
                const reply = data.choices?.[0]?.message?.content?.trim();
                if (reply) return await finalize(reply);
            }
        } catch (e) {
            console.error('[OpenRouter Error]:', e.message);
        }
    }

    // 3. Google Gemini Flash free tier fallback
    if (GEMINI_API_KEY) {
        try {
            const contents = history.slice(1).map((m) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }));
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                        contents,
                        generationConfig: { maxOutputTokens: 800, temperature: 0.7 }
                    })
                }
            );

            if (response.ok) {
                const data = await response.json();
                const reply = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
                if (reply) return await finalize(reply);
            }
        } catch (e) {
            console.error('[Gemini Error]:', e.message);
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
        const authResult = authCollection
            ? await useMongoAuthState(authCollection, SESSION_ID)
            : await useMultiFileAuthState('./session_auth');

        const { state, saveCreds } = authResult;

        let version = [2, 3000, 1015901307];
        try {
            const latest = await fetchLatestWaWebVersion();
            if (latest?.version) version = latest.version;
        } catch {}

        sock = makeWASocket({
            version,
            auth: state,
            logger: baileysLogger,
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            syncFullHistory: false,
            shouldSyncHistoryMessage: () => false,
            markOnlineOnConnect: false,
            keepAliveIntervalMs: 30000,
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
                if (isShuttingDown) return;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.warn(`Connection closed with status code: ${statusCode}`);

                if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                    console.log('Server requested restart (code 515). Reconnecting immediately...');
                    setTimeout(initWhatsApp, 400);
                    return;
                }

                // Code 401 or 500: Clear dead auth and restart fresh QR flow on /scan
                if (
                    statusCode === 401 ||
                    statusCode === DisconnectReason.loggedOut ||
                    statusCode === 500 ||
                    statusCode === DisconnectReason.badSession
                ) {
                    console.error(`Session invalidated (code ${statusCode}). Clearing auth and regenerating QR...`);
                    currentQR = null;
                    await clearSessionAuth();
                    setTimeout(initWhatsApp, 1500);
                    return;
                }

                if (statusCode === 403 || statusCode === DisconnectReason.forbidden) {
                    console.error('CRITICAL: Access forbidden/banned (code 403). Halting all reconnection.');
                    return;
                }

                if (statusCode === 440 || statusCode === DisconnectReason.connectionReplaced) {
                    console.error('Conflict: Connection replaced by another instance (code 440).');
                    return;
                }

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

        sock.ev.on('messages.upsert', async ({ messages, type }) => {
            if (type !== 'notify') return;

            for (const msg of messages) {
                if (!msg.message || msg.key.fromMe) continue;
                const jid = msg.key.remoteJid;
                if (!jid) continue;

                if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;

                const text = (
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    ''
                ).trim();
                if (!text) continue;

                const isGroup = jid.endsWith('@g.us');
                if (isGroup) {
                    const botPnJid = jidNormalizedUser(sock.user?.id || '');
                    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const isMentioned = mentionedJids.some((j) => jidNormalizedUser(j) === botPnJid);
                    const isQuoted = jidNormalizedUser(msg.message.extendedTextMessage?.contextInfo?.participant || '') === botPnJid;
                    const hasPrefix = text.startsWith('!ai') || text.startsWith('/ask');

                    if (!isMentioned && !isQuoted && !hasPrefix) continue;
                }

                debouncer.enqueue(jid, msg, text);
            }
        });
    } catch (err) {
        console.error('Fatal initialization error:', err.message);
    }
}

debouncer.onBatch((jid, mergedText, lastMsg, allKeys) => {
    jidQueue.add(jid, async () => {
        if (!sock || !isConnected) return;

        try {
            const readDwell = HumanTypingSimulator.getReadDwellTime();
            await HumanMath.sleep(readDwell);

            try {
                if (allKeys.length > 0) {
                    await sock.readMessages(allKeys);
                }
            } catch {}

            const thinkingDelay = HumanTypingSimulator.getThinkingDelay(mergedText);
            await HumanMath.sleep(thinkingDelay);

            const replyText = await callLLMWithFallback(`wa:${jid}`, mergedText, 'wa');

            const typingDuration = HumanTypingSimulator.getTypingDuration(replyText);
            try {
                await sock.sendPresenceUpdate('composing', jid);
            } catch {}
            await HumanMath.sleep(typingDuration);

            try {
                await sock.sendPresenceUpdate('paused', jid);
            } catch {}

            await HumanMath.sleep(250);

            const quoteOption = (lastMsg && lastMsg.message) ? { quoted: lastMsg } : {};
            await sock.sendMessage(jid, { text: replyText }, quoteOption);
        } catch (err) {
            console.error(`Error processing batch for ${jid}:`, err.message);
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}
        }
    });
});

// =============================================================
// 5. WEB PORTAL, HEALTH CHECK & OMNICHANNEL /api/chat
// =============================================================
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        connected: isConnected,
        storage: authCollection ? 'mongodb' : 'local_disk',
        activeModel: GROQ_MODELS[0],
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString()
    });
});

// Omnichannel endpoint for local Instagram / Facebook / Android connectors
app.post('/api/chat', async (req, res) => {
    if (BOT_API_SECRET) {
        const provided = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
        if (provided !== BOT_API_SECRET) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    const { channel = 'ext', userId, text } = req.body || {};
    if (!userId || !text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Missing userId or text' });
    }

    try {
        const sessionKey = `${channel}:${userId}`;
        const reply = await callLLMWithFallback(sessionKey, text.trim(), channel);
        return res.json({ reply });
    } catch (err) {
        console.error('[/api/chat Error]:', err.message);
        return res.status(500).json({ error: 'Inference failed' });
    }
});

app.get('/', (req, res) => res.redirect(SCAN_SECRET ? `/scan?key=${encodeURIComponent(SCAN_SECRET)}` : '/scan'));

app.get('/scan', async (req, res) => {
    if (SCAN_SECRET && req.query.key !== SCAN_SECRET) {
        return res.status(403).send('<h2>403 Forbidden</h2><p>Valid ?key= parameter required.</p>');
    }

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
                    <p>Storage: <b>${authCollection ? 'MongoDB Persistent' : 'Local Disk'}</b>. Protected by Anti-Ban presence emulation, debouncing, and AI fallback.</p>
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

// Graceful shutdown
async function shutdown(signal) {
    console.log(`${signal} received. Closing sockets gracefully...`);
    isShuttingDown = true;
    if (sock) {
        try { sock.end(undefined); } catch {}
    }
    if (mongoClient) {
        try { await mongoClient.close(); } catch {}
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Boot sequence
async function start() {
    await initDatabase();
    app.listen(PORT, () => {
        console.log(`🌐 Web portal listening on port ${PORT}`);
        initWhatsApp();
    });
}

start();
