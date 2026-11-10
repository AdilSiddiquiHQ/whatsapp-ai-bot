import makeWASocket, {
    DisconnectReason,
    fetchLatestWaWebVersion,
    Browsers,
    jidNormalizedUser,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore,
    downloadMediaMessage,
    generateMessageIDV2,
    WAMessageStatus
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { CONFIG } from './config.mjs';
import { BoundedCacheStore, SlidingWindowLimiter } from './cache.mjs';
import {
    cols,
    addDays,
    getLocalDayAndHour,
    recordActivityLog,
    incrementDailyAnalytics
} from './db.mjs';
import { eventBus } from './stream.mjs';
import { buildTenantSystemPrompt, generateAIReply } from './ai-engine.mjs';

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
    static getReadDwell() {
        return HumanMath.clamp(HumanMath.logNormal(1200, 0.35), 700, 2400);
    }
    static getThinkingDelay(text) {
        const chars = (text || '').trim().length;
        const reading = chars * HumanMath.normal(38, 7);
        const formulation = HumanMath.logNormal(1400, 0.35);
        return HumanMath.clamp(reading + formulation, 900, 3800);
    }
    static getTypingDuration(replyText) {
        const chars = (replyText || '').length;
        const dur = chars * 13 + HumanMath.normal(200, 80);
        return HumanMath.clamp(dur, 1000, 3200);
    }
}

class TenantDebouncer {
    constructor(onBatch) {
        this.buffers = new Map();
        this.onBatch = onBatch;
    }
    enqueue(canonicalRef, item, idleMs = 1800, maxWaitMs = 5500) {
        let entry = this.buffers.get(canonicalRef);
        if (!entry) {
            entry = {
                items: [],
                enqueuedAt: Date.now(),
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

            // Monitor delivery NACKs (463 Reachout Timelock / 429)
            sock.ev.on('messages.update', async (updates) => {
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

    async _handleUpsertMessage(tenantId, rt, sock, msg, type) {
        try {
            if (!msg.message) return;
            const jid = msg.key.remoteJid;
            if (!jid || jid === 'status@broadcast' || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) return;

            // Skip internal Baileys protocol / encryption sync payloads
            if (msg.message.protocolMessage || msg.message.senderKeyDistributionMessage) return;

            const tenant = await cols.tenants.findOne({ _id: tenantId });
            if (!tenant || tenant.status !== 'active') return;

            const isFromMe = Boolean(msg.key.fromMe);
            const msgTsMs = (Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

            // Catch live owner phone/web echoes on both notify and recent append reconnect windows
            if (isFromMe) {
                const isRecent = Date.now() - msgTsMs < 120_000 && msgTsMs >= rt.bootTimeMs - 15_000;
                if (type !== 'notify' && !isRecent) return;

                // Did our bot send this message? Checked via pre-registered IDs!
                if (rt.botSentIds.has(msg.key.id)) return;

                const peer = this._resolvePeerIdentity(rt, msg);
                if (peer.isGroup) return;

                const extractedText = this._extractPreviewText(msg) || '[Attachment]';
                await this._handleManualOwnerEcho(tenantId, rt, tenant, peer, extractedText, msg.key.id);
                return;
            }

            if (type !== 'notify') return;

            const peer = this._resolvePeerIdentity(rt, msg);
            if (peer.isGroup) {
                const groupMode = tenant.safety?.groupMode || 'ignore_all';
                if (groupMode === 'ignore_all') return;

                const rawText = this._extractPreviewText(msg);
                const botPnJid = jidNormalizedUser(sock.user?.id || '');
                const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                const isMentioned = mentioned.some((m) => jidNormalizedUser(m) === botPnJid);
                const isQuotedBot = jidNormalizedUser(msg.message.extendedTextMessage?.contextInfo?.participant || '') === botPnJid;
                const hasPrefix = rawText.startsWith('!ai') || rawText.startsWith('/ask');
                if (!isMentioned && !isQuotedBot && !hasPrefix) return;
            }

            // Check VIP/Family Blacklist BEFORE storing / debouncing / reading!
            const blackSet = new Set((tenant.blacklist || []).map((b) => normalizeDigits(b.ref) || b.ref));
            if (blackSet.has(peer.canonicalRef) || blackSet.has(peer.remoteJid)) {
                await this.logAndEmit(tenantId, 'info', 'safety', `Ignored blocked number ${peer.phoneNumber}.`);
                return;
            }

            // Extract message content & optional ephemeral media attachment
            const textBody = this._extractPreviewText(msg);
            const hasAudio = Boolean(msg.message.audioMessage);
            const hasImage = Boolean(msg.message.imageMessage);

            if (!textBody && !hasAudio && !hasImage) return;

            let mediaTypeTag = 'text';
            if (hasAudio) mediaTypeTag = 'audio';
            else if (hasImage) mediaTypeTag = 'image';

            const convId = `${tenantId}:wa:${peer.canonicalRef}`;
            const now = new Date();
            const safePushName = msg.pushName && msg.pushName !== '~' ? msg.pushName.trim().slice(0, 80) : '';
            const previewLabel = textBody || (hasAudio ? '[Voice Note]' : '[Image]');

            // Upsert conversation (lookup LID/PN seamless updates without clobbering manual tags)
            const setFields = {
                tenantId,
                channel: 'wa',
                externalRef: peer.canonicalRef,
                remoteJid: peer.remoteJid,
                isSandbox: false,
                lastMessagePreview: previewLabel.slice(0, 120),
                lastMessageAt: now,
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
                    unreadCount: 1,
                    contextTurns: [],
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

            // Check Opt-Out / Opt-In keywords before scheduling AI
            const cleanCmd = textBody.trim().toLowerCase();
            const optOutList = tenant.safety?.optOutKeywords || ['stop', 'stopall', 'unsubscribe'];
            const optOutRegex = new RegExp(`^(${optOutList.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})[.!\\s]*$`, 'i');

            if (cleanCmd && optOutRegex.test(cleanCmd) && !convDoc?.optedOut) {
                await cols.conversations.updateOne({ _id: convId }, { $set: { optedOut: true, aiStatus: 'paused' } });
                const optMsgId = generateMessageIDV2(sock.user?.id);
                rt.botSentIds.set(optMsgId, true);
                const byeText = 'Automated AI replies are now paused for this chat. A human team member can still reply, or type *START* anytime to re-enable.';
                await sock.sendMessage(peer.remoteJid, { text: byeText }, { messageId: optMsgId }).catch(() => {});
                await this._recordBotMessage(tenantId, convId, byeText, 'system-optout', 0, optMsgId);
                await this.logAndEmit(tenantId, 'info', 'safety', `Customer ${peer.phoneNumber} opted out via "${textBody}".`);
                return;
            }

            if (convDoc?.optedOut) {
                if (/^(start|resume|subscribe)[.!\s]*$/i.test(cleanCmd)) {
                    await cols.conversations.updateOne({ _id: convId }, { $set: { optedOut: false, aiStatus: 'active', pausedUntil: null } });
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

            // Global Circuit Breaker check
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

            // Per-user flood guard
            const p10m = tenant.safety?.perUser10m || 6;
            if (!rt.userFloodLimiter.consume(`${peer.canonicalRef}:10m`, p10m, 10 * 60_000).allowed) {
                await this.logAndEmit(tenantId, 'warn', 'safety', `Rate limit paused rapid replies for ${peer.phoneNumber}.`);
                return;
            }

            // Enqueue into debouncer to merge burst messages seamlessly
            const debounceMs = Math.min(8000, Math.max(400, Number(tenant.safety?.debounceMs || 1800)));
            rt.debouncer.enqueue(
                peer.canonicalRef,
                { msg, peer, convId, textBody, hasAudio, hasImage, safePushName },
                debounceMs,
                6000
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

        // Cancel pending AI debounce and flag in-flight queue immediately!
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
                    contextTurns: [],
                    createdAt: now
                },
                $set: {
                    aiStatus: 'paused',
                    pausedUntil,
                    pauseReason: 'owner_app',
                    unreadCount: 0,
                    lastMessagePreview: `You: ${text.slice(0, 100)}`,
                    lastMessageAt: now,
                    expiresAt: addDays(now, 180)
                },
                $push: {
                    contextTurns: {
                        $each: [{ role: 'assistant', text: `[Human Agent]: ${text.slice(0, 600)}` }],
                        $slice: -8
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

        // Ephemeral media download (RAM only, discarded immediately after Gemini call!)
        let mediaAttachment = null;
        const mediaItem = [...items].reverse().find((it) => (it.hasAudio && tenant.safety?.voiceNotesEnabled) || (it.hasImage && tenant.safety?.imageVisionEnabled));
        if (mediaItem) {
            try {
                const m = mediaItem.msg;
                const fileSize = Number(m.message?.audioMessage?.fileLength || m.message?.imageMessage?.fileLength || 0);
                if (fileSize <= 4_500_000) {
                    const buf = await downloadMediaMessage(m, 'buffer', {}, {
                        logger: silentLogger,
                        reuploadRequest: sock.updateMediaMessage
                    });
                    if (Buffer.isBuffer(buf) && buf.length > 0 && buf.length <= 4_500_000) {
                        const rawMime = m.message?.audioMessage?.mimetype || m.message?.imageMessage?.mimetype || '';
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

        const mergedText = items
            .map((i) => i.textBody || (i.hasAudio ? '[Voice Note]' : '[Image]'))
            .filter(Boolean)
            .join('\n');

        // Read dwell & read receipt
        await HumanMath.sleep(HumanTypingSimulator.getReadDwell());
        if (tenant.safety?.readReceipts !== false) {
            const keys = items.map((i) => i.msg.key).filter(Boolean);
            if (keys.length > 0) await sock.readMessages(keys).catch(() => {});
        }

        await HumanMath.sleep(HumanTypingSimulator.getThinkingDelay(mergedText));

        // Double check no owner takeover started while reading/thinking!
        const recheckPause = rt.pausedUntilCache.get(canonicalRef);
        if (recheckPause && (recheckPause.pausedAt > batchEnqueuedAt || recheckPause.pausedUntil > Date.now())) {
            return;
        }

        const systemPrompt = buildTenantSystemPrompt(tenant, {
            displayName: convDoc.displayName,
            phoneNumber: convDoc.phoneNumber
        });

        const aiRes = await generateAIReply({
            systemPrompt,
            contextTurns: convDoc.contextTurns || [],
            userText: mergedText,
            mediaAttachment
        });
        mediaAttachment = null; // Free RAM immediately

        // Final check before typing & sending!
        const finalPause = rt.pausedUntilCache.get(canonicalRef);
        if (finalPause && (finalPause.pausedAt > batchEnqueuedAt || finalPause.pausedUntil > Date.now())) {
            return;
        }
        if (rt.sock !== sock || rt.status !== 'open') return;

        // Split long multi-paragraph replies naturally if opted in
        const chunks = tenant.safety?.splitLongReplies && aiRes.text.length > 220 && aiRes.text.includes('\n\n')
            ? aiRes.text.split('\n\n').map((s) => s.trim()).filter(Boolean).slice(0, 3)
            : [aiRes.text];

        const quoteMsg = tenant.safety?.quoteReplies !== false ? lastItem.msg : null;
        let lastSentId = '';

        for (let idx = 0; idx < chunks.length; idx++) {
            const chunk = chunks[idx];
            const typingMs = HumanTypingSimulator.getTypingDuration(chunk);
            await sock.sendPresenceUpdate('composing', peer.remoteJid).catch(() => {});
            await HumanMath.sleep(idx === 0 ? typingMs : Math.min(1800, typingMs));
            await sock.sendPresenceUpdate('paused', peer.remoteJid).catch(() => {});
            await HumanMath.sleep(180);

            const msgId = generateMessageIDV2(sock.user?.id);
            rt.botSentIds.set(msgId, true);
            lastSentId = msgId;

            const opts = { messageId: msgId };
            if (idx === 0 && quoteMsg?.message) opts.quoted = quoteMsg;
            rt.sentProtoBuffer.set(msgId, { conversation: chunk });
            await sock.sendMessage(peer.remoteJid, { text: chunk }, opts);
        }

        rt.hourlyCounter.count++;

        // Update bounded AI context turns (max 8) + metrics
        await cols.conversations.updateOne(
            { _id: convId },
            {
                $set: {
                    lastMessagePreview: aiRes.text.slice(0, 120),
                    lastMessageAt: new Date(),
                    unreadCount: 0,
                    expiresAt: addDays(new Date(), 180)
                },
                $push: {
                    contextTurns: {
                        $each: [
                            { role: 'user', text: mergedText.slice(0, 600) },
                            { role: 'assistant', text: aiRes.text.slice(0, 600) }
                        ],
                        $slice: -8
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
            `Replied to ${convDoc.displayName || peer.phoneNumber} (${peer.phoneNumber}) via ${aiRes.model} in ${aiRes.latencyMs}ms.`
        );

        // Capture Lead if AI spotted high-intent signal
        if (aiRes.leadData) {
            await this._upsertLead(tenantId, tenant, convDoc, aiRes.leadData, tz);
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

    async _upsertLead(tenantId, tenant, convDoc, leadData, tz) {
        const now = new Date();
        const existing = await cols.leads.findOne({ tenantId, contactRef: convDoc.externalRef });
        const setFields = {
            name: convDoc.displayName || convDoc.phoneNumber,
            phone: convDoc.phoneNumber,
            intent: leadData.intent || existing?.intent || 'General Inquiry',
            budget: leadData.budget || existing?.budget || '',
            score: leadData.score || existing?.score || 'warm',
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
                    stage: 'new',
                    createdAt: now
                },
                $set: setFields
            },
            { upsert: true }
        ).catch(() => {});

        if (!existing) {
            await incrementDailyAnalytics(tenantId, tz, { leadsCount: 1 });
        }

        await this.logAndEmit(tenantId, 'info', 'ai', `Captured ${setFields.score.toUpperCase()} lead: ${setFields.name} (${setFields.intent}).`);

        if (tenant.safety?.webhookUrl && setFields.score === 'hot') {
            fetch(tenant.safety.webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'hot_lead', tenantId, lead: setFields, timestamp: now.toISOString() })
            }).catch(() => {});
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
                    pausedUntil,
                    pauseReason: 'dashboard_agent',
                    unreadCount: 0,
                    lastMessagePreview: `You: ${replyText.slice(0, 100)}`,
                    lastMessageAt: now,
                    expiresAt: addDays(now, 180)
                },
                $push: {
                    contextTurns: {
                        $each: [{ role: 'assistant', text: `[Human Agent]: ${replyText.slice(0, 600)}` }],
                        $slice: -8
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
            pausedUntil: pausedUntil.toISOString(),
            message: { ...doc, createdAt: now.toISOString() }
        });
        await this.logAndEmit(tenantId, 'info', 'takeover', `Sent manual reply from Inbox to ${conversationDoc.displayName || conversationDoc.phoneNumber}. AI paused.`);
        return doc;
    }

    _extractPreviewText(msg) {
        const m = msg?.message;
        if (!m) return '';
        return (
            m.conversation ||
            m.extendedTextMessage?.text ||
            m.imageMessage?.caption ||
            m.videoMessage?.caption ||
            m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
            m.buttonsResponseMessage?.selectedDisplayText ||
            m.listResponseMessage?.title ||
            ''
        ).trim();
    }

    async shutdownAll() {
        this.isShuttingDown = true;
        const tasks = [];
        for (const tenantId of this.runtimes.keys()) {
            tasks.push(this.disconnectTenant(tenantId, { preserveAuth: true, quiet: true }));
        }
        await Promise.allSettled(tasks);
    }
}

export const waManager = new WhatsAppTenantManager();
