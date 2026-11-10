/**
 * Lightweight multiplexed SSE hub for live QR, WhatsApp status, Inbox messages & Logs.
 * Zero extra npm dependencies; single global heartbeat keeps proxy connections alive.
 */
class TenantEventBus {
    constructor() {
        this.clientsByTenant = new Map(); // tenantId -> Set<res>
        this.adminClients = new Set(); // Set<res>
        this.buffers = new Map(); // tenantId -> Array<{ id, type, data }>
        this.seq = 1;
        this.MAX_BUFFER_PER_TENANT = 60;
        this.MAX_WRITE_BUFFER_BYTES = 65_536;

        this.heartbeatTimer = setInterval(() => {
            this.broadcastPing();
        }, 22_000);
        if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    subscribeTenant(req, res, tenantId) {
        this._initSseHeaders(req, res);

        let set = this.clientsByTenant.get(tenantId);
        if (!set) {
            set = new Set();
            this.clientsByTenant.set(tenantId, set);
        }
        set.add(res);

        // Replay missed events if reconnected with Last-Event-ID
        const lastId = Number(req.headers['last-event-id'] || 0);
        const buf = this.buffers.get(tenantId) || [];
        for (const ev of buf) {
            if (!lastId || ev.id > lastId) {
                this._safeWrite(res, set, ev.frame);
            }
        }

        res.write('event: connected\ndata: {"ok":true}\n\n');

        req.on('close', () => {
            set.delete(res);
            if (set.size === 0) this.clientsByTenant.delete(tenantId);
        });
    }

    subscribeAdmin(req, res) {
        this._initSseHeaders(req, res);
        this.adminClients.add(res);
        res.write('event: connected\ndata: {"admin":true}\n\n');
        req.on('close', () => {
            this.adminClients.delete(res);
        });
    }

    emitTenant(tenantId, eventType, payload) {
        const id = this.seq++;
        const serialized = JSON.stringify(payload);
        const frame = `id: ${id}\nevent: ${eventType}\ndata: ${serialized}\n\n`;

        // Store non-QR/noisy high-frequency frames cleanly in compact ring buffer
        if (eventType !== 'wa_qr') {
            let buf = this.buffers.get(tenantId);
            if (!buf) {
                buf = [];
                this.buffers.set(tenantId, buf);
            }
            buf.push({ id, type: eventType, frame });
            if (buf.length > this.MAX_BUFFER_PER_TENANT) {
                buf.shift();
            }
        }

        const set = this.clientsByTenant.get(tenantId);
        if (set && set.size > 0) {
            for (const res of set) {
                this._safeWrite(res, set, frame);
            }
        }
    }

    emitAdmin(eventType, payload) {
        if (this.adminClients.size === 0) return;
        const id = this.seq++;
        const frame = `id: ${id}\nevent: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
        for (const res of this.adminClients) {
            this._safeWrite(res, this.adminClients, frame);
        }
    }

    _initSseHeaders(req, res) {
        req.setTimeout(0);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders?.();
        res.write('retry: 3500\n\n');
    }

    _safeWrite(res, ownerSet, chunk) {
        try {
            if (res.destroyed || res.writableEnded) {
                ownerSet.delete(res);
                return;
            }
            if ((res.socket?.writableLength || 0) > this.MAX_WRITE_BUFFER_BYTES) {
                ownerSet.delete(res);
                try { res.end(); } catch {}
                return;
            }
            res.write(chunk);
        } catch {
            ownerSet.delete(res);
        }
    }

    broadcastPing() {
        for (const [tenantId, set] of this.clientsByTenant) {
            for (const res of set) {
                this._safeWrite(res, set, ': ping\n\n');
            }
            if (set.size === 0) this.clientsByTenant.delete(tenantId);
        }
        for (const res of this.adminClients) {
            this._safeWrite(res, this.adminClients, ': ping\n\n');
        }
    }

    shutdownAll() {
        clearInterval(this.heartbeatTimer);
        for (const set of this.clientsByTenant.values()) {
            for (const res of set) {
                try {
                    res.write('event: server_restart\ndata: {}\n\n');
                    res.end();
                } catch {}
            }
        }
        this.clientsByTenant.clear();
        for (const res of this.adminClients) {
            try {
                res.write('event: server_restart\ndata: {}\n\n');
                res.end();
            } catch {}
        }
        this.adminClients.clear();
    }
}

export const eventBus = new TenantEventBus();
