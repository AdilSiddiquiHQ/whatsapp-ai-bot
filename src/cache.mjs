/**
 * Zero-dependency O(1) Bounded LRU + TTL CacheStore.
 * Strictly caps heap growth and avoids per-key timer allocations,
 * conforming cleanly to Baileys CacheStore interface (get/set/del/flushAll).
 */
export class BoundedCacheStore {
    constructor(ttlMs = 300_000, maxKeys = 400) {
        this.ttlMs = ttlMs;
        this.maxKeys = Math.max(1, maxKeys);
        this.map = new Map();
    }

    get(key) {
        if (key === undefined || key === null) return undefined;
        const entry = this.map.get(key);
        if (!entry) return undefined;

        if (this.ttlMs > 0 && Date.now() > entry.exp) {
            this.map.delete(key);
            return undefined;
        }

        // Refresh LRU position
        this.map.delete(key);
        this.map.set(key, entry);
        return entry.val;
    }

    has(key) {
        return this.get(key) !== undefined;
    }

    set(key, val, customTtlMs) {
        if (key === undefined || key === null) return;
        const ttl = typeof customTtlMs === 'number' ? customTtlMs : this.ttlMs;
        const exp = ttl > 0 ? Date.now() + ttl : Number.MAX_SAFE_INTEGER;

        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.maxKeys) {
            // Opportunistically evict expired keys first before oldest LRU
            const now = Date.now();
            let cleaned = 0;
            for (const [k, e] of this.map) {
                if (now > e.exp) {
                    this.map.delete(k);
                    cleaned++;
                    if (cleaned >= 16) break;
                } else {
                    break;
                }
            }
            while (this.map.size >= this.maxKeys) {
                const oldestKey = this.map.keys().next().value;
                this.map.delete(oldestKey);
            }
        }

        this.map.set(key, { val, exp });
    }

    del(key) {
        this.map.delete(key);
    }

    flushAll() {
        this.map.clear();
    }

    get size() {
        return this.map.size;
    }
}

/**
 * Memory-bounded sliding-window rate limiter (IP / per-user WA anti-flood).
 */
export class SlidingWindowLimiter {
    constructor(maxKeys = 3000) {
        this.maxKeys = maxKeys;
        this.buckets = new Map();
    }

    consume(key, limit, windowMs) {
        const now = Date.now();
        const cutoff = now - windowMs;
        let timestamps = this.buckets.get(key);

        if (!timestamps) {
            if (this.buckets.size >= this.maxKeys) {
                const oldest = this.buckets.keys().next().value;
                this.buckets.delete(oldest);
            }
            timestamps = [];
        } else {
            // Refresh LRU order & filter old timestamps
            this.buckets.delete(key);
            timestamps = timestamps.filter((t) => t > cutoff);
        }

        const allowed = timestamps.length < limit;
        if (allowed) {
            timestamps.push(now);
        }
        this.buckets.set(key, timestamps);
        return { allowed, remaining: Math.max(0, limit - timestamps.length) };
    }

    reset(key) {
        this.buckets.delete(key);
    }
}
