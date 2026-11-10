import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers,
    jidNormalizedUser,
    areJidsSameUser,
    normalizeMessageContent,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    generateMessageIDV2,
    WAMessageStatus,
    WAMessageStubType
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { CONFIG, normalizeLeadStage } from './config.mjs';
import { BoundedCacheStore, SlidingWindowLimiter } from './cache.mjs';
import { authStateCache } from './security.mjs';
import {
    cols,
    addDays,
    getLocalDayAndHour,
    recordActivityLog,
    incrementDailyAnalytics
} from './db.mjs';
import { eventBus } from './stream.mjs';
import { buildTenantSystemPrompt, generateAIReply } from './ai-engine.mjs';
import {
    isAutoresponderMessage,
    detectPromptInjection,
    isClosurePhatic,
    classifyStopIntent
} from './guardrails.mjs';

const silentLogger = pino({ level: 'silent' });
const BROWSER_PROFILES = [
    Browsers.macOS('Desktop'),
    Browsers.ubuntu('Chrome'),
    Browsers.windows('Chrome')
];

let cachedWaVersion = { version: [2, 3000, 1020608120], fetchedAt: 0 };
async function getCachedWaVersion() {
    const now = Date.now();
    if (now - cachedWaVersion.fetchedAt < 6 * 3600_000) {
        return cachedWaVersion.version;
    }
    try {
        const res = await fetchLatestWaWebVersion();
        if (res?.version) {
            cachedWaVersion = { version: res.version, fetchedAt: now };
        }
    } catch {}
    return cachedWaVersion.version;
}

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
        return new Promise((r) => setTimeout(r, Math.max(0, Math.round(ms))));
    }
}

class HumanTypingSimulator {
    static getReadDwell(text = '') {
        if (String(text || '').trim().length < 18) {
            return HumanMath.clamp(HumanMath.normal(380, 70), 250, 550);
        }
        return HumanMath.clamp(HumanMath.logNormal(850, 0.3), 500, 1500);
    }
    static getTypingDuration(replyText, isFollowUpBubble = false) {
        const chars = (replyText || '').length;
        if (isFollowUpBubble) {
            return HumanMath.clamp(chars * 14 + HumanMath.normal(140, 40), 700, 1550);
        }
        const dur = chars * 13 + HumanMath.normal(180, 60);
        return HumanMath.clamp(dur, 850, 2600);
    }
}

export function calculateAdaptiveDebounceMs(textBody, hasAudio, hasImage, baseDebounceMs = 1800) {
    if (hasAudio || hasImage) return 3000;
    const trimmed = String(textBody || '').trim();
    if (!trimmed) return Math.min(3500, Math.max(1200, baseDebounceMs));

    const words = trimmed.split(/\s+/).filter(Boolean);
    const lower = trimmed.toLowerCase();
    const isShortOpener = /^(hi+|hello+|hey+|heylo|hola|yo|good\s*(?:morning|afternoon|evening)|namaste|haan?ji|bhai+|bro|sir|ma'?am|mam|sun|suno)[.!\s]*$/i.test(lower);
    if (isShortOpener || (words.length <= 2 && !trimmed.includes('?'))) {
        return 4200;
    }
    if (/[.,…]$/.test(trimmed) || /\b(aur|and|or|also|plus|wait|ek sec|ruko)\s*$/i.test(lower)) {
        return 3400;
    }
    if (trimmed.includes('?') || words.length >= 8) {
        return Math.min(2200, Math.max(1500, baseDebounceMs));
    }
    return Math.min(3000, Math.max(1800, baseDebounceMs));
}

export function shouldQuoteInboundMessage({ peer, items, lastItem, batchEnqueuedAt, quoteSetting }) {
    if (quoteSetting === false || quoteSetting === 'never') return null;
    if (quoteSetting === 'always') return lastItem?.msg || null;
    if (peer?.isGroup) return lastItem?.msg || null;
    if (Array.isArray(items) && items.length >= 3) return lastItem?.msg || null;
    if (batchEnqueuedAt && Date.now() - batchEnqueuedAt > 30_000) return lastItem?.msg || null;
    return null;
}

export function splitHumanBubbles(rawText, splitEnabled = true) {
    const text = String(rawText || '').trim();
    if (!splitEnabled || text.length < 75) return [text];

    // Keep bulleted/numbered summaries unified in one clean bubble
    if (/^(\s*[-*•]|\s*\d+\.)/m.test(text)) {
        return [text];
    }

    // Split Answer Bubble + Standalone Closing Question Hook Bubble
    const qMatch = text.match(/^([\s\S]{25,}?)(?:\n+|[.!]\s+)([A-Za-z0-9*'"₹$€£,%()/+\-\s]{10,135}\?[\s*]*)$/);
    if (qMatch) {
        const b1 = qMatch[1].trim();
        const b2 = qMatch[2].trim();
        if (b1.length >= 25 && b2.length >= 10) {
            return [b1, b2];
        }
    }

    if (text.includes('\n\n') && text.length > 180) {
        const paras = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
        if (paras.length >= 2 && paras.length <= 3) return paras;
    }

    return [text];
}

class TenantDebouncer {
    constructor(onBatch) {
        this.buffers = new Map();
        this.onBatch = onBatch;
    }
    enqueue(canonicalRef, item, idleMs = 1800, maxWaitMs = 8000) {
        let entry = this.buffers.get(canonicalRef);
        if (!entry) {
            entry = {
                items: [],
                enqueuedAt: Date.now(),
                maxWaitMs,
                idleTimer: null,
                maxWaitTimer: null
            };
            entry.maxWaitTimer = setTimeout(() => this.flush(canonicalRef), maxWaitMs);
            this.buffers.set(canonicalRef, entry);
        }
        entry.items.push(item);
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => this.flush(canonicalRef), idleMs);
    }
    revokeMessage(canonicalRef, targetMsgId) {
        if (!targetMsgId) return false;
        const entry = this.buffers.get(canonicalRef);
        if (!entry) return false;
        const prevLen = entry.items.length;
        entry.items = entry.items.filter((it) => it.msg?.key?.id !== targetMsgId);
        if (entry.items.length === 0) {
            this.cleanup(canonicalRef);
            return prevLen > 0;
        }
        return entry.items.length < prevLen;
    }
    editMessage(canonicalRef, targetMsgId, newText) {
        if (!targetMsgId) return false;
        const entry = this.buffers.get(canonicalRef);
        if (!entry) return false;
        const target = entry.items.find((it) => it.msg?.key?.id === targetMsgId);
        if (!target) return false;
        target.textBody = newText;
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        entry.idleTimer = setTimeout(() => this.flush(canonicalRef), 1500);
        return true;
    }
    extendForPresence(canonicalRef, presenceState) {
        const entry = this.buffers.get(canonicalRef);
        if (!entry) return;
        if (presenceState === 'composing' || presenceState === 'recording') {
            const remainingMax = entry.maxWaitMs - (Date.now() - entry.enqueuedAt);
            if (remainingMax > 1000) {
                if (entry.idleTimer) clearTimeout(entry.idleTimer);
                entry.idleTimer = setTimeout(() => this.flush(canonicalRef), Math.min(2400, remainingMax));
            }
        } else if (presenceState === 'paused' || presenceState === 'available') {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            entry.idleTimer = setTimeout(() => this.flush(canonicalRef), 900);
        }
    }
    flush(canonicalRef) {
        const entry = this.buffers.get(canonicalRef);
        if (!entry || entry.items.length === 0) {
            this.cleanup(canonicalRef);
            return;
        }
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
        this.buffers.delete(canonicalRef);
        this.onBatch(canonicalRef, entry.items, entry.enqueuedAt);
    }
    cleanup(canonicalRef) {
        const entry = this.buffers.get(canonicalRef);
        if (entry) {
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
            if (entry.maxWaitTimer) clearTimeout(entry.maxWaitTimer);
            this.buffers.delete(canonicalRef);
        }
    }
    cleanupAll() {
        for (const k of this.buffers.keys()) this.cleanup(k);
    }
}

class PerChatQueue {
    constructor() {
        this.queues = new Map();
    }
    add(key, fn) {
        const prev = this.queues.get(key) || Promise.resolve();
        const next = prev
            .then(() => fn())
            .catch(() => {})
            .finally(() => {
                if (this.queues.get(key) === next) this.queues.delete(key);
            });
        this.queues.set(key, next);
    }
    clearAll() {
        this.queues.clear();
    }
}

export function normalizeDigits(raw) {
    return String(raw || '').replace(/[^\d]/g, '');
}

export function formatPhoneDisplay(digits) {
    const clean = normalizeDigits(digits);
    if (!clean) return '';
    return `+${clean}`;
}

function isWithinOperatingWindow(safety) {
    const mode = safety?.operatingMode || 'always';
    if (mode === 'always') return { aiAllowed: true, reason: 'always' };

    const tz = safety?.timezone || 'Asia/Kolkata';
    const now = new Date();
    let weekday = 'mon';
    let hhmm = '12:00';
    try {
        const fmt = new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            weekday: 'short',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        }).formatToParts(now);
        const get = (t) => fmt.find((p) => p.type === t)?.value || '';
        weekday = get('weekday').slice(0, 3).toLowerCase();
        const h = String(Number(get('hour')) % 24).padStart(2, '0');
        const m = String(Number(get('minute'))).padStart(2, '0');
        hhmm = `${h}:${m}`;
    } catch {}

    const sched = safety?.workHours?.[weekday] || { enabled: true, open: '09:30', close: '19:30' };
    let isOpenHours = false;
    if (sched.enabled) {
        const { open, close } = sched;
        if (open <= close) {
            isOpenHours = hhmm >= open && hhmm <= close;
        } else {
            // Overnight schedule support
            isOpenHours = hhmm >= open || hhmm <= close;
        }
    }

    if (mode === 'business_hours') {
        return { aiAllowed: isOpenHours, reason: isOpenHours ? 'open' : 'closed' };
    }
    if (mode === 'after_hours_only') {
        return { aiAllowed: !isOpenHours, reason: !isOpenHours ? 'after_hours' : 'staff_hours' };
    }
    return { aiAllowed: true, reason: 'default' };
}

async function useTenantMongoAuthState(tenantId) {
    const col = cols.waAuth;
    const docId = (key) => `${tenantId}:${key}`;

    const readData = async (key) => {
        const doc = await col.findOne({ _id: docId(key) });
        if (!doc?.data) return null;
        return JSON.parse(doc.data, BufferJSON.reviver);
    };

    const writeData = async (data, key) => {
        const serialized = JSON.stringify(data, BufferJSON.replacer);
        await col.updateOne(
            { _id: docId(key) },
            { $set: { _id: docId(key), tenantId, data: serialized, updatedAt: new Date() } },
            { upsert: true }
        );
    };

    const creds = (await readData('creds')) || initAuthCreds();
    const signalCache = new BoundedCacheStore(300_000, 350);

    const rawKeys = {
        get: async (type, ids) => {
            const data = {};
            if (!ids.length) return data;
            const lookupIds = ids.map((id) => docId(`${type}-${id}`));
            const docs = await col.find({ _id: { $in: lookupIds } }).toArray();
            const map = new Map(docs.map((d) => [d._id, d.data]));

            for (const id of ids) {
                const raw = map.get(docId(`${type}-${id}`));
                if (raw) {
                    let val = JSON.parse(raw, BufferJSON.reviver);
                    if (type === 'app-state-sync-key' && val) {
                        val = proto.Message.AppStateSyncKeyData.fromObject(val);
                    }
                    data[id] = val;
                }
            }
            return data;
        },
        set: async (data) => {
            const ops = [];
            const now = new Date();
            for (const cat in data) {
                for (const id in data[cat]) {
                    const val = data[cat][id];
                    const fullId = docId(`${cat}-${id}`);
                    if (val) {
                        ops.push({
                            updateOne: {
                                filter: { _id: fullId },
                                update: {
                                    $set: {
                                        _id: fullId,
                                        tenantId,
                                        data: JSON.stringify(val, BufferJSON.replacer),
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
                await col.bulkWrite(ops, { ordered: false });
            }
        }
    };

    return {
        state: {
            creds,
            keys: makeCacheableSignalKeyStore(rawKeys, silentLogger, signalCache)
        },
        saveCreds: async () => {
            await writeData(creds, 'creds');
        }
    };
}

class TenantRuntime {
    constructor(tenantId) {
        this.tenantId = tenantId;
        this.sock = null;
        this.status = 'disconnected'; // disconnected | connecting | qr_ready | open | cooldown | forbidden
        this.currentQR = null;
        this.currentQRDataUrl = null;
        this.pairingCode = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.isStopping = false;
        this.isShuttingDownSocket = false;
        this.bootTimeMs = Date.now();
        this.circuitBreakerUntil = 0;
        this.circuitReason = '';
        this.pausedUntilCache = new BoundedCacheStore(3600_000, 300); // ref -> { pausedAt, pausedUntil }
        this.awayDedupCache = new BoundedCacheStore(12 * 3600_000, 300);
        this.lidToPn = new BoundedCacheStore(24 * 3600_000, 500);
        this.botSentIds = new BoundedCacheStore(600_000, 400);
        this.userFloodLimiter = new SlidingWindowLimiter(1000);
        this.hourlyCounter = { key: '', count: 0 };
        this.pairingWaiters = [];

        // Strictly bounded Baileys internal caches (eliminates RAM creep on 512MB)
        this.msgRetryCounterCache = new BoundedCacheStore(300_000, 150);
        this.placeholderResendCache = new BoundedCacheStore(300_000, 150);
        this.userDevicesCache = new BoundedCacheStore(300_000, 150);
        this.callOfferCache = new BoundedCacheStore(120_000, 80);
        this.mediaCache = new BoundedCacheStore(180_000, 60);
        // Tiny 120-slot retry buffer to prevent "Waiting for this message" on Signal retries (<100 KB)
        this.sentProtoBuffer = new BoundedCacheStore(12 * 3600_000, 120);

        this.chatQueue = new PerChatQueue();
        this.debouncer = null;
    }

    notifyPairingReady() {
        while (this.pairingWaiters.length > 0) {
            const resolve = this.pairingWaiters.shift();
            resolve();
        }
    }

    waitForPairingReady(timeoutMs = 7000) {
        if (this.currentQR || this.status === 'qr_ready' || this.status === 'open') {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                const idx = this.pairingWaiters.indexOf(done);
                if (idx >= 0) this.pairingWaiters.splice(idx, 1);
                resolve();
            }, timeoutMs);
            const done = () => {
                clearTimeout(timer);
                resolve();
            };
            this.pairingWaiters.push(done);
        });
    }
}

class WhatsAppTenantManager {
    constructor() {
        this.runtimes = new Map();
        this.connectLock = Promise.resolve();
        this.isShuttingDown = false;
        this.sweeperTimer = null;
    }

    getRuntime(tenantId) {
        let rt = this.runtimes.get(tenantId);
        if (!rt) {
            rt = new TenantRuntime(tenantId);
            this.runtimes.set(tenantId, rt);
        }
        return rt;
    }

    getActiveSocketCount() {
        let count = 0;
        for (const rt of this.runtimes.values()) {
            if (rt.sock && ['connecting', 'qr_ready', 'open'].includes(rt.status)) {
                count++;
            }
        }
        return count;
    }

    getStatusSnapshot(tenantId) {
        const rt = this.runtimes.get(tenantId);
        if (!rt) {
            return {
                status: 'disconnected',
                qrDataUrl: null,
                pairingCode: null,
                circuitBreakerUntil: 0,
                circuitReason: ''
            };
        }
        return {
            status: rt.status,
            qrDataUrl: rt.currentQRDataUrl,
            pairingCode: rt.pairingCode,
            circuitBreakerUntil: rt.circuitBreakerUntil,
            circuitReason: rt.circuitReason
        };
    }

    async logAndEmit(tenantId, level, mod, msg, meta = null) {
        const doc = await recordActivityLog(tenantId, level, mod, msg, meta);
        eventBus.emitTenant(tenantId, 'log', {
            level,
            mod,
            msg,
            meta,
            createdAt: (doc?.createdAt || new Date()).toISOString()
        });
    }

    async bootAllSavedTenants() {
        if (!cols.tenants || !cols.waAuth) return;
        const activeTenants = await cols.tenants
            .find({ status: 'active' }, { projection: { _id: 1, name: 1 } })
            .toArray();

        const toBoot = [];
        for (const t of activeTenants) {
            if (toBoot.length >= CONFIG.MAX_ACTIVE_WA_SESSIONS) {
                console.warn(`[Manager] Reached MAX_ACTIVE_WA_SESSIONS=${CONFIG.MAX_ACTIVE_WA_SESSIONS}; skipping remaining auto-boots.`);
                break;
            }
            const hasCreds = await cols.waAuth.findOne({ _id: `${t._id}:creds` }, { projection: { _id: 1 } });
            if (hasCreds) toBoot.push(t._id);
        }

        console.log(`[Manager] Booting ${toBoot.length} saved WhatsApp sessions sequentially (cap=${CONFIG.MAX_ACTIVE_WA_SESSIONS}).`);
        // Sequential staggered boot prevents 0.1 vCPU overload & 515/429 thundering herd on Render Free
        (async () => {
            for (let i = 0; i < toBoot.length; i++) {
                if (this.isShuttingDown) break;
                await this.connectTenant(toBoot[i]).catch(() => {});
                if (i < toBoot.length - 1) {
                    await HumanMath.sleep(4200 + Math.floor(Math.random() * 1200));
                }
            }
        })();

        // Start 5-minute singleton revival & daily digest cursor sweep
        if (this.sweeperTimer) clearInterval(this.sweeperTimer);
        this.sweeperTimer = setInterval(() => {
            this._runBackgroundSweep().catch(() => {});
        }, 5 * 60_000);
        this.sweeperTimer.unref?.();
    }

    async connectTenant(tenantId, { forceFresh = false } = {}) {
        if (!cols.tenants || this.isShuttingDown) return;
        const tenant = await cols.tenants.findOne({ _id: tenantId });
        if (!tenant || tenant.status !== 'active') {
            throw new Error('Workspace is suspended or unavailable.');
        }

        const rt = this.getRuntime(tenantId);
        if (!forceFresh && rt.sock && ['connecting', 'qr_ready', 'open'].includes(rt.status)) {
            return;
        }

        if (this.getActiveSocketCount() >= CONFIG.MAX_ACTIVE_WA_SESSIONS && !rt.sock) {
            throw new Error(`Active WhatsApp session cap reached (${CONFIG.MAX_ACTIVE_WA_SESSIONS} max on current container). Disconnect an unused workspace first.`);
        }

        if (rt.reconnectTimer) {
            clearTimeout(rt.reconnectTimer);
            rt.reconnectTimer = null;
        }
        await this.disconnectTenant(tenantId, { preserveAuth: true, quiet: true });

        rt.isStopping = false;
        rt.status = 'connecting';
        rt.bootTimeMs = Date.now();
        rt.currentQR = null;
        rt.currentQRDataUrl = null;
        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));

        // Serialize socket Noise handshakes gently on 0.1 vCPU
        this.connectLock = this.connectLock
            .catch(() => {})
            .then(() => this._spawnSocket(tenantId, rt, tenant));
        return this.connectLock;
    }

    async _spawnSocket(tenantId, rt, tenantSnapshot) {
        try {
            const { state, saveCreds } = await useTenantMongoAuthState(tenantId);
            const version = await getCachedWaVersion();

            // Pick stable per-tenant browser fingerprint
            let hash = 0;
            for (let i = 0; i < tenantId.length; i++) hash = (hash * 31 + tenantId.charCodeAt(i)) >>> 0;
            const browserTuple = BROWSER_PROFILES[hash % BROWSER_PROFILES.length];

            rt.debouncer = new TenantDebouncer(async (canonicalRef, items, batchEnqueuedAt) => {
                rt.chatQueue.add(canonicalRef, async () => {
                    await this._processCustomerBatch(tenantId, rt, canonicalRef, items, batchEnqueuedAt);
                });
            });

            const sock = makeWASocket({
                version,
                auth: state,
                logger: silentLogger,
                printQRInTerminal: false,
                browser: browserTuple,
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                markOnlineOnConnect: false,
                fireInitQueries: false,
                keepAliveIntervalMs: 30_000,
                connectTimeoutMs: 30_000,
                appStateMacVerification: { patch: false, snapshot: false },
                msgRetryCounterCache: rt.msgRetryCounterCache,
                placeholderResendCache: rt.placeholderResendCache,
                userDevicesCache: rt.userDevicesCache,
                callOfferCache: rt.callOfferCache,
                mediaCache: rt.mediaCache,
                getMessage: async (key) => {
                    const cached = key?.id ? rt.sentProtoBuffer.get(key.id) : undefined;
                    return cached || undefined;
                },
                shouldIgnoreJid: (jid) => {
                    if (!jid) return true;
                    if (jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return true;
                    if (jid.endsWith('@g.us') && (tenantSnapshot?.safety?.groupMode || 'ignore_all') === 'ignore_all') {
                        return true;
                    }
                    return false;
                }
            });

            rt.sock = sock;

            sock.ev.on('creds.update', saveCreds);

            sock.ev.on('chats.phoneNumberShare', ({ lid, jid }) => {
                if (lid && jid) {
                    const pnDigits = normalizeDigits(jid.split('@')[0]);
                    if (pnDigits) rt.lidToPn.set(jidNormalizedUser(lid), pnDigits);
                }
            });

            sock.ev.on('contacts.upsert', (contacts) => {
                for (const c of contacts || []) {
                    if (c.lid && c.id && c.id.endsWith('@s.whatsapp.net')) {
                        const d = normalizeDigits(c.id.split('@')[0]);
                        if (d) rt.lidToPn.set(jidNormalizedUser(c.lid), d);
                    }
                }
            });

            sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
                if (rt.sock !== sock) return;

                if (qr) {
                    rt.currentQR = qr;
                    rt.status = 'qr_ready';
                    rt.pairingCode = null;
                    try {
                        rt.currentQRDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
                    } catch {
                        rt.currentQRDataUrl = null;
                    }
                    rt.notifyPairingReady();
                    eventBus.emitTenant(tenantId, 'wa_qr', {
                        qrDataUrl: rt.currentQRDataUrl,
                        status: rt.status
                    });
                    await this.logAndEmit(tenantId, 'info', 'wa', 'Generated fresh WhatsApp QR code waiting for scan.');
                }

                if (connection === 'open') {
                    rt.status = 'open';
                    rt.currentQR = null;
                    rt.currentQRDataUrl = null;
                    rt.pairingCode = null;
                    rt.reconnectAttempts = 0;
                    rt.notifyPairingReady();

                    const meId = sock.user?.id || '';
                    const waPhone = formatPhoneDisplay(meId.split(':')[0].split('@')[0]);
                    const waPushName = sock.user?.name || '';

                    await cols.tenants.updateOne(
                        { _id: tenantId },
                        {
                            $set: {
                                waStatus: 'open',
                                waPhone,
                                waPushName,
                                updatedAt: new Date()
                            }
                        }
                    ).catch(() => {});

                    // Unlock strict WhatsApp onboarding gate automatically once linked!
                    const tUsers = await cols.users.find({ tenantId }, { projection: { _id: 1 } }).toArray().catch(() => []);
                    await cols.users.updateMany({ tenantId }, { $set: { onboardingDone: true } }).catch(() => {});
                    for (const u of tUsers) authStateCache.del(`u:${u._id}`);

                    eventBus.emitTenant(tenantId, 'wa_status', {
                        ...this.getStatusSnapshot(tenantId),
                        waPhone,
                        waPushName
                    });
                    await this.logAndEmit(tenantId, 'info', 'wa', `WhatsApp connected cleanly as ${waPhone} (${waPushName || 'Linked Device'}).`);
                } else if (connection === 'close') {
                    if (rt.isStopping || this.isShuttingDown) return;

                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    rt.currentQR = null;
                    rt.currentQRDataUrl = null;

                    if (statusCode === 515 || statusCode === DisconnectReason.restartRequired) {
                        rt.status = 'connecting';
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'info', 'wa', 'WhatsApp requested stream restart (515). Reconnecting immediately...');
                        rt.reconnectTimer = setTimeout(() => this.connectTenant(tenantId, { forceFresh: true }).catch(() => {}), 500);
                        return;
                    }

                    if (
                        statusCode === 401 ||
                        statusCode === DisconnectReason.loggedOut ||
                        statusCode === 500 ||
                        statusCode === DisconnectReason.badSession
                    ) {
                        rt.status = 'disconnected';
                        await cols.waAuth.deleteMany({ tenantId }).catch(() => {});
                        await cols.tenants.updateOne(
                            { _id: tenantId },
                            { $set: { waStatus: 'disconnected', waPhone: '', updatedAt: new Date() } }
                        ).catch(() => {});
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'warn', 'wa', `Session unlinked or invalidated (code ${statusCode}). Ready for fresh QR scan.`);
                        return;
                    }

                    if (statusCode === 403 || statusCode === DisconnectReason.forbidden) {
                        rt.status = 'forbidden';
                        rt.circuitReason = 'WhatsApp returned 403 Forbidden. Reconnect halted to protect number.';
                        await cols.tenants.updateOne(
                            { _id: tenantId },
                            { $set: { waStatus: 'forbidden', updatedAt: new Date() } }
                        ).catch(() => {});
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'err', 'safety', rt.circuitReason);
                        return;
                    }

                    if (statusCode === 440 || statusCode === DisconnectReason.connectionReplaced) {
                        rt.status = 'disconnected';
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'warn', 'wa', 'WhatsApp connection replaced by another session (440).');
                        return;
                    }

                    if (statusCode === 429) {
                        rt.circuitBreakerUntil = Date.now() + 20 * 60_000;
                        rt.circuitReason = 'WhatsApp rate-limited handshake (429). Auto-cooldown 20m.';
                        rt.status = 'cooldown';
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'err', 'safety', rt.circuitReason);
                        return;
                    }

                    if (rt.reconnectAttempts < 7) {
                        rt.reconnectAttempts++;
                        rt.status = 'connecting';
                        const backoff = Math.min(60_000, Math.pow(2, rt.reconnectAttempts) * 1000 + Math.floor(Math.random() * 1500));
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'warn', 'wa', `Socket closed (${statusCode || 'network'}). Retrying in ${Math.round(backoff / 1000)}s...`);
                        rt.reconnectTimer = setTimeout(() => {
                            this.connectTenant(tenantId, { forceFresh: true }).catch(() => {});
                        }, backoff);
                    } else {
                        rt.status = 'disconnected';
                        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        await this.logAndEmit(tenantId, 'err', 'wa', 'Max reconnect retries reached. Click Reconnect manually when ready.');
                    }
                }
            });

            // Monitor delivery NACKs (463 / 429) AND live message edits/revokes
            sock.ev.on('messages.update', async (updates) => {
                if (rt.sock !== sock) return;
                for (const u of updates || []) {
                    const status = u.update?.status;
                    const stubParams = u.update?.messageStubParameters || [];
                    if (status === WAMessageStatus.ERROR) {
                        const is463 = stubParams.some((p) => String(p).includes('463'));
                        const is429 = stubParams.some((p) => String(p).includes('429'));
                        if (is463 || is429) {
                            const mins = is463 ? 60 : 20;
                            rt.circuitBreakerUntil = Date.now() + mins * 60_000;
                            rt.circuitReason = is463
                                ? 'WhatsApp 463 Reachout Timelock triggered. AI outbound auto-paused 60m to protect number.'
                                : 'WhatsApp 429 NACK throttled. AI outbound auto-paused 20m.';
                            await this.logAndEmit(tenantId, 'err', 'safety', rt.circuitReason);
                            eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
                        }
                    }

                    // Handle message revocations or edits delivered via messages.update
                    if (u.update?.messageStubType === WAMessageStubType.REVOKE || u.update?.message === null) {
                        const targetId = u.key?.id;
                        const peerRef = u.key?.remoteJid ? this._resolvePeerIdentity(rt, { key: u.key }).canonicalRef : '';
                        if (targetId && peerRef) {
                            rt.debouncer?.revokeMessage(peerRef, targetId);
                            await cols.messages.updateOne(
                                { waMsgId: targetId, tenantId },
                                { $set: { text: '[Message deleted]', isDeleted: true } }
                            ).catch(() => {});
                        }
                    } else if (u.update?.message?.editedMessage) {
                        const inner = normalizeMessageContent(u.update.message.editedMessage);
                        const editText = (inner?.conversation || inner?.extendedTextMessage?.text || '').trim();
                        const targetId = u.key?.id;
                        const peerRef = u.key?.remoteJid ? this._resolvePeerIdentity(rt, { key: u.key }).canonicalRef : '';
                        if (targetId && editText && peerRef) {
                            rt.debouncer?.editMessage(peerRef, targetId, editText);
                            await cols.messages.updateOne(
                                { waMsgId: targetId, tenantId },
                                { $set: { text: editText.slice(0, 2500), isEdited: true } }
                            ).catch(() => {});
                        }
                    }
                }
            });

            // Coordinate adaptive debounce while customer is actively typing/recording
            sock.ev.on('presence.update', ({ id, presences }) => {
                if (rt.sock !== sock || !id) return;
                const normJid = jidNormalizedUser(id);
                let canonicalRef = normJid;
                if (normJid.endsWith('@s.whatsapp.net')) {
                    canonicalRef = normalizeDigits(normJid.split('@')[0]);
                } else if (normJid.endsWith('@lid')) {
                    canonicalRef = rt.lidToPn.get(normJid) || normJid;
                }
                const presenceObj = presences?.[id] || presences?.[normJid] || (presences ? Object.values(presences)[0] : null);
                if (presenceObj?.lastKnownPresence) {
                    rt.debouncer?.extendForPresence(canonicalRef, presenceObj.lastKnownPresence);
                }
            });

            sock.ev.on('messages.upsert', async ({ messages, type }) => {
                if (rt.sock !== sock) return;
                for (const msg of messages || []) {
                    await this._handleUpsertMessage(tenantId, rt, sock, msg, type);
                }
            });
        } catch (err) {
            rt.status = 'disconnected';
            eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
            await this.logAndEmit(tenantId, 'err', 'wa', `Socket launch failed: ${err.message}`);
        }
    }

    async requestPairingCode(tenantId, phoneInput) {
        const cleanDigits = normalizeDigits(phoneInput);
        if (cleanDigits.length < 8 || cleanDigits.length > 15) {
            throw new Error('Enter a valid phone number with country code (e.g. 919876543210).');
        }

        const rt = this.getRuntime(tenantId);
        if (rt.status === 'open') {
            throw new Error('WhatsApp is already connected.');
        }

        if (!rt.sock || rt.status === 'disconnected') {
            await this.connectTenant(tenantId, { forceFresh: true });
        }

        await rt.waitForPairingReady(8000);
        if (!rt.sock) {
            throw new Error('WhatsApp socket failed to initialize. Retry in a few seconds.');
        }
        if (rt.sock.authState?.creds?.registered) {
            throw new Error('Session already registered. Click Unlink first to pair another number.');
        }

        const rawCode = await rt.sock.requestPairingCode(cleanDigits);
        const formatted = rawCode.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode;
        rt.pairingCode = formatted;
        eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
        await this.logAndEmit(tenantId, 'info', 'wa', `Generated 8-digit pairing code for +${cleanDigits}.`);
        return formatted;
    }

    async disconnectTenant(tenantId, { preserveAuth = true, quiet = false } = {}) {
        const rt = this.runtimes.get(tenantId);
        if (!rt) return;

        rt.isStopping = true;
        if (rt.reconnectTimer) {
            clearTimeout(rt.reconnectTimer);
            rt.reconnectTimer = null;
        }
        rt.debouncer?.cleanupAll();
        rt.chatQueue.clearAll();

        if (rt.sock) {
            const oldSock = rt.sock;
            rt.sock = null;
            try { oldSock.ev.removeAllListeners(); } catch {}
            try {
                if (!preserveAuth) {
                    await oldSock.logout().catch(() => {});
                }
                oldSock.end(undefined);
            } catch {}
        }

        if (!preserveAuth && cols.waAuth) {
            await cols.waAuth.deleteMany({ tenantId }).catch(() => {});
        }

        rt.status = 'disconnected';
        rt.currentQR = null;
        rt.currentQRDataUrl = null;
        rt.pairingCode = null;

        if (!preserveAuth && cols.tenants) {
            await cols.tenants.updateOne(
                { _id: tenantId },
                { $set: { waStatus: 'disconnected', waPhone: '', waPushName: '', updatedAt: new Date() } }
            ).catch(() => {});
        } else if (!quiet && cols.tenants) {
            await cols.tenants.updateOne(
                { _id: tenantId },
                { $set: { waStatus: 'disconnected', updatedAt: new Date() } }
            ).catch(() => {});
        }

        if (!quiet) {
            eventBus.emitTenant(tenantId, 'wa_status', this.getStatusSnapshot(tenantId));
            await this.logAndEmit(tenantId, 'info', 'wa', preserveAuth ? 'WhatsApp socket disconnected.' : 'WhatsApp device unlinked and session keys purged.');
        }
    }

    _resolvePeerIdentity(rt, msg) {
        const remoteJid = msg.key.remoteJid || '';
        const isGroup = remoteJid.endsWith('@g.us');

        if (msg.key.senderLid && msg.key.senderPn) {
            const pnDigits = normalizeDigits(msg.key.senderPn.split('@')[0]);
            if (pnDigits) rt.lidToPn.set(jidNormalizedUser(msg.key.senderLid), pnDigits);
        }

        if (isGroup) {
            return {
                remoteJid,
                isGroup: true,
                canonicalRef: remoteJid,
                phoneNumber: 'Group Chat',
                lidJid: null
            };
        }

        const normJid = jidNormalizedUser(remoteJid);
        let phoneDigits = '';
        let lidJid = null;

        if (normJid.endsWith('@s.whatsapp.net')) {
            phoneDigits = normalizeDigits(normJid.split('@')[0]);
        } else if (normJid.endsWith('@lid')) {
            lidJid = normJid;
            if (msg.key.senderPn) {
                phoneDigits = normalizeDigits(msg.key.senderPn.split('@')[0]);
            } else {
                phoneDigits = rt.lidToPn.get(normJid) || '';
            }
            if (phoneDigits) rt.lidToPn.set(normJid, phoneDigits);
        }

        const canonicalRef = phoneDigits || normJid;
        const phoneNumber = phoneDigits ? formatPhoneDisplay(phoneDigits) : 'WhatsApp User';
        return { remoteJid, isGroup: false, canonicalRef, phoneNumber, lidJid };
    }

    _extractNormalizedPayload(rawMsg) {
        const raw = rawMsg?.message;
        if (!raw) return { type: 'empty', text: '' };

        // 1. Check protocol messages BEFORE unwrapping envelopes (REVOKE / MESSAGE_EDIT)
        if (raw.protocolMessage) {
            const pType = raw.protocolMessage.type;
            if (pType === 0) {
                return { type: 'revoke', targetId: raw.protocolMessage.key?.id || '' };
            }
            if (pType === 14) {
                const inner = normalizeMessageContent(raw.protocolMessage.editedMessage);
                const editText = (
                    inner?.conversation ||
                    inner?.extendedTextMessage?.text ||
                    inner?.imageMessage?.caption ||
                    inner?.videoMessage?.caption ||
                    ''
                ).trim();
                return { type: 'edit', targetId: raw.protocolMessage.key?.id || '', text: editText };
            }
            return { type: 'protocol_sync', text: '' };
        }
        if (raw.senderKeyDistributionMessage) {
            return { type: 'protocol_sync', text: '' };
        }

        // 2. Unwrap Disappearing (ephemeralMessage), View-Once & Edited wrappers cleanly
        const m = normalizeMessageContent(raw);
        if (!m) return { type: 'empty', text: '' };

        // Ignore passive reaction emojis & stickers (never invoke LLM)
        if (m.reactionMessage || m.stickerMessage) {
            return { type: 'noise', text: '' };
        }

        // 3. Extract quoted reply context if customer replied to an earlier message
        const ctxInfo =
            m.extendedTextMessage?.contextInfo ||
            m.imageMessage?.contextInfo ||
            m.videoMessage?.contextInfo ||
            m.audioMessage?.contextInfo ||
            m.documentMessage?.contextInfo ||
            m.buttonsResponseMessage?.contextInfo ||
            m.listResponseMessage?.contextInfo ||
            null;

        let quotedSummary = '';
        if (ctxInfo?.quotedMessage) {
            const qm = normalizeMessageContent(ctxInfo.quotedMessage);
            if (qm) {
                const qt = (
                    qm.conversation ||
                    qm.extendedTextMessage?.text ||
                    qm.imageMessage?.caption ||
                    qm.videoMessage?.caption ||
                    qm.documentMessage?.caption ||
                    ''
                ).trim();
                if (qt) quotedSummary = qt.slice(0, 260);
                else if (qm.imageMessage) quotedSummary = '[Earlier Photo]';
                else if (qm.audioMessage) quotedSummary = '[Earlier Voice Note]';
            }
        }

        const mentionedJid = ctxInfo?.mentionedJid || [];
        const ctxParticipant = ctxInfo?.participant || '';

        // 4. Media / Location / Contact / Text resolution
        if (m.audioMessage) {
            return {
                type: 'audio',
                text: '',
                mime: m.audioMessage.mimetype || 'audio/ogg',
                size: Number(m.audioMessage.fileLength || 0),
                seconds: Number(m.audioMessage.seconds || 0),
                quotedSummary,
                mentionedJid,
                ctxParticipant
            };
        }

        if (m.imageMessage) {
            return {
                type: 'image',
                text: (m.imageMessage.caption || '').trim(),
                mime: m.imageMessage.mimetype || 'image/jpeg',
                size: Number(m.imageMessage.fileLength || 0),
                quotedSummary,
                mentionedJid,
                ctxParticipant
            };
        }

        if (m.locationMessage || m.liveLocationMessage) {
            const loc = m.locationMessage || m.liveLocationMessage;
            const label = [loc.name, loc.address].filter(Boolean).join(', ');
            const locText = `[Customer shared location: ${loc.degreesLatitude}, ${loc.degreesLongitude}${label ? ` (${label})` : ''} - https://maps.google.com/?q=${loc.degreesLatitude},${loc.degreesLongitude}]`;
            return { type: 'location', text: locText, quotedSummary, mentionedJid, ctxParticipant };
        }

        if (m.contactMessage || m.contactsArrayMessage) {
            const list = m.contactsArrayMessage?.contacts || [m.contactMessage];
            const summary = list
                .filter(Boolean)
                .map((c) => {
                    const telM = (c.vcard || '').match(/waid=(\d+)/i) || (c.vcard || '').match(/TEL[^:]*:([^\r\n]+)/i);
                    const phone = telM ? telM[1].replace(/[^\d+]/g, '') : '';
                    return `${c.displayName || 'Contact'}${phone ? ` (${phone})` : ''}`;
                })
                .join(', ');
            return { type: 'contact', text: `[Customer shared contact: ${summary}]`, quotedSummary, mentionedJid, ctxParticipant };
        }

        const text = (
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.videoMessage?.caption ||
            m.documentMessage?.caption ||
            m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            m.buttonsResponseMessage?.selectedDisplayText ||
            m.listResponseMessage?.title ||
            m.templateButtonReplyMessage?.selectedDisplayText ||
            ''
        ).trim();

        return {
            type: text ? 'text' : 'empty',
            text,
            quotedSummary,
            mentionedJid,
            ctxParticipant
        };
    }

    async _markUnseenForOwner(tenantId, rt, tenant, convId, convDoc, peer, canonicalRef, reasonTag, logDetail, quarantinedReply = null) {
        const hNow = new Date();
        const hMins = Number(tenant.safety?.takeoverMinutes ?? 30);
        const hPauseUntil = hMins === 0 ? addDays(hNow, 3650) : new Date(hNow.getTime() + hMins * 60_000);
        rt.pausedUntilCache.set(
            canonicalRef,
            { pausedAt: hNow.getTime(), pausedUntil: hPauseUntil.getTime() },
            Math.max(hMins, 60) * 60_000
        );

        await cols.conversations.updateOne(
            { _id: convId },
            {
                $set: {
                    aiStatus: 'human_needed',
                    unseenForOwner: true,
                    pausedUntil: hPauseUntil,
                    pauseReason: reasonTag,
                    followUpAt: null
                },
                $max: { unreadCount: 1 }
            }
        ).catch(() => {});

        eventBus.emitTenant(tenantId, 'inbox_msg', {
            conversationId: convId,
            aiStatus: 'human_needed',
            unseenForOwner: true,
            pauseReason: reasonTag,
            pausedUntil: hPauseUntil.toISOString()
        });

        await this.logAndEmit(
            tenantId,
            'warn',
            'takeover',
            `[Unseen · Needs Team] Kept ${convDoc?.displayName || peer.phoneNumber} (${peer.phoneNumber}) unread on WhatsApp & Dashboard — ${logDetail}.`,
            quarantinedReply ? { reason: reasonTag, blockedDraft: quarantinedReply.slice(0, 260) } : { reason: reasonTag }
        );

        if (tenant.safety?.webhookUrl) {
            fetch(tenant.safety.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    event: 'human_needed',
                    tenantId,
                    phone: convDoc?.phoneNumber || peer.phoneNumber,
                    name: convDoc?.displayName || peer.phoneNumber,
                    reason: reasonTag,
                    timestamp: hNow.toISOString()
                })
            }).catch(() => {});
        }
    }

    async _sendOwnerAlert(tenantId, rt, tenant, text) {
        if (!rt?.sock || rt.status !== 'open' || !text) return false;
        const customDigits = normalizeDigits(tenant?.safety?.ownerAlertPhone || '');
        const meJid = rt.sock.user?.id ? jidNormalizedUser(rt.sock.user.id) : '';
        const targetJid = customDigits.length >= 10 ? `${customDigits}@s.whatsapp.net` : meJid;
        if (!targetJid) return false;

        try {
            const msgId = generateMessageIDV2(rt.sock.user?.id);
            rt.botSentIds.set(msgId, true);
            rt.sentProtoBuffer.set(msgId, { conversation: text });
            await rt.sock.sendMessage(targetJid, { text }, { messageId: msgId });
            return true;
        } catch {
            return false;
        }
    }

    async _handleUpsertMessage(tenantId, rt, sock, msg, type) {
        try {
            if (!msg.message) return;
            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

            // Skip Note-to-Self traffic cleanly so Owner Alerts never create fake customer chats or loops
            const mePnJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
            const meLidJid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '';
            const isSelfChat = (mePnJid && areJidsSameUser(jid, mePnJid)) || (meLidJid && areJidsSameUser(jid, meLidJid));
            if (isSelfChat) return;

            const payload = this._extractNormalizedPayload(msg);
            if (payload.type === 'protocol_sync' || payload.type === 'noise') return;

            const tenant = await cols.tenants.findOne({ _id: tenantId });
            if (!tenant || tenant.status !== 'active') return;

            const peer = this._resolvePeerIdentity(rt, msg);

            // Handle live message deletions & edits mid-debounce
            if (payload.type === 'revoke') {
                rt.debouncer?.revokeMessage(peer.canonicalRef, payload.targetId);
                if (payload.targetId) {
                    await cols.messages.updateOne(
                        { waMsgId: payload.targetId, tenantId },
                        { $set: { text: '[Message deleted]', isDeleted: true } }
                    ).catch(() => {});
                }
                return;
            }
            if (payload.type === 'edit') {
                if (payload.targetId && payload.text) {
                    rt.debouncer?.editMessage(peer.canonicalRef, payload.targetId, payload.text);
                    await cols.messages.updateOne(
                        { waMsgId: payload.targetId, tenantId },
                        { $set: { text: payload.text.slice(0, 2500), isEdited: true } }
                    ).catch(() => {});
                }
                return;
            }

            const isFromMe = Boolean(msg.key.fromMe);
            const msgTsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

            // Catch live owner phone/web echoes on both notify and recent append reconnect windows
            if (isFromMe) {
                const isRecent = Date.now() - msgTsMs < 120_000 && msgTsMs >= rt.bootTimeMs - 15_000;
                if (type !== 'notify' && !isRecent) return;
                if (rt.botSentIds.has(msg.key.id)) return;
                if (peer.isGroup) return;

                const extractedText = payload.text || '[Attachment]';
                await this._handleManualOwnerEcho(tenantId, rt, tenant, peer, extractedText, msg.key.id);
                return;
            }

            if (type !== 'notify') return;

            if (peer.isGroup) {
                const groupMode = tenant.safety?.groupMode || 'ignore_all';
                if (groupMode === 'ignore_all') return;

                const isMentioned = payload.mentionedJid.some((mj) => mePnJid && jidNormalizedUser(mj) === mePnJid);
                const isQuotedBot = Boolean(payload.ctxParticipant && mePnJid && jidNormalizedUser(payload.ctxParticipant) === mePnJid);
                const hasPrefix = payload.text.startsWith('!ai') || payload.text.startsWith('/ask');
                if (!isMentioned && !isQuotedBot && !hasPrefix) return;
            }

            // Check VIP/Family Blacklist BEFORE storing / debouncing / reading!
            const blackSet = new Set((tenant.blacklist || []).map((b) => normalizeDigits(b.ref) || b.ref));
            if (blackSet.has(peer.canonicalRef) || blackSet.has(peer.remoteJid)) {
                await this.logAndEmit(tenantId, 'info', 'safety', `Ignored blocked number ${peer.phoneNumber}.`);
                return;
            }

            const rawTextBody = payload.text || '';
            const textBody = payload.quotedSummary && rawTextBody
                ? `[Replying to: "${payload.quotedSummary}"]\n${rawTextBody}`
                : rawTextBody;
            const hasAudio = payload.type === 'audio';
            const hasImage = payload.type === 'image';

            if (!textBody && !hasAudio && !hasImage) return;

            let mediaTypeTag = 'text';
            if (hasAudio) mediaTypeTag = 'audio';
            else if (hasImage) mediaTypeTag = 'image';
            else if (payload.type === 'location') mediaTypeTag = 'location';
            else if (payload.type === 'contact') mediaTypeTag = 'contact';

            const convId = `${tenantId}:wa:${peer.canonicalRef}`;
            const now = new Date();
            const safePushName = msg.pushName && msg.pushName !== '~' ? msg.pushName.trim().slice(0, 80) : '';
            const previewLabel = rawTextBody || (hasAudio ? '[Voice Note]' : '[Image]');

            const setFields = {
                tenantId,
                channel: 'wa',
                externalRef: peer.canonicalRef,
                remoteJid: peer.remoteJid,
                isSandbox: false,
                lastMessagePreview: previewLabel.slice(0, 120),
                lastMessageAt: now,
                followUpAt: null,
                expiresAt: addDays(now, 180)
            };
            if (peer.phoneNumber && peer.phoneNumber !== 'WhatsApp User') setFields.phoneNumber = peer.phoneNumber;
            if (peer.lidJid) setFields.lidJid = peer.lidJid;
            if (safePushName) setFields.displayName = safePushName;

            const existingConv = await cols.conversations.findOne({ _id: convId });
            if (!existingConv) {
                await cols.conversations.insertOne({
                    _id: convId,
                    ...setFields,
                    displayName: safePushName || peer.phoneNumber,
                    phoneNumber: peer.phoneNumber,
                    aiStatus: 'active',
                    pausedUntil: null,
                    optedOut: false,
                    stage: 'new',
                    tags: [],
                    notes: '',
                    customerFacts: {},
                    contextTurns: [],
                    unreadCount: 1,
                    createdAt: now
                }).catch(() => {});
            } else {
                await cols.conversations.updateOne(
                    { _id: convId },
                    { $set: setFields, $inc: { unreadCount: 1 } }
                ).catch(() => {});
            }

            const convDoc = existingConv || (await cols.conversations.findOne({ _id: convId }));

            // Persist clean customer message (zero binary media stored in MongoDB!)
            const customerMsgDoc = {
                tenantId,
                conversationId: convId,
                isSandbox: false,
                dir: 'in',
                senderType: 'customer',
                msgType: mediaTypeTag,
                text: previewLabel.slice(0, 2500),
                waMsgId: msg.key.id,
                createdAt: now,
                expiresAt: addDays(now, 30)
            };
            await cols.messages.insertOne(customerMsgDoc).catch(() => {});
            await incrementDailyAnalytics(tenantId, tenant.safety?.timezone || 'Asia/Kolkata', { inCount: 1 });

            eventBus.emitTenant(tenantId, 'inbox_msg', {
                conversationId: convId,
                displayName: setFields.displayName || convDoc?.displayName || peer.phoneNumber,
                phoneNumber: setFields.phoneNumber || convDoc?.phoneNumber || peer.phoneNumber,
                message: {
                    ...customerMsgDoc,
                    createdAt: now.toISOString()
                }
            });

            // Inbound Autoresponder Loop Shield (stops bot-to-bot ping-pong at $0 cost!)
            if (rawTextBody && isAutoresponderMessage(rawTextBody)) {
                await cols.conversations.updateOne(
                    { _id: convId },
                    { $set: { aiStatus: 'bot_loop_detected', pausedUntil: addDays(now, 1), pauseReason: 'autoresponder_shield' } }
                ).catch(() => {});
                await this.logAndEmit(tenantId, 'warn', 'safety', `Autoresponder loop detected from ${peer.phoneNumber}. AI paused 24h & left unseen.`);
                return;
            }

            // Inbound Prompt Injection Defense
            if (rawTextBody && detectPromptInjection(rawTextBody)) {
                await this._markUnseenForOwner(tenantId, rt, tenant, convId, convDoc, peer, peer.canonicalRef, 'prompt_injection_flag', 'prompt injection attempt blocked');
                return;
            }

            // Contextual Opt-Out vs Human-Agent Escalation Classifier ("wait stop" won't shut down bot!)
            const stopIntent = classifyStopIntent(rawTextBody, tenant.safety?.optOutKeywords);
            if (stopIntent === 'opt_out' && !convDoc?.optedOut) {
                await cols.conversations.updateOne({ _id: convId }, { $set: { optedOut: true, aiStatus: 'paused', followUpAt: null } });
                const optMsgId = generateMessageIDV2(sock.user?.id);
                rt.botSentIds.set(optMsgId, true);
                const byeText = 'Automated AI replies are paused for this chat. Our team can still assist you directly, or type *START* anytime to re-enable.';
                await sock.sendMessage(peer.remoteJid, { text: byeText }, { messageId: optMsgId }).catch(() => {});
                await this._recordBotMessage(tenantId, convId, byeText, 'system-optout', 0, optMsgId);
                await this.logAndEmit(tenantId, 'info', 'safety', `Customer ${peer.phoneNumber} opted out via "${rawTextBody}".`);
                return;
            }

            if (stopIntent === 'human_request') {
                await this._markUnseenForOwner(tenantId, rt, tenant, convId, convDoc, peer, peer.canonicalRef, 'customer_requested_human', 'customer asked to speak with a human');
                return;
            }

            if (convDoc?.optedOut) {
                if (/^(start|resume|subscribe)[.!\s]*$/i.test(rawTextBody.trim())) {
                    await cols.conversations.updateOne({ _id: convId }, { $set: { optedOut: false, aiStatus: 'active', pausedUntil: null, unseenForOwner: false } });
                    await this.logAndEmit(tenantId, 'info', 'safety', `Customer ${peer.phoneNumber} re-subscribed via START.`);
                } else {
                    return;
                }
            }

            // Master Kill-switch & Human Takeover Pause Check
            if (!tenant.safety?.aiEnabled) return;

            const nowMs = Date.now();
            const cachedPause = rt.pausedUntilCache.get(peer.canonicalRef);
            const dbPausedUntilMs = convDoc?.pausedUntil ? new Date(convDoc.pausedUntil).getTime() : 0;
            const effectivePauseUntil = Math.max(cachedPause?.pausedUntil || 0, dbPausedUntilMs);
            if (effectivePauseUntil > nowMs || convDoc?.aiStatus === 'manual_resolved') {
                return;
            }

            if (rt.circuitBreakerUntil > nowMs) return;

            // Business hours / operating mode gate
            const hoursCheck = isWithinOperatingWindow(tenant.safety);
            if (!hoursCheck.aiAllowed) {
                if (hoursCheck.reason === 'closed' && tenant.safety?.sendAwayMessage && tenant.safety?.awayMessage) {
                    if (!rt.awayDedupCache.has(peer.canonicalRef)) {
                        rt.awayDedupCache.set(peer.canonicalRef, true);
                        const awayId = generateMessageIDV2(sock.user?.id);
                        rt.botSentIds.set(awayId, true);
                        await sock.sendMessage(peer.remoteJid, { text: tenant.safety.awayMessage }, { messageId: awayId }).catch(() => {});
                        await this._recordBotMessage(tenantId, convId, tenant.safety.awayMessage, 'system-away', 0, awayId);
                    }
                }
                return;
            }

            // Subscribe to live typing presence so debouncer waits if customer is typing message #2!
            sock.presenceSubscribe(peer.remoteJid).catch(() => {});

            const baseDebounceMs = Math.min(8000, Math.max(400, Number(tenant.safety?.debounceMs || 1800)));
            const adaptiveDebounceMs = calculateAdaptiveDebounceMs(rawTextBody, hasAudio, hasImage, baseDebounceMs);

            rt.debouncer.enqueue(
                peer.canonicalRef,
                {
                    msg,
                    peer,
                    convId,
                    textBody,
                    rawTextBody,
                    hasAudio,
                    hasImage,
                    audioSeconds: payload.seconds || 0,
                    audioSize: payload.size || 0,
                    safePushName,
                    senderParticipant: msg.key.participant || peer.remoteJid
                },
                adaptiveDebounceMs,
                8000
            );
        } catch (err) {
            await this.logAndEmit(tenantId, 'err', 'wa', `Inbound handling error: ${err.message}`);
        }
    }

    async _handleManualOwnerEcho(tenantId, rt, tenant, peer, text, waMsgId) {
        const takeoverMins = Number(tenant.safety?.takeoverMinutes ?? 30);
        const now = new Date();
        const nowMs = now.getTime();
        const pausedUntil = takeoverMins === 0 ? addDays(now, 3650) : new Date(nowMs + takeoverMins * 60_000);

        rt.debouncer?.cleanup(peer.canonicalRef);
        rt.pausedUntilCache.set(peer.canonicalRef, { pausedAt: nowMs, pausedUntil: pausedUntil.getTime() }, Math.max(takeoverMins, 60) * 60_000);

        const convId = `${tenantId}:wa:${peer.canonicalRef}`;
        await cols.conversations.updateOne(
            { _id: convId },
            {
                $setOnInsert: {
                    _id: convId,
                    tenantId,
                    channel: 'wa',
                    externalRef: peer.canonicalRef,
                    remoteJid: peer.remoteJid,
                    displayName: peer.phoneNumber,
                    phoneNumber: peer.phoneNumber,
                    isSandbox: false,
                    stage: 'new',
                    tags: [],
                    notes: '',
                    customerFacts: {},
                    contextTurns: [],
                    createdAt: now
                },
                $set: {
                    aiStatus: 'paused',
                    unseenForOwner: false,
                    pausedUntil,
                    pauseReason: 'owner_app',
                    followUpAt: null,
                    unreadCount: 0,
                    lastMessagePreview: `You: ${text.slice(0, 100)}`,
                    lastMessageAt: now,
                    expiresAt: addDays(now, 180)
                },
                $push: {
                    contextTurns: {
                        $each: [{ role: 'assistant', text: `[Human Agent]: ${text.slice(0, 600)}` }],
                        $slice: -10
                    }
                }
            },
            { upsert: true }
        ).catch(() => {});

        const ownerMsg = {
            tenantId,
            conversationId: convId,
            isSandbox: false,
            dir: 'out',
            senderType: 'owner_app',
            msgType: 'text',
            text: text.slice(0, 2500),
            waMsgId,
            createdAt: now,
            expiresAt: addDays(now, 30)
        };
        await cols.messages.insertOne(ownerMsg).catch(() => {});
        await incrementDailyAnalytics(tenantId, tenant.safety?.timezone || 'Asia/Kolkata', { ownerOutCount: 1 });

        eventBus.emitTenant(tenantId, 'inbox_msg', {
            conversationId: convId,
            aiStatus: 'paused',
            unseenForOwner: false,
            pausedUntil: pausedUntil.toISOString(),
            message: { ...ownerMsg, createdAt: now.toISOString() }
        });
        await this.logAndEmit(
            tenantId,
            'info',
            'takeover',
            `Owner replied manually to ${peer.phoneNumber}. AI auto-paused ${takeoverMins === 0 ? 'until manual resume' : `${takeoverMins}m`}.`
        );
    }

    async _processCustomerBatch(tenantId, rt, canonicalRef, items, batchEnqueuedAt) {
        if (!rt.sock || rt.status !== 'open') return;
        const sock = rt.sock;
        const lastItem = items[items.length - 1];
        const { peer, convId } = lastItem;

        // Abort if paused mid-debounce or mid-queue
        const cachedPause = rt.pausedUntilCache.get(canonicalRef);
        if (cachedPause && (cachedPause.pausedAt > batchEnqueuedAt || cachedPause.pausedUntil > Date.now())) {
            return;
        }

        const tenant = await cols.tenants.findOne({ _id: tenantId });
        if (!tenant || tenant.status !== 'active' || !tenant.safety?.aiEnabled) return;

        const convDoc = await cols.conversations.findOne({ _id: convId });
        if (!convDoc || convDoc.optedOut || convDoc.aiStatus === 'manual_resolved') return;
        if (convDoc.pausedUntil && new Date(convDoc.pausedUntil).getTime() > Date.now()) return;

        // Enforce persistent daily & hourly tenant outbound safety caps
        const tz = tenant.safety?.timezone || 'Asia/Kolkata';
        const { dayKey, hourKey } = getLocalDayAndHour(new Date(), tz);
        const dailyStats = await cols.analyticsDaily.findOne({ _id: `${tenantId}:${dayKey}` });
        const maxDaily = tenant.safety?.maxDailyOut || 90;
        if ((dailyStats?.aiOutCount || 0) >= maxDaily) {
            await this.logAndEmit(tenantId, 'warn', 'safety', `Daily AI outbound cap (${maxDaily}) reached for today.`);
            return;
        }
        const curHrKey = `${dayKey}:${hourKey}`;
        if (rt.hourlyCounter.key !== curHrKey) rt.hourlyCounter = { key: curHrKey, count: 0 };
        if (rt.hourlyCounter.count >= (tenant.safety?.maxHourlyOut || 20)) {
            await this.logAndEmit(tenantId, 'warn', 'safety', `Hourly outbound cap reached; pacing enabled.`);
            return;
        }

        const mergedText = items
            .map((i) => i.textBody || (i.hasAudio ? '[Voice Note]' : '[Image]'))
            .filter(Boolean)
            .join('\n');

        // 1. Closure Phatic Fast Path ("Ok", "Thanks", "Done", "👍"): react with 👍 at $0 LLM cost!
        if (!items.some((i) => i.hasAudio || i.hasImage) && isClosurePhatic(mergedText, convDoc.contextTurns)) {
            if (tenant.safety?.phaticReactionEnabled !== false) {
                await HumanMath.sleep(450);
                if (tenant.safety?.readReceipts !== false && lastItem.msg?.key) {
                    await sock.readMessages([lastItem.msg.key]).catch(() => {});
                }
                await sock.sendMessage(peer.remoteJid, {
                    react: { text: '👍', key: lastItem.msg.key }
                }).catch(() => {});
                await cols.conversations.updateOne(
                    { _id: convId },
                    { $set: { unreadCount: 0, unseenForOwner: false, lastMessagePreview: 'Reacted 👍' } }
                ).catch(() => {});
                await this.logAndEmit(tenantId, 'info', 'ai', `Reacted 👍 to closing acknowledgment from ${convDoc.displayName || peer.phoneNumber} (0 LLM calls).`);
                eventBus.emitTenant(tenantId, 'inbox_msg', { conversationId: convId });
            }
            return;
        }

        // 2. Audio Duration Pre-Flight Gates
        const mediaItem = [...items].reverse().find((it) => (it.hasAudio && tenant.safety?.voiceNotesEnabled) || (it.hasImage && tenant.safety?.imageVisionEnabled));
        if (mediaItem?.hasAudio && !lastItem.rawTextBody) {
            if ((mediaItem.audioSeconds > 0 && mediaItem.audioSeconds < 1) || (mediaItem.audioSize > 0 && mediaItem.audioSize < 900)) {
                await this.logAndEmit(tenantId, 'info', 'ai', `Skipped empty <1s voice tap from ${peer.phoneNumber}.`);
                return;
            }
            if (mediaItem.audioSeconds > 90) {
                await this._markUnseenForOwner(tenantId, rt, tenant, convId, convDoc, peer, canonicalRef, 'long_voice_note', `long voice note (${mediaItem.audioSeconds}s) held for human`);
                return;
            }
        }

        // 3. Ephemeral media download from unwrapped envelope (RAM only — never saved to MongoDB!)
        let mediaAttachment = null;
        if (mediaItem) {
            try {
                const m = mediaItem.msg;
                const inner = normalizeMessageContent(m.message);
                const fileSize = Number(inner?.audioMessage?.fileLength || inner?.imageMessage?.fileLength || 0);
                if (fileSize <= 4_500_000) {
                    const buf = await downloadMediaMessage(m, 'buffer', {}, {
                        logger: silentLogger,
                        reuploadRequest: sock.updateMediaMessage
                    });
                    if (Buffer.isBuffer(buf) && buf.length > 0 && buf.length <= 4_500_000) {
                        const rawMime = inner?.audioMessage?.mimetype || inner?.imageMessage?.mimetype || '';
                        const cleanMime = rawMime.split(';')[0].trim() || (mediaItem.hasAudio ? 'audio/ogg' : 'image/jpeg');
                        mediaAttachment = {
                            type: mediaItem.hasAudio ? 'audio' : 'image',
                            data: buf.toString('base64'),
                            mimeType: cleanMime
                        };
                    }
                }
            } catch {}
        }

        const llmStartedMs = Date.now();

        // Debounced turn flood guard (counts merged AI reply turns, not individual burst bubbles!)
        const p10m = tenant.safety?.perUserCustom ? (tenant.safety?.perUser10m || 15) : Math.max(15, Number(tenant.safety?.perUser10m || 15));
        if (!rt.userFloodLimiter.consume(`${canonicalRef}:10m`, p10m, 10 * 60_000).allowed) {
            await this.logAndEmit(tenantId, 'warn', 'safety', `Rate limit paused rapid AI replies for ${peer.phoneNumber} (${p10m} turns / 10m).`);
            return;
        }

        const existingLead = await cols.leads.findOne({ tenantId, contactRef: peer.canonicalRef }).catch(() => null);
        const systemPrompt = buildTenantSystemPrompt(
            tenant,
            { displayName: convDoc.displayName, phoneNumber: convDoc.phoneNumber },
            mergedText,
            {
                knownLead: existingLead,
                customerFacts: convDoc.customerFacts || {},
                hasHistory: Array.isArray(convDoc.contextTurns) && convDoc.contextTurns.length > 0
            }
        );

        // 4. Run AI + Guardrails IMMEDIATELY BEFORE calling readMessages (preserves unseen state on [NO_REPLY]!)
        const aiRes = await generateAIReply({
            systemPrompt,
            contextTurns: convDoc.contextTurns || [],
            userText: mergedText,
            mediaAttachment,
            aiConfig: tenant.aiConfig,
            tenant,
            customerQuery: mergedText,
            contactContext: { displayName: convDoc.displayName, phoneNumber: convDoc.phoneNumber },
            isFollowUp: Array.isArray(convDoc.contextTurns) && convDoc.contextTurns.length > 0
        });
        mediaAttachment = null;

        // Check if owner manually jumped in while LLM ran
        const postPause = rt.pausedUntilCache.get(canonicalRef);
        if (postPause && (postPause.pausedAt > batchEnqueuedAt || postPause.pausedUntil > Date.now())) {
            return;
        }
        if (rt.sock !== sock || rt.status !== 'open') return;

        // 5. SILENT ABSTENTION (Unknown / Off-topic / Guardrail Blocked):
        //    Do NOT call sock.readMessages() & do NOT reply -> keeps green unread badge (1) on client WhatsApp phone + logs & flags Dashboard!
        if (aiRes.isNoReply || !aiRes.text) {
            const reasonTag = aiRes.guardrailBlocked
                ? `guardrail:${aiRes.guardrailReason}`
                : (aiRes.handoffData?.reason || 'unknown_or_offtopic_unseen');
            const detail = aiRes.guardrailBlocked
                ? `blocked unverified draft (${aiRes.guardrailReason})`
                : `unknown or off-topic query (${aiRes.guardrailReason || 'no_reply'})`;
            await this._markUnseenForOwner(tenantId, rt, tenant, convId, convDoc, peer, canonicalRef, reasonTag, detail, aiRes.quarantinedText || null);
            return;
        }

        // 6. CONFIRMED REPLY PATH: Complete remaining read dwell, then emit Blue Ticks!
        const targetDwell = HumanTypingSimulator.getReadDwell(mergedText);
        const remainingDwell = Math.max(0, targetDwell - (Date.now() - llmStartedMs));
        if (remainingDwell > 0) await HumanMath.sleep(remainingDwell);

        if (tenant.safety?.readReceipts !== false) {
            const keys = items.map((i) => i.msg.key).filter(Boolean);
            if (keys.length > 0) await sock.readMessages(keys).catch(() => {});
        }
        await HumanMath.sleep(HumanMath.clamp(HumanMath.normal(320, 70), 220, 520));

        // Final abort check before typing presence & send
        const finalPause = rt.pausedUntilCache.get(canonicalRef);
        if (finalPause && (finalPause.pausedAt > batchEnqueuedAt || finalPause.pausedUntil > Date.now())) {
            return;
        }
        if (rt.sock !== sock || rt.status !== 'open') return;

        const chunks = splitHumanBubbles(aiRes.text, tenant.safety?.splitLongReplies !== false);
        const quoteMsg = shouldQuoteInboundMessage({
            peer,
            items,
            lastItem,
            batchEnqueuedAt,
            quoteSetting: tenant.safety?.quoteReplies
        });
        let lastSentId = '';

        for (let idx = 0; idx < chunks.length; idx++) {
            const chunk = chunks[idx];
            if (idx > 0) {
                await HumanMath.sleep(HumanMath.clamp(HumanMath.normal(520, 80), 350, 800));
            }
            const typingMs = HumanTypingSimulator.getTypingDuration(chunk, idx > 0);
            await sock.sendPresenceUpdate('composing', peer.remoteJid).catch(() => {});
            await HumanMath.sleep(typingMs);
            await sock.sendPresenceUpdate('paused', peer.remoteJid).catch(() => {});
            await HumanMath.sleep(120);

            const msgId = generateMessageIDV2(sock.user?.id);
            rt.botSentIds.set(msgId, true);
            lastSentId = msgId;

            const opts = { messageId: msgId };
            if (idx === 0 && quoteMsg?.message) opts.quoted = quoteMsg;
            rt.sentProtoBuffer.set(msgId, { conversation: chunk });

            const sendPayload = { text: chunk };
            if (peer.isGroup && lastItem.senderParticipant) {
                sendPayload.mentions = [lastItem.senderParticipant];
            }
            await sock.sendMessage(peer.remoteJid, sendPayload, opts);
        }

        rt.hourlyCounter.count++;

        // Build durable customerFacts & concise voice-summary memory
        const now = new Date();
        const nextFacts = { ...(convDoc.customerFacts || {}) };
        if (aiRes.leadData?.name) nextFacts.name = aiRes.leadData.name;
        if (aiRes.leadData?.goal || aiRes.leadData?.intent) nextFacts.goal = aiRes.leadData.goal || aiRes.leadData.intent;
        if (aiRes.leadData?.plan) nextFacts.plan = aiRes.leadData.plan;
        if (aiRes.leadData?.budget) nextFacts.budget = aiRes.leadData.budget;
        if (aiRes.leadData?.slot) nextFacts.slot = aiRes.leadData.slot;

        const userTurnText = aiRes.voiceIntent
            ? `[Voice Note]: ${aiRes.voiceIntent}`
            : mergedText.slice(0, 600);

        const nextStatus = aiRes.handoffData ? 'human_needed' : 'active';
        let nextFollowUpAt = null;
        if (
            !aiRes.handoffData &&
            tenant.safety?.followUpEnabled &&
            !convDoc.followUpSentAt &&
            !nextFacts.slot &&
            existingLead?.stage !== 'booked' &&
            existingLead?.stage !== 'won' &&
            existingLead?.stage !== 'lost'
        ) {
            const delayHrs = Math.max(1, Math.min(24, Number(tenant.safety?.followUpDelayHours || 4)));
            nextFollowUpAt = new Date(now.getTime() + delayHrs * 3600_000);
        }

        await cols.conversations.updateOne(
            { _id: convId },
            {
                $set: {
                    aiStatus: nextStatus,
                    unseenForOwner: Boolean(aiRes.handoffData),
                    lastMessagePreview: aiRes.text.slice(0, 120),
                    lastMessageAt: now,
                    unreadCount: 0,
                    customerFacts: nextFacts,
                    ...(nextFacts.name ? { displayName: nextFacts.name } : {}),
                    followUpAt: nextFollowUpAt,
                    expiresAt: addDays(now, 180)
                },
                $push: {
                    contextTurns: {
                        $each: [
                            { role: 'user', text: userTurnText },
                            { role: 'assistant', text: aiRes.text.slice(0, 600) }
                        ],
                        $slice: -10
                    }
                }
            }
        ).catch(() => {});

        await this._recordBotMessage(tenantId, convId, aiRes.text, aiRes.model, aiRes.latencyMs, lastSentId);
        await incrementDailyAnalytics(tenantId, tz, {
            aiOutCount: 1,
            latencyMs: aiRes.latencyMs,
            model: aiRes.model,
            errorCount: aiRes.isError ? 1 : 0
        });

        await this.logAndEmit(
            tenantId,
            aiRes.isError ? 'warn' : 'info',
            'ai',
            `Replied to ${nextFacts.name || convDoc.displayName || peer.phoneNumber} (${peer.phoneNumber}) via ${aiRes.model} in ${aiRes.latencyMs}ms${aiRes.fallbackNote ? ` [fallback after ${aiRes.fallbackNote}]` : ''}.`
        );

        // Capture/Enrich Rich Lead + Instant Deduplicated Owner Alert
        if (aiRes.leadData) {
            await this._upsertLead(tenantId, rt, tenant, { ...convDoc, displayName: nextFacts.name || convDoc.displayName }, aiRes.leadData, tz);
        }

        // Pause AI after clean mid-conversation bridge handoff so human team takes over smoothly
        if (aiRes.handoffData) {
            const hMins = Number(tenant.safety?.takeoverMinutes ?? 30);
            const hPauseUntil = hMins === 0 ? addDays(now, 3650) : new Date(now.getTime() + hMins * 60_000);
            rt.pausedUntilCache.set(canonicalRef, { pausedAt: now.getTime(), pausedUntil: hPauseUntil.getTime() }, Math.max(hMins, 60) * 60_000);

            await cols.conversations.updateOne(
                { _id: convId },
                {
                    $set: {
                        aiStatus: 'human_needed',
                        pausedUntil: hPauseUntil,
                        pauseReason: `ai_handoff:${aiRes.handoffData.reason}`
                    }
                }
            ).catch(() => {});

            eventBus.emitTenant(tenantId, 'inbox_msg', {
                conversationId: convId,
                aiStatus: 'human_needed',
                pausedUntil: hPauseUntil.toISOString()
            });

            await this.logAndEmit(
                tenantId,
                'warn',
                'takeover',
                `AI escalated ${convDoc.displayName || peer.phoneNumber} to human team (${aiRes.handoffData.reason}).`
            );
        }
    }

    async _recordBotMessage(tenantId, conversationId, text, model, latencyMs, waMsgId) {
        const now = new Date();
        const doc = {
            tenantId,
            conversationId,
            isSandbox: false,
            dir: 'out',
            senderType: 'ai',
            msgType: 'text',
            text: String(text || '').slice(0, 2500),
            model,
            latencyMs,
            waMsgId,
            createdAt: now,
            expiresAt: addDays(now, 30)
        };
        await cols.messages.insertOne(doc).catch(() => {});
        eventBus.emitTenant(tenantId, 'inbox_msg', {
            conversationId,
            message: { ...doc, createdAt: now.toISOString() }
        });
    }

    async _upsertLead(tenantId, rt, tenant, convDoc, leadData, tz) {
        const now = new Date();
        const existing = await cols.leads.findOne({ tenantId, contactRef: convDoc.externalRef });
        const existingStage = normalizeLeadStage(existing?.stage || 'new');
        let nextStage = existingStage;

        if (leadData.slot && !['won', 'lost'].includes(existingStage)) {
            nextStage = 'booked';
        } else if (existingStage === 'new' && (leadData.score === 'hot' || leadData.plan || leadData.budget || leadData.dealValue)) {
            nextStage = 'qualified';
        }

        const resolvedDealVal = Number(leadData.dealValue) || existing?.dealValue || 0;
        const setFields = {
            name: leadData.name || existing?.name || convDoc.displayName || convDoc.phoneNumber,
            phone: convDoc.phoneNumber,
            goal: leadData.goal || leadData.intent || existing?.goal || existing?.intent || 'General Inquiry',
            intent: leadData.intent || leadData.goal || existing?.intent || 'General Inquiry',
            planInterest: leadData.plan || existing?.planInterest || '',
            dealValue: resolvedDealVal,
            budget: leadData.budget || existing?.budget || (resolvedDealVal ? String(resolvedDealVal) : ''),
            bookedSlot: leadData.slot || existing?.bookedSlot || '',
            whyHot: leadData.why || existing?.whyHot || '',
            nextStep: leadData.next || existing?.nextStep || '',
            score: leadData.score || existing?.score || 'warm',
            stage: nextStage,
            conversationId: convDoc._id,
            updatedAt: now
        };

        await cols.leads.updateOne(
            { tenantId, contactRef: convDoc.externalRef },
            {
                $setOnInsert: {
                    tenantId,
                    channel: 'wa',
                    contactRef: convDoc.externalRef,
                    createdAt: now
                },
                $set: setFields
            },
            { upsert: true }
        ).catch(() => {});

        if (!existing) {
            await incrementDailyAnalytics(tenantId, tz, { leadsCount: 1 });
        }

        await this.logAndEmit(tenantId, 'info', 'ai', `Captured ${setFields.score.toUpperCase()} lead [${nextStage.toUpperCase()}]: ${setFields.name} (${setFields.goal}).`);

        // Deduplicated WhatsApp Owner Alert (max 1 per Hot Lead + 1 per new Booking Slot!)
        if (tenant.safety?.hotLeadAlertEnabled !== false) {
            const isNewHot = setFields.score === 'hot' && !existing?.hotAlertSentAt;
            const isNewBooking = Boolean(setFields.bookedSlot && setFields.bookedSlot !== existing?.lastAlertedSlot);
            if (isNewHot || isNewBooking) {
                const headline = isNewBooking ? '📅 NEW VISIT / BOOKING LOCKED' : '🔥 HOT LEAD ALERT';
                const alertLines = [
                    headline,
                    `Name: ${setFields.name} (${setFields.phone})`,
                    `Need: ${setFields.goal}`,
                    setFields.planInterest || setFields.budget ? `Plan/Value: ${[setFields.planInterest, setFields.budget ? `₹${setFields.budget}` : ''].filter(Boolean).join(' · ')}` : '',
                    setFields.bookedSlot ? `Slot: ${setFields.bookedSlot}` : '',
                    setFields.whyHot ? `Why: ${setFields.whyHot}` : '',
                    setFields.nextStep ? `Next: ${setFields.nextStep}` : ''
                ].filter(Boolean).join('\n');

                const sentOk = await this._sendOwnerAlert(tenantId, rt, tenant, alertLines);
                if (sentOk) {
                    const alertSet = {};
                    if (isNewHot) alertSet.hotAlertSentAt = now;
                    if (isNewBooking) alertSet.lastAlertedSlot = setFields.bookedSlot;
                    await cols.leads.updateOne({ tenantId, contactRef: convDoc.externalRef }, { $set: alertSet }).catch(() => {});
                }
            }
        }

        if (tenant.safety?.webhookUrl && setFields.score === 'hot') {
            fetch(tenant.safety.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'hot_lead', tenantId, lead: setFields, timestamp: now.toISOString() })
            }).catch(() => {});
        }
    }

    async _runBackgroundSweep() {
        if (!cols.tenants || !cols.conversations || this.isShuttingDown) return;
        const now = new Date();
        const minus2h = new Date(now.getTime() - 2 * 3600_000);
        const minus24h = new Date(now.getTime() - 24 * 3600_000);

        for (const [tenantId, rt] of this.runtimes.entries()) {
            if (this.isShuttingDown || !rt.sock || rt.status !== 'open' || rt.circuitBreakerUntil > Date.now()) continue;

            const tenant = await cols.tenants.findOne({ _id: tenantId }).catch(() => null);
            if (!tenant || tenant.status !== 'active' || !tenant.safety?.aiEnabled) continue;

            const tz = tenant.safety?.timezone || 'Asia/Kolkata';
            const { dayKey, hourKey } = getLocalDayAndHour(now, tz);
            const curHourNum = Number(hourKey);

            // 1. Optional Daily Evening Owner Summary (Note-to-Self / Owner Phone)
            const digestHour = Number(tenant.safety?.dailyDigestHour ?? 20);
            if (tenant.safety?.dailyDigestEnabled && curHourNum >= digestHour && tenant.lastDigestDayKey !== dayKey) {
                const claimed = await cols.tenants.updateOne(
                    { _id: tenantId, lastDigestDayKey: { $ne: dayKey } },
                    { $set: { lastDigestDayKey: dayKey } }
                ).catch(() => null);

                if (claimed?.modifiedCount === 1) {
                    const [dailyStat, unseenCnt, bookedToday] = await Promise.all([
                        cols.analyticsDaily.findOne({ _id: `${tenantId}:${dayKey}` }).catch(() => null),
                        cols.conversations.countDocuments({ tenantId, isSandbox: false, aiStatus: 'human_needed' }).catch(() => 0),
                        cols.leads.countDocuments({ tenantId, stage: 'booked', updatedAt: { $gte: minus24h } }).catch(() => 0)
                    ]);
                    const digestMsg = [
                        `📊 *Daily WhatsApp Summary (${tenant.name})*`,
                        `Messages In: ${dailyStat?.inCount || 0} | AI Replies: ${dailyStat?.aiOutCount || 0}`,
                        `New Leads Today: ${dailyStat?.leadsCount || 0} | Booked Visits: ${bookedToday}`,
                        unseenCnt > 0 ? `Waiting for You (Unseen): ${unseenCnt} chats` : 'All caught up — zero chats waiting!'
                    ].join('\n');
                    await this._sendOwnerAlert(tenantId, rt, tenant, digestMsg);
                }
            }

            // 2. Safe 1-Shot Ghosted-Inquiry Revival Sweeper (Business Hours + Safety Capped)
            if (!tenant.safety?.followUpEnabled) continue;
            const hrsCheck = isWithinOperatingWindow(tenant.safety);
            if (!hrsCheck.aiAllowed) continue;

            const dailyStats = await cols.analyticsDaily.findOne({ _id: `${tenantId}:${dayKey}` }).catch(() => null);
            const maxDaily = tenant.safety?.maxDailyOut || 90;
            if ((dailyStats?.aiOutCount || 0) >= maxDaily) continue;

            const dueConvs = await cols.conversations
                .find({
                    tenantId,
                    isSandbox: false,
                    optedOut: { $ne: true },
                    aiStatus: 'active',
                    lastMessageAt: { $gte: minus24h, $lte: minus2h },
                    followUpAt: { $ne: null, $lte: now },
                    followUpSentAt: null
                })
                .limit(5)
                .toArray()
                .catch(() => []);

            for (const conv of dueConvs) {
                if (conv.pausedUntil && new Date(conv.pausedUntil).getTime() > now.getTime()) continue;

                // Atomic one-shot lock prevents duplicate follow-ups across restarts
                const lock = await cols.conversations.updateOne(
                    { _id: conv._id, followUpSentAt: null },
                    { $set: { followUpAt: null, followUpSentAt: now } }
                ).catch(() => null);
                if (lock?.matchedCount !== 1) continue;

                const prompt = buildTenantSystemPrompt(
                    tenant,
                    { displayName: conv.displayName, phoneNumber: conv.phoneNumber },
                    conv.lastMessagePreview || '',
                    { customerFacts: conv.customerFacts || {}, hasHistory: true }
                );
                const nudgeRes = await generateAIReply({
                    systemPrompt: prompt,
                    contextTurns: conv.contextTurns || [],
                    userText: '[INTERNAL SYSTEM: The customer asked about our service a few hours ago and went quiet. Write 1 ultra-short, warm, zero-pressure follow-up line (max 15 words) checking if they need slot help. NEVER invent prices/discounts. Output [NO_REPLY] if previous exchange was not an inquiry.]',
                    tenant,
                    contactContext: { displayName: conv.displayName, phoneNumber: conv.phoneNumber },
                    isFollowUp: true,
                    strictGrounding: true
                });

                if (nudgeRes.isNoReply || !nudgeRes.text) continue;

                const targetJid = conv.remoteJid || `${conv.externalRef}@s.whatsapp.net`;
                const msgId = generateMessageIDV2(rt.sock.user?.id);
                rt.botSentIds.set(msgId, true);
                rt.sentProtoBuffer.set(msgId, { conversation: nudgeRes.text });
                await rt.sock.sendMessage(targetJid, { text: nudgeRes.text }, { messageId: msgId }).catch(() => {});
                await this._recordBotMessage(tenantId, conv._id, nudgeRes.text, `${nudgeRes.model}-revival`, nudgeRes.latencyMs, msgId);
                await incrementDailyAnalytics(tenantId, tz, { aiOutCount: 1 });
                await this.logAndEmit(tenantId, 'info', 'ai', `Sent 1-shot gentle revival follow-up to ${conv.displayName || conv.phoneNumber}.`);
            }
        }
    }

    async sendDashboardManualReply(tenantId, conversationDoc, replyText) {
        const rt = this.getRuntime(tenantId);
        if (!rt.sock || rt.status !== 'open') {
            throw new Error('WhatsApp is currently disconnected. Connect WhatsApp first to send messages.');
        }

        const tenant = await cols.tenants.findOne({ _id: tenantId });
        const targetJid = conversationDoc.remoteJid || (conversationDoc.externalRef.includes('@') ? conversationDoc.externalRef : `${conversationDoc.externalRef}@s.whatsapp.net`);
        const msgId = generateMessageIDV2(rt.sock.user?.id);
        rt.botSentIds.set(msgId, true);
        rt.sentProtoBuffer.set(msgId, { conversation: replyText });

        await rt.sock.sendMessage(targetJid, { text: replyText }, { messageId: msgId });

        const takeoverMins = Number(tenant?.safety?.takeoverMinutes ?? 30);
        const now = new Date();
        const pausedUntil = takeoverMins === 0 ? addDays(now, 3650) : new Date(now.getTime() + takeoverMins * 60_000);

        rt.debouncer?.cleanup(conversationDoc.externalRef);
        rt.pausedUntilCache.set(conversationDoc.externalRef, { pausedAt: now.getTime(), pausedUntil: pausedUntil.getTime() }, Math.max(takeoverMins, 60) * 60_000);

        await cols.conversations.updateOne(
            { _id: conversationDoc._id },
            {
                $set: {
                    aiStatus: 'paused',
                    unseenForOwner: false,
                    pausedUntil,
                    pauseReason: 'dashboard_agent',
                    followUpAt: null,
                    unreadCount: 0,
                    lastMessagePreview: `You: ${replyText.slice(0, 100)}`,
                    lastMessageAt: now,
                    expiresAt: addDays(now, 180)
                },
                $push: {
                    contextTurns: {
                        $each: [{ role: 'assistant', text: `[Human Agent]: ${replyText.slice(0, 600)}` }],
                        $slice: -10
                    }
                }
            }
        );

        const doc = {
            tenantId,
            conversationId: conversationDoc._id,
            isSandbox: false,
            dir: 'out',
            senderType: 'dashboard_agent',
            msgType: 'text',
            text: replyText.slice(0, 2500),
            waMsgId: msgId,
            createdAt: now,
            expiresAt: addDays(now, 30)
        };
        await cols.messages.insertOne(doc);
        await incrementDailyAnalytics(tenantId, tenant?.safety?.timezone || 'Asia/Kolkata', { agentOutCount: 1 });

        eventBus.emitTenant(tenantId, 'inbox_msg', {
            conversationId: conversationDoc._id,
            aiStatus: 'paused',
            unseenForOwner: false,
            pausedUntil: pausedUntil.toISOString(),
            message: { ...doc, createdAt: now.toISOString() }
        });
        await this.logAndEmit(tenantId, 'info', 'takeover', `Sent manual reply from Inbox to ${conversationDoc.displayName || conversationDoc.phoneNumber}. AI paused.`);
        return doc;
    }

    _extractPreviewText(msg) {
        return this._extractNormalizedPayload(msg).text;
    }

    async shutdownAll() {
        this.isShuttingDown = true;
        if (this.sweeperTimer) {
            clearInterval(this.sweeperTimer);
            this.sweeperTimer = null;
        }
        const tasks = [];
        for (const tenantId of this.runtimes.keys()) {
            tasks.push(this.disconnectTenant(tenantId, { preserveAuth: true, quiet: true }));
        }
        await Promise.allSettled(tasks);
    }
}

export const waManager = new WhatsAppTenantManager();
