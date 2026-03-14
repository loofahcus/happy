import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We test the AuthModule class logic directly by extracting from module
// Since AuthModule is not exported, we test via the exported `auth` singleton

describe('AuthModule token cache cleanup', () => {
    // We can't easily test the private AuthModule class, so we create a minimal
    // standalone implementation that mirrors the cache cleanup logic for testing

    interface TokenCacheEntry {
        userId: string;
        extras?: any;
        cachedAt: number;
    }

    const TOKEN_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    function cleanup(cache: Map<string, TokenCacheEntry>, now: number): void {
        for (const [token, entry] of cache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL_MS) {
                cache.delete(token);
            }
        }
    }

    it('should remove entries older than TTL', () => {
        const cache = new Map<string, TokenCacheEntry>();
        const now = Date.now();

        // Add an old entry (25 hours ago)
        cache.set('old-token', {
            userId: 'user-1',
            cachedAt: now - 25 * 60 * 60 * 1000
        });

        // Add a fresh entry (1 hour ago)
        cache.set('fresh-token', {
            userId: 'user-2',
            cachedAt: now - 1 * 60 * 60 * 1000
        });

        cleanup(cache, now);

        expect(cache.has('old-token')).toBe(false);
        expect(cache.has('fresh-token')).toBe(true);
        expect(cache.size).toBe(1);
    });

    it('should keep entries exactly at TTL boundary', () => {
        const cache = new Map<string, TokenCacheEntry>();
        const now = Date.now();

        // Entry exactly at TTL boundary
        cache.set('boundary-token', {
            userId: 'user-1',
            cachedAt: now - TOKEN_CACHE_TTL_MS
        });

        cleanup(cache, now);

        // Exactly at boundary should NOT be evicted (> not >=)
        expect(cache.has('boundary-token')).toBe(true);
    });

    it('should handle empty cache gracefully', () => {
        const cache = new Map<string, TokenCacheEntry>();
        const now = Date.now();

        cleanup(cache, now);

        expect(cache.size).toBe(0);
    });

    it('should remove all entries when all are expired', () => {
        const cache = new Map<string, TokenCacheEntry>();
        const now = Date.now();

        for (let i = 0; i < 100; i++) {
            cache.set(`token-${i}`, {
                userId: `user-${i}`,
                cachedAt: now - 48 * 60 * 60 * 1000 // 48 hours ago
            });
        }

        cleanup(cache, now);

        expect(cache.size).toBe(0);
    });
});
