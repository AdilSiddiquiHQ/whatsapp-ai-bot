import crypto from 'node:crypto';
import { MongoClient } from 'mongodb';
import { CONFIG } from './config.mjs';

let mongoClient = null;
let db = null;

export const cols = {
    systemConfig: null,
    tenants: null,
    users: null,
    waAuth: null,
    conversations: null,
    messages: null,
    leads: null,
    analyticsDaily: null,
    activityLogs: null
};

let cachedAuthSecret = '';
let cachedDbStats = { data: null, fetchedAt: 0 };

export function addDays(date, days) {
    return new Date(date.getTime() + days * 86_400_000);
}

export function getLocalDayAndHour(date = new Date(), timeZone = 'Asia/Kolkata') {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hour12: false
        }).formatToParts(date);
        const get = (t) => parts.find((p) => p.type === t)?.value || '00';
        const hourNum = Number(get('hour')) % 24;
        const dayKey = `${get('year')}-${get('month')}-${get('day')}`;
        return { dayKey, hourKey: String(hourNum) };
    } catch {
        const iso = date.toISOString();
        return { dayKey: iso.slice(0, 10), hourKey: String(date.getUTCHours()) };
    }
}

export async function initDatabase() {
    if (!CONFIG.MONGODB_URI) {
        console.warn('MONGODB_URI not set. Database-backed SaaS workspace requires MongoDB Atlas URI.');
        return false;
    }

    mongoClient = new MongoClient(CONFIG.MONGODB_URI, {
        serverSelectionTimeoutMS: 10_000,
        maxPoolSize: 8
    });
    await mongoClient.connect();
    db = mongoClient.db(CONFIG.MONGODB_DB_NAME);

    cols.systemConfig = db.collection('system_config');
    cols.tenants = db.collection('tenants');
    cols.users = db.collection('users');
    cols.waAuth = db.collection('wa_auth');
    cols.conversations = db.collection('conversations');
    cols.messages = db.collection('messages');
    cols.leads = db.collection('leads');
    cols.analyticsDaily = db.collection('analytics_daily');
    cols.activityLogs = db.collection('activity_logs');

    // Minimal M0-friendly indexes (strictly <= 3 custom indexes per collection, single-field TTLs!)
    await Promise.all([
        cols.users.createIndex({ usernameNormalized: 1 }, { unique: true }),
        cols.users.createIndex({ tenantId: 1 }),

        cols.waAuth.createIndex({ tenantId: 1 }),

        cols.conversations.createIndex({ tenantId: 1, channel: 1, externalRef: 1 }, { unique: true }),
        cols.conversations.createIndex({ tenantId: 1, isSandbox: 1, lastMessageAt: -1 }),
        cols.conversations.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

        cols.messages.createIndex({ conversationId: 1, createdAt: -1 }),
        cols.messages.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

        cols.leads.createIndex({ tenantId: 1, contactRef: 1 }, { unique: true }),
        cols.leads.createIndex({ tenantId: 1, stage: 1, updatedAt: -1 }),
        cols.leads.createIndex({ tenantId: 1, createdAt: -1 }),

        cols.analyticsDaily.createIndex({ tenantId: 1, date: -1 }),
        cols.analyticsDaily.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

        cols.activityLogs.createIndex({ tenantId: 1, createdAt: -1 }),
        cols.activityLogs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    ]);

    await ensurePersistentAuthSecret();
    console.log(`Connected to MongoDB Atlas (${CONFIG.MONGODB_DB_NAME}) with minimal-storage TTL indexes.`);
    return true;
}

export function isDbConnected() {
    return Boolean(db);
}

export async function closeDatabase() {
    if (mongoClient) {
        try { await mongoClient.close(); } catch {}
        mongoClient = null;
        db = null;
    }
}

async function ensurePersistentAuthSecret() {
    if (CONFIG.AUTH_SECRET_ENV) {
        cachedAuthSecret = CONFIG.AUTH_SECRET_ENV;
        return cachedAuthSecret;
    }
    if (!cols.systemConfig) {
        cachedAuthSecret = crypto.randomBytes(32).toString('hex');
        return cachedAuthSecret;
    }
    const existing = await cols.systemConfig.findOne({ _id: 'auth_secret' });
    if (existing?.value) {
        cachedAuthSecret = existing.value;
        return cachedAuthSecret;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    await cols.systemConfig.updateOne(
        { _id: 'auth_secret' },
        { $setOnInsert: { value: generated, createdAt: new Date() } },
        { upsert: true }
    );
    const doc = await cols.systemConfig.findOne({ _id: 'auth_secret' });
    cachedAuthSecret = doc?.value || generated;
    return cachedAuthSecret;
}

export function getAuthSecret() {
    if (CONFIG.AUTH_SECRET_ENV) return CONFIG.AUTH_SECRET_ENV;
    return cachedAuthSecret;
}

export async function getStorageTelemetry(force = false) {
    const now = Date.now();
    if (!force && cachedDbStats.data && now - cachedDbStats.fetchedAt < 120_000) {
        return cachedDbStats.data;
    }
    if (!db) return null;
    try {
        const stats = await db.command({ dbStats: 1, scale: 1048576 });
        const storageMb = Number((stats.storageSize || 0).toFixed(2));
        const indexMb = Number((stats.indexSize || 0).toFixed(2));
        const totalMb = Number((storageMb + indexMb).toFixed(2));
        const data = {
            storageMb,
            indexMb,
            totalMb,
            quotaMb: 512,
            percentUsed: Number(Math.min(100, (totalMb / 512) * 100).toFixed(1)),
            objects: stats.objects || 0
        };
        cachedDbStats = { data, fetchedAt: now };
        return data;
    } catch {
        return cachedDbStats.data;
    }
}

export async function recordActivityLog(tenantId, level, mod, msg, meta = null) {
    if (!cols.activityLogs) return null;
    const now = new Date();
    const ttlDays = level === 'info' ? 7 : 14;
    const doc = {
        tenantId,
        level,
        mod,
        msg: String(msg || '').slice(0, 380),
        ...(meta ? { meta } : {}),
        createdAt: now,
        expiresAt: addDays(now, ttlDays)
    };
    cols.activityLogs.insertOne(doc).catch(() => {});
    return doc;
}

export async function incrementDailyAnalytics(tenantId, timeZone, updates = {}) {
    if (!cols.analyticsDaily) return;
    const now = new Date();
    const { dayKey, hourKey } = getLocalDayAndHour(now, timeZone);
    const utcMidnight = new Date(`${dayKey}T00:00:00.000Z`);

    const inc = {};
    if (updates.inCount) {
        inc.inCount = updates.inCount;
        inc[`hours.${hourKey}`] = updates.inCount;
    }
    if (updates.aiOutCount) inc.aiOutCount = updates.aiOutCount;
    if (updates.ownerOutCount) inc.ownerOutCount = updates.ownerOutCount;
    if (updates.agentOutCount) inc.agentOutCount = updates.agentOutCount;
    if (updates.leadsCount) inc.leadsCount = updates.leadsCount;
    if (updates.errorCount) inc.errorCount = updates.errorCount;
    if (typeof updates.latencyMs === 'number' && updates.latencyMs >= 0) {
        inc.latSumMs = Math.round(updates.latencyMs);
        inc.latCount = 1;
    }
    if (updates.model) {
        const safeModel = String(updates.model).replace(/[.$]/g, '_');
        inc[`models.${safeModel}`] = 1;
    }

    const op = {
        $setOnInsert: {
            tenantId,
            date: utcMidnight,
            dayKey,
            expiresAt: addDays(utcMidnight, 365)
        }
    };
    if (Object.keys(inc).length > 0) op.$inc = inc;
    if (typeof updates.latencyMs === 'number') op.$max = { latMaxMs: Math.round(updates.latencyMs) };

    await cols.analyticsDaily.updateOne(
        { _id: `${tenantId}:${dayKey}` },
        op,
        { upsert: true }
    ).catch(() => {});
}

export async function purgeTenantData(tenantId) {
    if (!db) return;
    await Promise.all([
        cols.waAuth.deleteMany({ tenantId }),
        cols.messages.deleteMany({ tenantId }),
        cols.conversations.deleteMany({ tenantId }),
        cols.leads.deleteMany({ tenantId }),
        cols.analyticsDaily.deleteMany({ tenantId }),
        cols.activityLogs.deleteMany({ tenantId }),
        cols.users.deleteMany({ tenantId }),
        cols.tenants.deleteOne({ _id: tenantId })
    ]);
}
