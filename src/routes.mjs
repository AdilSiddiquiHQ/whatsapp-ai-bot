import crypto from 'node:crypto';
import express from 'express';
import { ObjectId } from 'mongodb';
import {
    ADMIN_PROMPT_TEMPLATES,
    BRAIN_LIMITS,
    CONFIG,
    WARMUP_PRESETS,
    createDefaultTenantConfig
} from './config.mjs';
import {
    cols,
    isDbConnected,
    getAuthSecret,
    getStorageTelemetry,
    purgeTenantData,
    addDays
} from './db.mjs';
import {
    CLIENT_COOKIE_NAME,
    ADMIN_COOKIE_NAME,
    SESSION_TTL_SEC,
    loginLimiter,
    authStateCache,
    normalizeUsername,
    isValidUsername,
    hashPassword,
    verifyPassword,
    runDummyVerify,
    verifyAdminSecret,
    signSessionToken,
    verifySessionToken,
    parseCookies,
    serializeCookie,
    isRequestSecure,
    csrfOriginGuard
} from './security.mjs';
import { eventBus } from './stream.mjs';
import {
    buildTenantSystemPrompt,
    compileClientKnowledgeDigest,
    estimateKnowledgeBudget,
    generateAIReply,
    getProviderAvailability
} from './ai-engine.mjs';
import { waManager, normalizeDigits, formatPhoneDisplay } from './whatsapp-manager.mjs';

export function createApiRouter() {
    const router = express.Router();
    router.use(csrfOriginGuard);

    // Health Endpoint (keep-alive + deploy monitor)
    router.get('/health', (req, res) => {
        const mem = process.memoryUsage();
        res.json({
            status: 'ok',
            storage: isDbConnected() ? 'mongodb' : 'unavailable',
            providers: getProviderAvailability(),
            activeSockets: waManager.getActiveSocketCount(),
            rssMb: Math.round(mem.rss / 1048576),
            heapMb: Math.round(mem.heapUsed / 1048576),
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString()
        });
    });

    // Require DB middleware for /api/* except /api/admin/status
    function requireDb(req, res, next) {
        if (!isDbConnected()) {
            return res.status(503).json({ error: 'Database not connected. Configure MONGODB_URI in environment.' });
        }
        next();
    }

    async function resolveClientAuth(req) {
        const secret = getAuthSecret();
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[CLIENT_COOKIE_NAME];
        if (!token || !secret) return null;

        const payload = verifySessionToken(token, secret);
        if (!payload || !payload.tid) return null;

        // Admin impersonation token check
        if (payload.imp && payload.role === 'super_admin') {
            const tenant = await cols.tenants.findOne({ _id: payload.tid });
            if (!tenant) return null;
            return {
                userId: 'super_admin',
                username: tenant.name || payload.tid,
                tenantId: payload.tid,
                role: 'super_admin',
                impersonating: true,
                tenant
            };
        }

        const cacheKey = `u:${payload.sub}`;
        let cached = authStateCache.get(cacheKey);
        if (!cached) {
            const [user, tenant] = await Promise.all([
                cols.users.findOne({ _id: payload.sub }),
                cols.tenants.findOne({ _id: payload.tid })
            ]);
            if (!user || !tenant) return null;
            cached = {
                tokenVersion: user.tokenVersion || 1,
                username: user.username,
                onboardingDone: Boolean(user.onboardingDone),
                tenantStatus: tenant.status
            };
            authStateCache.set(cacheKey, cached);
        }

        if ((payload.tv || 1) !== cached.tokenVersion) return null;
        if (cached.tenantStatus !== 'active') return { suspended: true, tenantId: payload.tid };

        const tenant = await cols.tenants.findOne({ _id: payload.tid });
        if (!tenant || tenant.status !== 'active') return { suspended: true, tenantId: payload.tid };

        return {
            userId: payload.sub,
            username: cached.username,
            tenantId: payload.tid,
            role: 'tenant',
            impersonating: false,
            onboardingDone: Boolean(cached.onboardingDone),
            tenant
        };
    }

    async function requireClient(req, res, next) {
        if (!isDbConnected()) {
            return res.status(503).json({ error: 'Database unavailable.' });
        }
        const scope = await resolveClientAuth(req);
        if (!scope) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (scope.suspended) {
            return res.status(403).json({ error: 'Workspace is suspended. Contact your agency administrator.', suspended: true });
        }
        req.scope = scope;
        next();
    }

    function resolveAdminAuth(req) {
        if (!CONFIG.ADMIN_SECRET) return false;
        const secret = getAuthSecret();
        if (!secret) return false;
        const cookies = parseCookies(req.headers.cookie);
        const token = cookies[ADMIN_COOKIE_NAME];
        const payload = verifySessionToken(token, secret);
        return Boolean(payload && payload.role === 'super_admin' && payload.sub === 'admin');
    }

    function requireAdmin(req, res, next) {
        if (!CONFIG.ADMIN_SECRET) {
            return res.status(503).json({ error: 'ADMIN_SECRET environment variable is not configured on server.' });
        }
        if (!resolveAdminAuth(req)) {
            return res.status(401).json({ error: 'Admin authorization required' });
        }
        next();
    }

    // =========================================================================
    // CLIENT AUTH ROUTES
    // =========================================================================
    router.post('/api/auth/login', requireDb, async (req, res) => {
        const norm = normalizeUsername(req.body?.username);
        const password = String(req.body?.password || '');
        const ip = req.ip || 'unknown';

        if (!loginLimiter.consume(`login_ip:${ip}`, 20, 10 * 60_000).allowed) {
            return res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' });
        }
        if (!isValidUsername(norm) || password.length < 3 || password.length > 128) {
            await runDummyVerify(password);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const user = await cols.users.findOne({ usernameNormalized: norm });
        if (!user) {
            await runDummyVerify(password);
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
            return res.status(429).json({ error: 'Account temporarily locked due to failed attempts. Try later.' });
        }

        const valid = await verifyPassword(password, user.passwordHash);
        if (!valid) {
            const fails = (user.failedLogins || 0) + 1;
            const lock = fails >= 8 ? new Date(Date.now() + 10 * 60_000) : null;
            await cols.users.updateOne({ _id: user._id }, { $set: { failedLogins: fails, ...(lock ? { lockedUntil: lock } : {}) } });
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const tenant = await cols.tenants.findOne({ _id: user.tenantId });
        if (!tenant || tenant.status !== 'active') {
            return res.status(403).json({ error: 'Workspace paused or inactive. Contact your agency.' });
        }

        await cols.users.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
        authStateCache.del(`u:${user._id}`);

        const token = signSessionToken(
            { sub: user._id, tid: user.tenantId, role: 'tenant', tv: user.tokenVersion || 1 },
            getAuthSecret()
        );

        res.setHeader('Set-Cookie', serializeCookie(CLIENT_COOKIE_NAME, token, SESSION_TTL_SEC, isRequestSecure(req)));
        return res.json({
            ok: true,
            user: {
                username: user.username,
                tenantId: user.tenantId,
                businessName: tenant.botConfig?.businessName || tenant.name,
                onboardingDone: Boolean(user.onboardingDone)
            }
        });
    });

    router.post('/api/auth/logout', (req, res) => {
        res.setHeader('Set-Cookie', serializeCookie(CLIENT_COOKIE_NAME, '', 0, isRequestSecure(req)));
        res.json({ ok: true });
    });

    router.get('/api/auth/me', async (req, res) => {
        if (!isDbConnected()) {
            return res.status(503).json({ authenticated: false, error: 'Database unavailable' });
        }
        const scope = await resolveClientAuth(req);
        if (!scope) return res.json({ authenticated: false });
        if (scope.suspended) return res.json({ authenticated: false, suspended: true });

        const snap = waManager.getStatusSnapshot(scope.tenantId);
        return res.json({
            authenticated: true,
            user: {
                username: scope.username,
                tenantId: scope.tenantId,
                role: scope.role,
                impersonating: scope.impersonating,
                onboardingDone: Boolean(scope.onboardingDone || snap.status === 'open' || scope.tenant.waStatus === 'open'),
                allowClientBrainEdit: scope.tenant.aiConfig?.allowClientBrainEdit !== false,
                businessName: scope.tenant.botConfig?.businessName || scope.tenant.name,
                industry: scope.tenant.industry || scope.tenant.botConfig?.industry || '',
                waPhone: scope.tenant.waPhone || '',
                waPushName: scope.tenant.waPushName || '',
                waStatus: snap.status,
                qrDataUrl: snap.qrDataUrl,
                pairingCode: snap.pairingCode,
                circuitReason: snap.circuitReason,
                aiEnabled: Boolean(scope.tenant.safety?.aiEnabled)
            }
        });
    });

    router.post('/api/account/password', requireClient, async (req, res) => {
        if (req.scope.impersonating) {
            return res.status(403).json({ error: 'Cannot change password during admin impersonation.' });
        }
        const current = String(req.body?.currentPassword || '');
        const nextPass = String(req.body?.newPassword || '');
        if (nextPass.length < 5 || nextPass.length > 128) {
            return res.status(400).json({ error: 'New password must be 5 to 128 characters.' });
        }

        const user = await cols.users.findOne({ _id: req.scope.userId });
        if (!user || !(await verifyPassword(current, user.passwordHash))) {
            return res.status(400).json({ error: 'Current password is incorrect.' });
        }

        const nextHash = await hashPassword(nextPass);
        const nextTv = (user.tokenVersion || 1) + 1;
        await cols.users.updateOne({ _id: user._id }, { $set: { passwordHash: nextHash, tokenVersion: nextTv } });
        authStateCache.del(`u:${user._id}`);

        const token = signSessionToken({ sub: user._id, tid: user.tenantId, role: 'tenant', tv: nextTv }, getAuthSecret());
        res.setHeader('Set-Cookie', serializeCookie(CLIENT_COOKIE_NAME, token, SESSION_TTL_SEC, isRequestSecure(req)));
        res.json({ ok: true });
    });

    router.post('/api/onboarding/complete', requireClient, async (req, res) => {
        const snap = waManager.getStatusSnapshot(req.scope.tenantId);
        const linked = snap.status === 'open' || req.scope.tenant.waStatus === 'open';
        if (!linked && !req.scope.impersonating) {
            return res.status(403).json({ error: 'Link WhatsApp first before entering your workspace.' });
        }
        if (!req.scope.impersonating && linked) {
            await cols.users.updateOne({ _id: req.scope.userId }, { $set: { onboardingDone: true } });
            authStateCache.del(`u:${req.scope.userId}`);
        }
        res.json({ ok: true });
    });

    // =========================================================================
    // AGENCY SUPER-ADMIN ROUTES (/api/admin/* — Strictly guarded by ADMIN_SECRET ENV)
    // =========================================================================
    router.get('/api/admin/status', (req, res) => {
        res.json({
            configured: Boolean(CONFIG.ADMIN_SECRET),
            authenticated: resolveAdminAuth(req)
        });
    });

    router.post('/api/admin/login', (req, res) => {
        if (!CONFIG.ADMIN_SECRET) {
            return res.status(503).json({ error: 'ADMIN_SECRET environment variable is not set on server.' });
        }
        const ip = req.ip || 'unknown';
        if (!loginLimiter.consume(`admin_ip:${ip}`, 12, 10 * 60_000).allowed) {
            return res.status(429).json({ error: 'Too many admin attempts. Wait a few minutes.' });
        }
        const secretInput = String(req.body?.secret || '');
        if (!verifyAdminSecret(secretInput)) {
            return res.status(401).json({ error: 'Invalid admin key.' });
        }

        const token = signSessionToken({ sub: 'admin', role: 'super_admin' }, getAuthSecret());
        res.setHeader('Set-Cookie', serializeCookie(ADMIN_COOKIE_NAME, token, SESSION_TTL_SEC, isRequestSecure(req)));
        res.json({ ok: true });
    });

    router.post('/api/admin/logout', (req, res) => {
        res.setHeader('Set-Cookie', serializeCookie(ADMIN_COOKIE_NAME, '', 0, isRequestSecure(req)));
        res.json({ ok: true });
    });

    router.get('/api/admin/overview', requireDb, requireAdmin, async (req, res) => {
        const [tenants, users, statsRows, leadCounts, handoffCounts, recentAlerts, dbStats] = await Promise.all([
            cols.tenants.find({}).sort({ createdAt: -1 }).toArray(),
            cols.users.find({}, { projection: { passwordHash: 0 } }).toArray(),
            cols.analyticsDaily.aggregate([
                { $group: { _id: '$tenantId', msgsIn: { $sum: '$inCount' }, msgsOut: { $sum: '$aiOutCount' } } }
            ]).toArray(),
            cols.leads.aggregate([
                { $group: { _id: '$tenantId', count: { $sum: 1 } } }
            ]).toArray(),
            cols.conversations.aggregate([
                { $match: { isSandbox: false, aiStatus: 'human_needed' } },
                { $group: { _id: '$tenantId', count: { $sum: 1 } } }
            ]).toArray(),
            cols.activityLogs
                .find({ level: { $in: ['warn', 'err'] } })
                .sort({ createdAt: -1 })
                .limit(25)
                .toArray(),
            getStorageTelemetry()
        ]);

        const userByTenant = new Map(users.map((u) => [u.tenantId, u]));
        const statsByTenant = new Map(statsRows.map((s) => [s._id, s]));
        const leadsByTenant = new Map(leadCounts.map((l) => [l._id, l.count]));
        const handoffByTenant = new Map(handoffCounts.map((h) => [h._id, h.count]));

        const mem = process.memoryUsage();
        const clientList = tenants.map((t) => {
            const u = userByTenant.get(t._id);
            const st = statsByTenant.get(t._id);
            const rtSnap = waManager.getStatusSnapshot(t._id);
            const budget = estimateKnowledgeBudget(t);
            return {
                id: t._id,
                name: t.name,
                industry: t.industry || t.botConfig?.industry || 'Service & Retail Business',
                agencySystemPrompt: t.agencySystemPrompt || t.botConfig?.extraInstructions || '',
                aiConfig: t.aiConfig || { primaryModel: 'auto', temperature: 0.42, maxOutputTokens: 460, allowClientBrainEdit: true },
                safety: {
                    aiEnabled: t.safety?.aiEnabled !== false,
                    warmupTier: t.safety?.warmupTier || 'warming',
                    maxDailyOut: t.safety?.maxDailyOut || 90,
                    maxHourlyOut: t.safety?.maxHourlyOut || 18,
                    voiceNotesEnabled: t.safety?.voiceNotesEnabled !== false,
                    imageVisionEnabled: t.safety?.imageVisionEnabled !== false
                },
                username: u?.username || '',
                onboardingDone: Boolean(u?.onboardingDone || rtSnap.status === 'open'),
                status: t.status,
                waStatus: rtSnap.status,
                circuitReason: rtSnap.circuitReason || '',
                waPhone: t.waPhone || '',
                waPushName: t.waPushName || '',
                msgsIn: st?.msgsIn || 0,
                msgsAiOut: st?.msgsOut || 0,
                leadsCount: leadsByTenant.get(t._id) || 0,
                needsHumanCount: handoffByTenant.get(t._id) || 0,
                digestTokens: budget.estimatedTokens,
                lastLoginAt: u?.lastLoginAt || null,
                createdAt: t.createdAt
            };
        });

        const tenantNameById = new Map(tenants.map((t) => [t._id, t.name]));

        res.json({
            system: {
                rssMb: Math.round(mem.rss / 1048576),
                heapMb: Math.round(mem.heapUsed / 1048576),
                maxRamMb: 512,
                activeSockets: waManager.getActiveSocketCount(),
                maxSockets: CONFIG.MAX_ACTIVE_WA_SESSIONS,
                providers: getProviderAvailability(),
                dbStorage: dbStats,
                uptimeSec: Math.floor(process.uptime())
            },
            promptTemplates: ADMIN_PROMPT_TEMPLATES,
            systemAlerts: recentAlerts.map((a) => ({
                ...a,
                tenantName: tenantNameById.get(a.tenantId) || a.tenantId
            })),
            tenants: clientList
        });
    });

    router.post('/api/admin/tenants', requireDb, requireAdmin, async (req, res) => {
        const usernameRaw = String(req.body?.username || '').trim();
        const usernameNormalized = normalizeUsername(usernameRaw);
        const password = String(req.body?.password || '');
        const businessName = String(req.body?.businessName || usernameRaw).trim().slice(0, 80);
        const industry = String(req.body?.industry || 'Service & Retail Business').trim().slice(0, 80);
        const agencySystemPrompt = String(req.body?.agencySystemPrompt || req.body?.systemPrompt || '').trim();
        const cloneFromTenantId = String(req.body?.cloneFromTenantId || '').trim();
        const primaryModel = String(req.body?.primaryModel || 'auto');

        if (!isValidUsername(usernameNormalized)) {
            return res.status(400).json({ error: 'Username must be 3-32 chars (a-z, 0-9, dot, underscore, hyphen).' });
        }
        if (password.length < 4 || password.length > 128) {
            return res.status(400).json({ error: 'Password must be 4-128 characters.' });
        }

        const existing = await cols.users.findOne({ usernameNormalized });
        if (existing) {
            return res.status(409).json({ error: `Username "${usernameNormalized}" already exists.` });
        }

        const tenantId = `t_${crypto.randomBytes(6).toString('hex')}`;
        const userId = `u_${crypto.randomBytes(6).toString('hex')}`;
        const now = new Date();
        let defaults = createDefaultTenantConfig(businessName, {
            industry,
            agencySystemPrompt,
            aiConfig: { primaryModel }
        });

        // Optional: clone prompt, catalog, FAQs & safety presets from an existing client (zero chat/lead/auth copy!)
        if (cloneFromTenantId) {
            const src = await cols.tenants.findOne({ _id: cloneFromTenantId });
            if (src) {
                defaults.industry = industry || src.industry || defaults.industry;
                defaults.agencySystemPrompt = agencySystemPrompt || src.agencySystemPrompt || defaults.agencySystemPrompt;
                defaults.aiConfig = { ...(src.aiConfig || defaults.aiConfig), primaryModel: primaryModel || src.aiConfig?.primaryModel || 'auto' };
                defaults.botConfig = {
                    ...defaults.botConfig,
                    ...(src.botConfig || {}),
                    businessName
                };
                defaults.safety = { ...(src.safety || defaults.safety) };
                defaults.quickReplies = Array.isArray(src.quickReplies) ? [...src.quickReplies] : defaults.quickReplies;
            }
        }

        if (req.body?.maxDailyOut !== undefined) {
            defaults.safety.maxDailyOut = Math.max(5, Math.min(1000, Number(req.body.maxDailyOut) || 90));
        }

        const tenantDoc = {
            _id: tenantId,
            name: businessName,
            status: 'active',
            waStatus: 'disconnected',
            waPhone: '',
            waPushName: '',
            ...defaults,
            channelsFuture: { instagram: 'planned_phase_2', facebook: 'planned_phase_2' },
            createdAt: now,
            updatedAt: now
        };

        const userDoc = {
            _id: userId,
            username: usernameRaw,
            usernameNormalized,
            passwordHash: await hashPassword(password),
            role: 'tenant',
            tenantId,
            tokenVersion: 1,
            failedLogins: 0,
            onboardingDone: false,
            createdAt: now
        };

        await cols.tenants.insertOne(tenantDoc);
        await cols.users.insertOne(userDoc);

        res.json({
            ok: true,
            tenant: {
                id: tenantId,
                name: businessName,
                username: usernameRaw,
                status: 'active'
            }
        });
    });

    router.patch('/api/admin/tenants/:id', requireDb, requireAdmin, async (req, res) => {
        const tenantId = req.params.id;
        const tenant = await cols.tenants.findOne({ _id: tenantId });
        if (!tenant) return res.status(404).json({ error: 'Client not found.' });

        const updates = { updatedAt: new Date() };
        if (req.body?.status === 'active' || req.body?.status === 'suspended') {
            updates.status = req.body.status;
        }
        if (typeof req.body?.businessName === 'string' && req.body.businessName.trim()) {
            const nextName = req.body.businessName.trim().slice(0, 80);
            updates.name = nextName;
            updates['botConfig.businessName'] = nextName;
        }
        if (typeof req.body?.industry === 'string') {
            updates.industry = req.body.industry.trim().slice(0, 80);
        }
        if (typeof req.body?.agencySystemPrompt === 'string') {
            updates.agencySystemPrompt = req.body.agencySystemPrompt.trim().slice(0, BRAIN_LIMITS.maxAgencyPromptChars);
        }

        const aiCfg = req.body?.aiConfig;
        if (aiCfg && typeof aiCfg === 'object') {
            if (typeof aiCfg.primaryModel === 'string') updates['aiConfig.primaryModel'] = aiCfg.primaryModel.slice(0, 60);
            if (aiCfg.temperature !== undefined) {
                updates['aiConfig.temperature'] = Math.min(0.75, Math.max(0.1, Number(aiCfg.temperature) || 0.42));
            }
            if (aiCfg.maxOutputTokens !== undefined) {
                updates['aiConfig.maxOutputTokens'] = Math.min(750, Math.max(180, Number(aiCfg.maxOutputTokens) || 460));
            }
            if (aiCfg.allowClientBrainEdit !== undefined) {
                updates['aiConfig.allowClientBrainEdit'] = Boolean(aiCfg.allowClientBrainEdit);
            }
        }

        const saf = req.body?.safety || {};
        const maxDailyRaw = req.body?.maxDailyOut ?? saf.maxDailyOut;
        if (maxDailyRaw !== undefined) {
            updates['safety.maxDailyOut'] = Math.max(5, Math.min(1000, Number(maxDailyRaw) || 90));
        }
        if (saf.maxHourlyOut !== undefined) {
            updates['safety.maxHourlyOut'] = Math.max(2, Math.min(100, Number(saf.maxHourlyOut) || 18));
        }
        if (saf.aiEnabled !== undefined) updates['safety.aiEnabled'] = Boolean(saf.aiEnabled);
        if (saf.voiceNotesEnabled !== undefined) updates['safety.voiceNotesEnabled'] = Boolean(saf.voiceNotesEnabled);
        if (saf.imageVisionEnabled !== undefined) updates['safety.imageVisionEnabled'] = Boolean(saf.imageVisionEnabled);

        await cols.tenants.updateOne({ _id: tenantId }, { $set: updates });

        if (typeof req.body?.onboardingDone === 'boolean') {
            await cols.users.updateMany({ tenantId }, { $set: { onboardingDone: req.body.onboardingDone } });
        }

        // Evict auth cache for this tenant's users immediately
        const tenantUsers = await cols.users.find({ tenantId }).toArray();
        for (const u of tenantUsers) authStateCache.del(`u:${u._id}`);

        if (updates.status === 'suspended') {
            await waManager.disconnectTenant(tenantId, { preserveAuth: true, quiet: true });
        }

        if (req.body?.clearCircuitBreaker) {
            const rt = waManager.getRuntime(tenantId);
            rt.circuitBreakerUntil = 0;
            rt.circuitReason = '';
            if (rt.sock) rt.status = 'open';
            eventBus.emitTenant(tenantId, 'wa_status', waManager.getStatusSnapshot(tenantId));
        }

        res.json({ ok: true });
    });

    router.post('/api/admin/tenants/:id/wa', requireDb, requireAdmin, async (req, res) => {
        const tenantId = req.params.id;
        const action = String(req.body?.action || '');
        try {
            if (action === 'connect') {
                await waManager.connectTenant(tenantId, { forceFresh: true });
            } else if (action === 'disconnect') {
                await waManager.disconnectTenant(tenantId, { preserveAuth: true });
            } else if (action === 'unlink') {
                await waManager.disconnectTenant(tenantId, { preserveAuth: false });
            } else {
                return res.status(400).json({ error: 'Invalid WA action.' });
            }
            res.json({ ok: true, status: waManager.getStatusSnapshot(tenantId) });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/admin/tenants/:id/test-prompt', requireDb, requireAdmin, async (req, res) => {
        const tenant = await cols.tenants.findOne({ _id: req.params.id });
        if (!tenant) return res.status(404).json({ error: 'Client not found.' });

        const text = String(req.body?.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Enter a test prompt message.' });

        // Allow overriding prompt live before saving!
        const draftTenant = {
            ...tenant,
            agencySystemPrompt: typeof req.body?.agencySystemPrompt === 'string'
                ? req.body.agencySystemPrompt
                : tenant.agencySystemPrompt,
            aiConfig: req.body?.aiConfig ? { ...(tenant.aiConfig || {}), ...req.body.aiConfig } : tenant.aiConfig
        };

        const systemPrompt = buildTenantSystemPrompt(draftTenant, { displayName: 'Test Buyer', phoneNumber: '+91 90000 00000' }, text);
        const aiRes = await generateAIReply({
            systemPrompt,
            contextTurns: [],
            userText: text,
            aiConfig: draftTenant.aiConfig
        });

        res.json({
            reply: aiRes.text,
            model: aiRes.model,
            latencyMs: aiRes.latencyMs,
            handoffData: aiRes.handoffData,
            promptChars: systemPrompt.length
        });
    });

    router.post('/api/admin/tenants/:id/reset-password', requireDb, requireAdmin, async (req, res) => {
        const tenantId = req.params.id;
        const nextPassword = String(req.body?.password || '');
        if (nextPassword.length < 4 || nextPassword.length > 128) {
            return res.status(400).json({ error: 'Password must be 4-128 characters.' });
        }
        const user = await cols.users.findOne({ tenantId });
        if (!user) return res.status(404).json({ error: 'Client user not found.' });

        const nextHash = await hashPassword(nextPassword);
        await cols.users.updateOne({ _id: user._id }, { $set: { passwordHash: nextHash }, $inc: { tokenVersion: 1 } });
        authStateCache.del(`u:${user._id}`);
        res.json({ ok: true });
    });

    router.post('/api/admin/impersonate/:id', requireDb, requireAdmin, async (req, res) => {
        const tenant = await cols.tenants.findOne({ _id: req.params.id });
        if (!tenant) return res.status(404).json({ error: 'Workspace not found.' });

        const token = signSessionToken(
            { sub: 'super_admin', tid: tenant._id, role: 'super_admin', imp: true },
            getAuthSecret()
        );
        res.setHeader('Set-Cookie', serializeCookie(CLIENT_COOKIE_NAME, token, 3600 * 4, isRequestSecure(req)));
        res.json({ ok: true, redirectTo: '/' });
    });

    router.post('/api/admin/exit-impersonate', (req, res) => {
        res.setHeader('Set-Cookie', serializeCookie(CLIENT_COOKIE_NAME, '', 0, isRequestSecure(req)));
        res.json({ ok: true, redirectTo: '/admin' });
    });

    router.delete('/api/admin/tenants/:id', requireDb, requireAdmin, async (req, res) => {
        const tenantId = req.params.id;
        const tenantUsers = await cols.users.find({ tenantId }).toArray();
        for (const u of tenantUsers) authStateCache.del(`u:${u._id}`);

        await waManager.disconnectTenant(tenantId, { preserveAuth: false, quiet: true });
        await purgeTenantData(tenantId);
        res.json({ ok: true });
    });

    // =========================================================================
    // CLIENT WORKSPACE ROUTES (/api/* — Strictly Tenant Scoped)
    // =========================================================================
    router.get('/api/stream', requireClient, (req, res) => {
        eventBus.subscribeTenant(req, res, req.scope.tenantId);
    });

    router.post('/api/ping', requireClient, (req, res) => {
        res.json({ ok: true, ts: Date.now() });
    });

    router.get('/api/dashboard', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const tenant = req.scope.tenant;
        const days = Math.min(30, Math.max(7, Number(req.query.days) || 7));

        const now = new Date();
        const startDate = addDays(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), -(days - 1));

        const [dailyDocs, activeConvCount, pausedCount, totalLeads] = await Promise.all([
            cols.analyticsDaily.find({ tenantId, date: { $gte: startDate } }).sort({ date: 1 }).toArray(),
            cols.conversations.countDocuments({ tenantId, isSandbox: false }),
            cols.conversations.countDocuments({ tenantId, isSandbox: false, pausedUntil: { $gt: now } }),
            cols.leads.countDocuments({ tenantId })
        ]);

        const byDay = new Map(dailyDocs.map((d) => [d.dayKey, d]));
        const series = [];
        const hourlyTotals = Array(24).fill(0);

        let totalIn = 0;
        let totalAiOut = 0;
        let totalHumanOut = 0;
        let totalLatSum = 0;
        let totalLatCount = 0;

        for (let i = 0; i < days; i++) {
            const dt = addDays(startDate, i);
            const key = dt.toISOString().slice(0, 10);
            const d = byDay.get(key) || {};
            const inC = d.inCount || 0;
            const aiC = d.aiOutCount || 0;
            const humC = (d.ownerOutCount || 0) + (d.agentOutCount || 0);

            totalIn += inC;
            totalAiOut += aiC;
            totalHumanOut += humC;
            totalLatSum += d.latSumMs || 0;
            totalLatCount += d.latCount || 0;

            if (d.hours) {
                for (let h = 0; h < 24; h++) {
                    hourlyTotals[h] += Number(d.hours[String(h)] || 0);
                }
            }

            series.push({
                date: key,
                label: dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
                inbound: inC,
                aiOut: aiC,
                humanOut: humC,
                leads: d.leadsCount || 0
            });
        }

        const totalReplies = totalAiOut + totalHumanOut;
        const resolutionRate = totalReplies > 0 ? Math.round((totalAiOut / totalReplies) * 100) : 100;
        const avgLatencyMs = totalLatCount > 0 ? Math.round(totalLatSum / totalLatCount) : 0;

        const todayKey = now.toISOString().slice(0, 10);
        const todayDoc = byDay.get(todayKey);

        res.json({
            kpis: {
                totalIn,
                totalAiOut,
                totalHumanOut,
                totalLeads,
                avgLatencyMs,
                resolutionRate,
                activeChats: activeConvCount,
                pausedChats: pausedCount
            },
            quota: {
                usedToday: todayDoc?.aiOutCount || 0,
                maxDailyOut: tenant.safety?.maxDailyOut || 90,
                warmupTier: tenant.safety?.warmupTier || 'warming'
            },
            series,
            hourlyTotals,
            wa: {
                ...waManager.getStatusSnapshot(tenantId),
                waPhone: tenant.waPhone || '',
                waPushName: tenant.waPushName || '',
                aiEnabled: Boolean(tenant.safety?.aiEnabled)
            }
        });
    });

    // Inbox & Conversations
    router.get('/api/conversations', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const filter = String(req.query.filter || 'all');
        const q = String(req.query.q || '').trim().toLowerCase();

        const query = { tenantId, isSandbox: false };
        const now = new Date();
        if (filter === 'paused') {
            query.pausedUntil = { $gt: now };
        } else if (filter === 'human_needed') {
            query.aiStatus = 'human_needed';
        } else if (filter === 'active') {
            query.$and = [{ optedOut: { $ne: true } }, { $or: [{ pausedUntil: null }, { pausedUntil: { $lte: now } }] }];
        } else if (filter === 'opted_out') {
            query.optedOut = true;
        }

        if (q) {
            const safeEsc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            query.$or = [
                { displayName: { $regex: safeEsc, $options: 'i' } },
                { phoneNumber: { $regex: safeEsc, $options: 'i' } },
                { lastMessagePreview: { $regex: safeEsc, $options: 'i' } }
            ];
        }

        const threads = await cols.conversations
            .find(query, { projection: { contextTurns: 0 } })
            .sort({ lastMessageAt: -1 })
            .limit(80)
            .toArray();

        res.json({ conversations: threads });
    });

    router.get('/api/conversations/:id/messages', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const conv = await cols.conversations.findOne({ _id: req.params.id, tenantId });
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        await cols.conversations.updateOne({ _id: conv._id }, { $set: { unreadCount: 0 } }).catch(() => {});

        const [messages, lead] = await Promise.all([
            cols.messages
                .find({ conversationId: conv._id, tenantId })
                .sort({ createdAt: -1 })
                .limit(80)
                .toArray(),
            cols.leads.findOne({ tenantId, contactRef: conv.externalRef })
        ]);

        res.json({
            conversation: { ...conv, contextTurns: undefined, unreadCount: 0 },
            messages: messages.reverse(),
            lead: lead || null
        });
    });

    router.post('/api/conversations/:id/reply', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const text = String(req.body?.text || '').trim();
        if (!text || text.length > 2500) {
            return res.status(400).json({ error: 'Message text must be 1 to 2500 characters.' });
        }

        const conv = await cols.conversations.findOne({ _id: req.params.id, tenantId });
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        try {
            const sent = await waManager.sendDashboardManualReply(tenantId, conv, text);
            res.json({ ok: true, message: sent });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.patch('/api/conversations/:id', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const conv = await cols.conversations.findOne({ _id: req.params.id, tenantId });
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        const rt = waManager.getRuntime(tenantId);
        const sets = {};
        const now = new Date();

        if (req.body?.action === 'pause') {
            const mins = Math.max(5, Math.min(1440, Number(req.body?.minutes || 60)));
            const pausedUntil = new Date(now.getTime() + mins * 60_000);
            sets.aiStatus = 'paused';
            sets.pausedUntil = pausedUntil;
            sets.pauseReason = 'manual_dashboard';
            rt.pausedUntilCache.set(conv.externalRef, { pausedAt: now.getTime(), pausedUntil: pausedUntil.getTime() }, mins * 60_000);
            rt.debouncer?.cleanup(conv.externalRef);
        } else if (req.body?.action === 'resume') {
            sets.aiStatus = 'active';
            sets.pausedUntil = null;
            sets.pauseReason = '';
            sets.optedOut = false;
            rt.pausedUntilCache.del(conv.externalRef);
        } else if (req.body?.action === 'block') {
            const ref = normalizeDigits(conv.externalRef) || conv.externalRef;
            await cols.tenants.updateOne(
                { _id: tenantId },
                { $addToSet: { blacklist: { ref, label: conv.displayName || conv.phoneNumber } } }
            );
            sets.aiStatus = 'manual_resolved';
        }

        if (typeof req.body?.stage === 'string') sets.stage = req.body.stage.slice(0, 32);
        if (typeof req.body?.notes === 'string') sets.notes = req.body.notes.slice(0, 600);
        if (Array.isArray(req.body?.tags)) {
            sets.tags = req.body.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 8);
        }

        if (Object.keys(sets).length > 0) {
            await cols.conversations.updateOne({ _id: conv._id }, { $set: sets });
        }
        const updated = await cols.conversations.findOne({ _id: conv._id }, { projection: { contextTurns: 0 } });
        res.json({ ok: true, conversation: updated });
    });

    router.delete('/api/conversations/:id', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        await Promise.all([
            cols.conversations.deleteOne({ _id: req.params.id, tenantId }),
            cols.messages.deleteMany({ conversationId: req.params.id, tenantId })
        ]);
        res.json({ ok: true });
    });

    // Live Sandbox Web Preview (Isolated: isSandbox: true, TTL 24h)
    router.post('/api/sandbox/chat', requireClient, async (req, res) => {
        const tenant = req.scope.tenant;
        const tenantId = req.scope.tenantId;
        const text = String(req.body?.text || '').trim();
        if (!text || text.length > 2000) {
            return res.status(400).json({ error: 'Enter a test message.' });
        }

        const convId = `${tenantId}:sandbox:preview`;
        const existing = await cols.conversations.findOne({ _id: convId });
        const contextTurns = existing?.contextTurns || [];

        const systemPrompt = buildTenantSystemPrompt(
            tenant,
            { displayName: 'Preview Customer', phoneNumber: '+91 90000 00000' },
            text
        );
        const aiRes = await generateAIReply({
            systemPrompt,
            contextTurns,
            userText: text,
            aiConfig: tenant.aiConfig
        });

        const now = new Date();
        await cols.conversations.updateOne(
            { _id: convId },
            {
                $setOnInsert: {
                    _id: convId,
                    tenantId,
                    channel: 'sandbox',
                    externalRef: 'preview',
                    isSandbox: true,
                    createdAt: now
                },
                $set: {
                    lastMessageAt: now,
                    expiresAt: addDays(now, 1)
                },
                $push: {
                    contextTurns: {
                        $each: [
                            { role: 'user', text: text.slice(0, 600) },
                            { role: 'assistant', text: aiRes.text.slice(0, 600) }
                        ],
                        $slice: -8
                    }
                }
            },
            { upsert: true }
        );

        res.json({
            reply: aiRes.text,
            model: aiRes.model,
            latencyMs: aiRes.latencyMs,
            leadData: aiRes.leadData,
            handoffData: aiRes.handoffData
        });
    });

    router.delete('/api/sandbox/reset', requireClient, async (req, res) => {
        await cols.conversations.deleteOne({ _id: `${req.scope.tenantId}:sandbox:preview` });
        res.json({ ok: true });
    });

    // Business Brain Config (Client self-serve Offers/Catalog/FAQs/Announcements under hard token limits!)
    router.get('/api/brain', requireClient, (req, res) => {
        const tenant = req.scope.tenant;
        res.json({
            botConfig: tenant.botConfig,
            quickReplies: tenant.quickReplies || [],
            industry: tenant.industry || tenant.botConfig?.industry || 'Service & Retail Business',
            allowClientBrainEdit: tenant.aiConfig?.allowClientBrainEdit !== false,
            limits: BRAIN_LIMITS,
            budget: estimateKnowledgeBudget(tenant)
        });
    });

    router.put('/api/brain', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const tenant = req.scope.tenant;
        if (tenant.aiConfig?.allowClientBrainEdit === false && !req.scope.impersonating) {
            return res.status(403).json({ error: 'Knowledge editing is managed by your agency administrator.' });
        }

        const incoming = req.body?.botConfig || {};
        const quickReplies = Array.isArray(req.body?.quickReplies)
            ? req.body.quickReplies
                .filter((q) => q && q.title && q.body)
                .slice(0, BRAIN_LIMITS.maxQuickReplies)
                .map((q, idx) => ({
                    id: String(q.id || `qr_${idx}`),
                    title: String(q.title).trim().slice(0, 40),
                    body: String(q.body).trim().slice(0, 400)
                }))
            : tenant.quickReplies;

        // Strictly enforce slot & character caps so client cannot bloat prompts or free API quotas
        const cleanConfig = {
            businessName: String(incoming.businessName || tenant.botConfig?.businessName || tenant.name || '').trim().slice(0, 80),
            city: String(incoming.city ?? tenant.botConfig?.city ?? '').trim().slice(0, 60),
            currency: String(incoming.currency || tenant.botConfig?.currency || 'INR').trim().slice(0, 12),
            language: String(incoming.language || tenant.botConfig?.language || 'Auto (Match Customer)').trim().slice(0, 40),
            tone: String(incoming.tone || tenant.botConfig?.tone || 'Natural & Helpful').trim().slice(0, 40),
            emojiLevel: ['none', 'minimal', 'natural'].includes(incoming.emojiLevel) ? incoming.emojiLevel : 'minimal',
            announcement: String(incoming.announcement || '').trim().slice(0, BRAIN_LIMITS.maxAnnouncementChars),
            offers: Array.isArray(incoming.offers)
                ? incoming.offers.slice(0, BRAIN_LIMITS.maxOffers).map((o) => ({
                    title: String(o.title || '').trim().slice(0, 60),
                    deal: String(o.deal || '').trim().slice(0, 100),
                    code: String(o.code || '').trim().slice(0, 32),
                    active: o.active !== false
                })).filter((o) => o.title && o.deal)
                : [],
            products: Array.isArray(incoming.products)
                ? incoming.products.slice(0, BRAIN_LIMITS.maxProducts).map((p) => ({
                    name: String(p.name || '').trim().slice(0, 70),
                    price: String(p.price || '').trim().slice(0, 35),
                    note: String(p.note || '').trim().slice(0, 120),
                    active: p.active !== false
                })).filter((p) => p.name)
                : [],
            faqs: Array.isArray(incoming.faqs)
                ? incoming.faqs.slice(0, BRAIN_LIMITS.maxFaqs).map((f) => ({
                    q: String(f.q || '').trim().slice(0, 140),
                    a: String(f.a || '').trim().slice(0, 360)
                })).filter((f) => f.q && f.a)
                : [],
            customRules: Array.isArray(incoming.customRules)
                ? incoming.customRules.map((r) => String(r).trim().slice(0, 140)).filter(Boolean).slice(0, BRAIN_LIMITS.maxRules)
                : [],
            leadFields: ['name', 'intent', 'budget'],
            // Preserve legacy extraInstructions cleanly if an existing client had one!
            ...(tenant.botConfig?.extraInstructions ? { extraInstructions: tenant.botConfig.extraInstructions } : {})
        };

        // Recompile compressed digest from active items cleanly (edited/deleted entries vanish immediately!)
        const { compiledDigest, compressedByAi } = await compileClientKnowledgeDigest(cleanConfig);
        cleanConfig.compiledDigest = compiledDigest;
        cleanConfig.compressedByAi = compressedByAi;

        await cols.tenants.updateOne(
            { _id: tenantId },
            {
                $set: {
                    name: cleanConfig.businessName || tenant.name,
                    botConfig: cleanConfig,
                    quickReplies,
                    updatedAt: new Date()
                }
            }
        );

        const budget = estimateKnowledgeBudget({ ...tenant, botConfig: cleanConfig });
        await waManager.logAndEmit(
            tenantId,
            'info',
            'ai',
            `Saved Business Brain (${budget.counts.offers} offers, ${budget.counts.products} items, ${budget.counts.faqs} FAQs · ~${budget.estimatedTokens} prompt tokens${compressedByAi ? ', AI-compressed' : ''}).`
        );
        res.json({ ok: true, botConfig: cleanConfig, quickReplies, budget });
    });

    // Safety, Warmup Caps, Hours, Opt-outs & Blacklist
    router.get('/api/safety', requireClient, async (req, res) => {
        const tenant = req.scope.tenant;
        const optedOut = await cols.conversations
            .find({ tenantId: req.scope.tenantId, optedOut: true }, { projection: { displayName: 1, phoneNumber: 1, lastMessageAt: 1 } })
            .limit(50)
            .toArray();

        res.json({
            safety: tenant.safety,
            blacklist: tenant.blacklist || [],
            optedOut,
            warmupPresets: WARMUP_PRESETS,
            runtime: waManager.getStatusSnapshot(req.scope.tenantId)
        });
    });

    router.put('/api/safety', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const curr = req.scope.tenant.safety || {};
        const s = req.body?.safety || {};

        let maxDailyOut = Number(s.maxDailyOut || curr.maxDailyOut || 90);
        let maxHourlyOut = Number(s.maxHourlyOut || curr.maxHourlyOut || 18);
        const warmupTier = ['new', 'warming', 'aged', 'custom'].includes(s.warmupTier) ? s.warmupTier : (curr.warmupTier || 'warming');
        if (warmupTier !== 'custom' && WARMUP_PRESETS[warmupTier] && s.applyPreset) {
            maxDailyOut = WARMUP_PRESETS[warmupTier].maxDailyOut;
            maxHourlyOut = WARMUP_PRESETS[warmupTier].maxHourlyOut;
        }

        const nextSafety = {
            aiEnabled: s.aiEnabled !== undefined ? Boolean(s.aiEnabled) : Boolean(curr.aiEnabled),
            warmupTier,
            maxDailyOut: Math.max(5, Math.min(500, maxDailyOut)),
            maxHourlyOut: Math.max(2, Math.min(60, maxHourlyOut)),
            perUser10m: Math.max(2, Math.min(20, Number(s.perUser10m || curr.perUser10m || 6))),
            perUser24h: Math.max(5, Math.min(100, Number(s.perUser24h || curr.perUser24h || 25))),
            takeoverMinutes: [0, 15, 30, 60, 120].includes(Number(s.takeoverMinutes)) ? Number(s.takeoverMinutes) : (curr.takeoverMinutes ?? 30),
            debounceMs: Math.max(500, Math.min(8000, Number(s.debounceMs || curr.debounceMs || 1800))),
            groupMode: ['ignore_all', 'mentions_only'].includes(s.groupMode) ? s.groupMode : (curr.groupMode || 'ignore_all'),
            operatingMode: ['always', 'business_hours', 'after_hours_only'].includes(s.operatingMode) ? s.operatingMode : (curr.operatingMode || 'always'),
            timezone: String(s.timezone || curr.timezone || 'Asia/Kolkata').slice(0, 50),
            workHours: s.workHours || curr.workHours,
            awayMessage: String(s.awayMessage || curr.awayMessage || '').slice(0, 500),
            sendAwayMessage: s.sendAwayMessage !== undefined ? Boolean(s.sendAwayMessage) : Boolean(curr.sendAwayMessage),
            readReceipts: s.readReceipts !== undefined ? Boolean(s.readReceipts) : curr.readReceipts !== false,
            quoteReplies: s.quoteReplies !== undefined ? Boolean(s.quoteReplies) : curr.quoteReplies !== false,
            splitLongReplies: s.splitLongReplies !== undefined ? Boolean(s.splitLongReplies) : Boolean(curr.splitLongReplies),
            voiceNotesEnabled: s.voiceNotesEnabled !== undefined ? Boolean(s.voiceNotesEnabled) : curr.voiceNotesEnabled !== false,
            imageVisionEnabled: s.imageVisionEnabled !== undefined ? Boolean(s.imageVisionEnabled) : curr.imageVisionEnabled !== false,
            optOutKeywords: Array.isArray(s.optOutKeywords)
                ? s.optOutKeywords.map((k) => String(k).trim().toLowerCase()).filter(Boolean).slice(0, 15)
                : (curr.optOutKeywords || ['stop', 'unsubscribe']),
            webhookUrl: String(s.webhookUrl ?? curr.webhookUrl ?? '').trim().slice(0, 300)
        };

        const blacklist = Array.isArray(req.body?.blacklist)
            ? req.body.blacklist
                .map((b) => ({
                    ref: normalizeDigits(b.ref) || String(b.ref || '').trim(),
                    label: String(b.label || 'Blocked').trim().slice(0, 50)
                }))
                .filter((b) => b.ref)
                .slice(0, 100)
            : req.scope.tenant.blacklist;

        await cols.tenants.updateOne(
            { _id: tenantId },
            { $set: { safety: nextSafety, blacklist, updatedAt: new Date() } }
        );

        if (req.body?.clearCircuitBreaker) {
            const rt = waManager.getRuntime(tenantId);
            rt.circuitBreakerUntil = 0;
            rt.circuitReason = '';
            if (rt.sock) rt.status = 'open';
            eventBus.emitTenant(tenantId, 'wa_status', waManager.getStatusSnapshot(tenantId));
        }

        await waManager.logAndEmit(tenantId, 'info', 'safety', `Saved automation & safety settings (AI ${nextSafety.aiEnabled ? 'ON' : 'PAUSED'}).`);
        res.json({ ok: true, safety: nextSafety, blacklist });
    });

    // Leads & CSV Export
    router.get('/api/leads', requireClient, async (req, res) => {
        const leads = await cols.leads
            .find({ tenantId: req.scope.tenantId })
            .sort({ updatedAt: -1 })
            .limit(200)
            .toArray();
        res.json({ leads });
    });

    router.patch('/api/leads/:id', requireClient, async (req, res) => {
        const tenantId = req.scope.tenantId;
        const sets = { updatedAt: new Date() };
        if (['new', 'contacted', 'converted', 'lost'].includes(req.body?.stage)) sets.stage = req.body.stage;
        if (['hot', 'warm', 'cold'].includes(req.body?.score)) sets.score = req.body.score;
        if (typeof req.body?.intent === 'string') sets.intent = req.body.intent.trim().slice(0, 120);

        if (!ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid lead ID.' });
        const result = await cols.leads.updateOne(
            { _id: new ObjectId(req.params.id), tenantId },
            { $set: sets }
        );
        if (result.matchedCount === 0) return res.status(404).json({ error: 'Lead not found.' });
        res.json({ ok: true });
    });

    router.get('/api/leads/export.csv', requireClient, async (req, res) => {
        const leads = await cols.leads.find({ tenantId: req.scope.tenantId }).sort({ createdAt: -1 }).toArray();
        const esc = (v) => `"${String(v || '').replace(/"/g, '""')}"`;
        const lines = ['Name,Phone,Intent,Budget,Score,Stage,CapturedAt'];
        for (const l of leads) {
            lines.push([
                esc(l.name),
                esc(l.phone),
                esc(l.intent),
                esc(l.budget),
                esc(l.score),
                esc(l.stage),
                esc(new Date(l.createdAt).toISOString())
            ].join(','));
        }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="leads-${req.scope.tenantId}.csv"`);
        res.send(lines.join('\n'));
    });

    // Activity Logs
    router.get('/api/logs', requireClient, async (req, res) => {
        const logs = await cols.activityLogs
            .find({ tenantId: req.scope.tenantId })
            .sort({ createdAt: -1 })
            .limit(120)
            .toArray();
        res.json({ logs });
    });

    // WhatsApp Control Routes
    router.post('/api/wa/connect', requireClient, async (req, res) => {
        try {
            await waManager.connectTenant(req.scope.tenantId, { forceFresh: true });
            res.json({ ok: true, status: waManager.getStatusSnapshot(req.scope.tenantId) });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/wa/pairing-code', requireClient, async (req, res) => {
        try {
            const code = await waManager.requestPairingCode(req.scope.tenantId, req.body?.phone);
            res.json({ ok: true, code });
        } catch (err) {
            res.status(400).json({ error: err.message });
        }
    });

    router.post('/api/wa/disconnect', requireClient, async (req, res) => {
        await waManager.disconnectTenant(req.scope.tenantId, { preserveAuth: true });
        res.json({ ok: true });
    });

    router.post('/api/wa/logout', requireClient, async (req, res) => {
        await waManager.disconnectTenant(req.scope.tenantId, { preserveAuth: false });
        res.json({ ok: true });
    });

    // Preserved External Bridge Hook (Phase 2 IG/FB Ready)
    router.post('/api/chat', requireDb, async (req, res) => {
        if (!CONFIG.BOT_API_SECRET) {
            return res.status(503).json({ error: 'BOT_API_SECRET not configured.' });
        }
        const provided = req.headers['x-api-key'] || req.headers.authorization?.replace('Bearer ', '');
        if (!provided) return res.status(401).json({ error: 'Unauthorized' });

        const hA = crypto.createHash('sha256').update(String(provided)).digest();
        const hB = crypto.createHash('sha256').update(CONFIG.BOT_API_SECRET).digest();
        if (!crypto.timingSafeEqual(hA, hB)) return res.status(401).json({ error: 'Unauthorized' });

        const { tenantId, text } = req.body || {};
        if (!tenantId || !text) return res.status(400).json({ error: 'Missing tenantId or text' });
        const tenant = await cols.tenants.findOne({ _id: tenantId, status: 'active' });
        if (!tenant) return res.status(404).json({ error: 'Tenant not found or suspended' });

        const aiRes = await generateAIReply({
            systemPrompt: buildTenantSystemPrompt(tenant),
            contextTurns: [],
            userText: String(text)
        });
        return res.json({ reply: aiRes.text, model: aiRes.model, latencyMs: aiRes.latencyMs });
    });

    return router;
}
