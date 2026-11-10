import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { BoundedCacheStore, SlidingWindowLimiter } from './cache.mjs';
import { CONFIG } from './config.mjs';

const scryptAsync = promisify(crypto.scrypt);

// N=32768, r=8, p=1 (~32 MiB peak RAM) behind a 1-slot semaphore prevents Render 512MB OOM
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

let scryptQueue = Promise.resolve();
function runSerializedScrypt(password, salt, N = SCRYPT_N, r = SCRYPT_R, p = SCRYPT_P) {
    const task = scryptQueue.then(() =>
        scryptAsync(password, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: SCRYPT_MAXMEM })
    );
    scryptQueue = task.catch(() => {});
    return task;
}

// Constant pre-built dummy hash for timing-safe nonexistent user rejection
const DUMMY_SALT = Buffer.alloc(16, 7);
const DUMMY_HASH_PROMISE = crypto.scryptSync
    ? Promise.resolve(crypto.scryptSync('dummy_timing_guard_secret', DUMMY_SALT, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM }))
    : null;

export const USERNAME_REGEX = /^[a-z0-9._-]{3,32}$/;
export const CLIENT_COOKIE_NAME = 'wa_client_sess';
export const ADMIN_COOKIE_NAME = 'wa_admin_sess';
export const SESSION_TTL_SEC = 60 * 60 * 24 * 14; // 14 days persistent login

export const loginLimiter = new SlidingWindowLimiter(2500);
export const authStateCache = new BoundedCacheStore(45_000, 300);

export function normalizeUsername(raw) {
    if (typeof raw !== 'string') return '';
    return raw.trim().toLowerCase();
}

export function isValidUsername(norm) {
    return USERNAME_REGEX.test(norm);
}

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const derived = await runSerializedScrypt(String(password), salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${Buffer.from(derived).toString('base64')}`;
}

export async function verifyPassword(password, storedPhc) {
    if (!storedPhc || typeof storedPhc !== 'string') {
        await runDummyVerify(password);
        return false;
    }
    const parts = storedPhc.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
        await runDummyVerify(password);
        return false;
    }

    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4], 'base64');
    const storedKey = Buffer.from(parts[5], 'base64');

    if (!N || !r || !p || salt.length < 8 || storedKey.length < 16) {
        await runDummyVerify(password);
        return false;
    }

    const derived = Buffer.from(await runSerializedScrypt(String(password), salt, N, r, p));
    if (derived.length !== storedKey.length) return false;
    return crypto.timingSafeEqual(derived, storedKey);
}

export async function runDummyVerify(password) {
    try {
        await runSerializedScrypt(String(password || 'x'), DUMMY_SALT, SCRYPT_N, SCRYPT_R, SCRYPT_P);
        if (DUMMY_HASH_PROMISE) await DUMMY_HASH_PROMISE;
    } catch {}
}

export function verifyAdminSecret(providedSecret) {
    const expected = CONFIG.ADMIN_SECRET;
    if (!expected || typeof providedSecret !== 'string' || !providedSecret) return false;
    const hProvided = crypto.createHash('sha256').update(providedSecret).digest();
    const hExpected = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(hProvided, hExpected);
}

export function signSessionToken(payloadObj, secret) {
    const nowSec = Math.floor(Date.now() / 1000);
    const body = { ...payloadObj, iat: nowSec, exp: payloadObj.exp || nowSec + SESSION_TTL_SEC };
    const payloadB64 = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
    const sigB64 = crypto.createHmac('sha256', secret).update(`v1.${payloadB64}`).digest('base64url');
    return `v1.${payloadB64}.${sigB64}`;
}

export function verifySessionToken(token, secret) {
    if (!token || typeof token !== 'string' || !secret) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;

    const data = `v1.${parts[1]}`;
    const expectedSig = crypto.createHmac('sha256', secret).update(data).digest();
    let providedSig;
    try {
        providedSig = Buffer.from(parts[2], 'base64url');
    } catch {
        return null;
    }
    if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
        return null;
    }

    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (!payload || typeof payload.exp !== 'number') return null;
        if (Math.floor(Date.now() / 1000) >= payload.exp) return null;
        return payload;
    } catch {
        return null;
    }
}

export function parseCookies(cookieHeader) {
    const out = Object.create(null);
    if (!cookieHeader || typeof cookieHeader !== 'string') return out;
    const parts = cookieHeader.split(';');
    for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) continue;
        const name = part.slice(0, eqIdx).trim();
        const val = part.slice(eqIdx + 1).trim();
        if (name) {
            try {
                out[name] = decodeURIComponent(val);
            } catch {
                out[name] = val;
            }
        }
    }
    return out;
}

export function serializeCookie(name, value, maxAgeSec, isSecure) {
    const parts = [
        `${name}=${encodeURIComponent(value)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`
    ];
    if (isSecure) parts.push('Secure');
    return parts.join('; ');
}

export function isRequestSecure(req) {
    return req.secure || req.headers['x-forwarded-proto'] === 'https' || CONFIG.NODE_ENV === 'production';
}

export function csrfOriginGuard(req, res, next) {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    // External connector webhook (/api/chat) uses API secret instead of cookies
    if (req.path === '/api/chat') return next();

    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (origin && host) {
        try {
            const originHost = new URL(origin).host;
            if (originHost !== host) {
                return res.status(403).json({ error: 'Cross-origin request rejected' });
            }
        } catch {
            return res.status(403).json({ error: 'Invalid origin header' });
        }
    }
    next();
}
