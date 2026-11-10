import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { CONFIG } from './src/config.mjs';
import { initDatabase, closeDatabase } from './src/db.mjs';
import { createApiRouter } from './src/routes.mjs';
import { waManager } from './src/whatsapp-manager.mjs';
import { eventBus } from './src/stream.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

// Security headers (allow Google Fonts + Fontshare + inline data QR codes)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://api.fontshare.com; font-src 'self' https://fonts.gstatic.com https://cdn.fontshare.com data:; img-src 'self' data:; connect-src 'self';"
    );
    next();
});

// Zero-dep lightweight gzip for static bundles & larger JSON (explicitly skips SSE /api/stream!)
app.use((req, res, next) => {
    if (req.path === '/api/stream' || req.path === '/api/admin/stream') return next();
    const accept = String(req.headers['accept-encoding'] || '');
    if (!accept.includes('gzip')) return next();

    const origSend = res.send.bind(res);
    res.send = (body) => {
        if (res.headersSent || !body || res.getHeader('Content-Encoding')) return origSend(body);
        const type = String(res.getHeader('Content-Type') || '');
        if (!type.includes('text/') && !type.includes('javascript') && !type.includes('json')) {
            return origSend(body);
        }
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
        if (buf.length < 1800) return origSend(body);

        zlib.gzip(buf, (err, gz) => {
            if (err) return origSend(body);
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Vary', 'Accept-Encoding');
            res.removeHeader('Content-Length');
            origSend(gz);
        });
    };
    next();
});

// API & health routes
app.use(createApiRouter());

// Dedicated static Admin Console route
app.get('/admin', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/favicon.ico', (req, res) => res.status(204).end());

// Static assets (always revalidate via ETag so deploys apply immediately without stale JS caches)
app.use(express.static(PUBLIC_DIR, {
    etag: true,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    }
}));

// Return crisp JSON 404 for unknown /api/* endpoints
app.use('/api', (req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
});

// Client SPA fallback
app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

let server = null;
async function shutdown(signal) {
    console.log(`${signal} received. Draining SSE & WhatsApp sockets gracefully...`);
    eventBus.shutdownAll();
    await waManager.shutdownAll();
    await closeDatabase();
    if (server) {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    } else {
        process.exit(0);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

async function start() {
    await initDatabase();
    server = app.listen(CONFIG.PORT, () => {
        console.log(`SaaS Portal listening on port ${CONFIG.PORT}`);
        waManager.bootAllSavedTenants().catch((err) => console.error('[Boot Error]:', err.message));
    });
    // Prevent Node 5-minute requestTimeout from dropping live SSE streams
    server.requestTimeout = 0;
    server.timeout = 0;
}

start();
