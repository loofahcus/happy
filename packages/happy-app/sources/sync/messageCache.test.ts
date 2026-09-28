import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock MMKV ──────────────────────────────────────────────────────────────

const store = new Map<string, string>();
let shouldThrowOnSet = false;

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string): string | undefined {
            return store.get(key);
        }
        set(key: string, value: string): void {
            if (shouldThrowOnSet) {
                throw new DOMException(
                    "Failed to execute 'setItem' on 'Storage': Setting the value exceeded the quota.",
                    'QuotaExceededError',
                );
            }
            store.set(key, value);
        }
        delete(key: string): void {
            store.delete(key);
        }
    },
}));

import {
    loadMessageCacheMeta,
    loadMessageCache,
    appendMessageCache,
    deleteMessageCache,
    cleanExpiredMessageCaches,
    evictOldestMessageCache,
} from './messageCache';
import type { NormalizedMessage } from './typesRaw';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMessage(id: string): NormalizedMessage {
    return {
        id,
        localId: null,
        createdAt: Date.now(),
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: `msg-${id}` },
    };
}

function getIndex(): Array<{ sessionId: string; accessedAt: number }> {
    const raw = store.get('msg-cache-index');
    return raw ? JSON.parse(raw) : [];
}

function getIndexSessionIds(): string[] {
    return getIndex().map(e => e.sessionId);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('messageCache', () => {
    beforeEach(() => {
        store.clear();
        shouldThrowOnSet = false;
    });

    describe('loadMessageCacheMeta', () => {
        it('returns null when no cache exists', () => {
            expect(loadMessageCacheMeta('session-1')).toBeNull();
        });

        it('returns meta when cache exists', () => {
            appendMessageCache('session-1', [makeMessage('a')], 5);
            const meta = loadMessageCacheMeta('session-1');
            expect(meta).not.toBeNull();
            expect(meta!.lastSeq).toBe(5);
            expect(meta!.version).toBe(1);
        });

        it('discards cache with wrong version', () => {
            store.set('msg-cache-meta:session-1', JSON.stringify({ version: 999, lastSeq: 1, cachedAt: Date.now() }));
            store.set('msg-cache-data:session-1', JSON.stringify([]));
            store.set('msg-cache-index', JSON.stringify([{ sessionId: 'session-1', accessedAt: Date.now() }]));

            expect(loadMessageCacheMeta('session-1')).toBeNull();
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
        });

        it('discards corrupted meta JSON', () => {
            store.set('msg-cache-meta:session-1', 'not-json');
            store.set('msg-cache-index', JSON.stringify([{ sessionId: 'session-1', accessedAt: Date.now() }]));

            expect(loadMessageCacheMeta('session-1')).toBeNull();
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
        });
    });

    describe('loadMessageCache', () => {
        it('returns null when no cache exists', () => {
            expect(loadMessageCache('session-1')).toBeNull();
        });

        it('returns full cache with messages', () => {
            const msg = makeMessage('a');
            appendMessageCache('session-1', [msg], 10);

            const cache = loadMessageCache('session-1');
            expect(cache).not.toBeNull();
            expect(cache!.messages).toHaveLength(1);
            expect(cache!.messages[0].id).toBe('a');
            expect(cache!.lastSeq).toBe(10);
        });

        it('discards when meta exists but data is missing', () => {
            store.set('msg-cache-meta:session-1', JSON.stringify({ version: 1, lastSeq: 1, cachedAt: Date.now() }));
            store.set('msg-cache-index', JSON.stringify([{ sessionId: 'session-1', accessedAt: Date.now() }]));

            expect(loadMessageCache('session-1')).toBeNull();
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
        });

        it('discards when data is corrupted JSON', () => {
            store.set('msg-cache-meta:session-1', JSON.stringify({ version: 1, lastSeq: 1, cachedAt: Date.now() }));
            store.set('msg-cache-data:session-1', 'not-json');
            store.set('msg-cache-index', JSON.stringify([{ sessionId: 'session-1', accessedAt: Date.now() }]));

            expect(loadMessageCache('session-1')).toBeNull();
        });

        it('updates LRU accessedAt on read', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            const before = getIndex().find(e => e.sessionId === 'session-1')!.accessedAt;

            // Small delay to ensure different timestamp
            vi.spyOn(Date, 'now').mockReturnValueOnce(before + 1000);
            loadMessageCache('session-1');

            const after = getIndex().find(e => e.sessionId === 'session-1')!.accessedAt;
            expect(after).toBeGreaterThanOrEqual(before);
            vi.restoreAllMocks();
        });
    });

    describe('appendMessageCache', () => {
        it('creates new cache when none exists', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);

            const cache = loadMessageCache('session-1');
            expect(cache).not.toBeNull();
            expect(cache!.messages).toHaveLength(1);
            expect(cache!.lastSeq).toBe(1);
        });

        it('appends to existing cache', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-1', [makeMessage('b'), makeMessage('c')], 3);

            const cache = loadMessageCache('session-1');
            expect(cache!.messages).toHaveLength(3);
            expect(cache!.lastSeq).toBe(3);
        });

        it('does nothing when messages array is empty', () => {
            appendMessageCache('session-1', [], 0);
            expect(loadMessageCache('session-1')).toBeNull();
        });

        it('truncates oldest messages when exceeding 1000 limit', () => {
            const batch1 = Array.from({ length: 999 }, (_, i) => makeMessage(`old-${i}`));
            appendMessageCache('session-1', batch1, 999);

            const batch2 = Array.from({ length: 5 }, (_, i) => makeMessage(`new-${i}`));
            appendMessageCache('session-1', batch2, 1004);

            const cache = loadMessageCache('session-1');
            expect(cache!.messages).toHaveLength(1000);
            expect(cache!.messages[0].id).toBe('old-4');
            expect(cache!.messages[995].id).toBe('new-0');
            expect(cache!.messages[999].id).toBe('new-4');
        });

        it('adds session to index', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-2', [makeMessage('b')], 1);

            const ids = getIndexSessionIds();
            expect(ids).toContain('session-1');
            expect(ids).toContain('session-2');
        });

        it('does not duplicate session in index', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-1', [makeMessage('b')], 2);

            const ids = getIndexSessionIds();
            expect(ids.filter(id => id === 'session-1')).toHaveLength(1);
        });
    });

    describe('deleteMessageCache', () => {
        it('removes all cache data for a session', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            deleteMessageCache('session-1');

            expect(loadMessageCache('session-1')).toBeNull();
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
            expect(store.has('msg-cache-data:session-1')).toBe(false);
        });

        it('removes session from index', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-2', [makeMessage('b')], 1);
            deleteMessageCache('session-1');

            const ids = getIndexSessionIds();
            expect(ids).not.toContain('session-1');
            expect(ids).toContain('session-2');
        });

        it('is safe to call on non-existent session', () => {
            expect(() => deleteMessageCache('does-not-exist')).not.toThrow();
        });
    });

    describe('cleanExpiredMessageCaches', () => {
        it('removes caches older than 30 days', () => {
            appendMessageCache('old-session', [makeMessage('a')], 1);
            const meta = JSON.parse(store.get('msg-cache-meta:old-session')!);
            store.set('msg-cache-meta:old-session', JSON.stringify({
                ...meta,
                cachedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
            }));

            appendMessageCache('fresh-session', [makeMessage('b')], 1);

            cleanExpiredMessageCaches();

            expect(loadMessageCache('old-session')).toBeNull();
            expect(loadMessageCache('fresh-session')).not.toBeNull();
        });

        it('removes entries with missing meta', () => {
            store.set('msg-cache-index', JSON.stringify([{ sessionId: 'ghost-session', accessedAt: Date.now() }]));

            cleanExpiredMessageCaches();

            const ids = getIndexSessionIds();
            expect(ids).not.toContain('ghost-session');
        });

        it('does nothing when no caches exist', () => {
            expect(() => cleanExpiredMessageCaches()).not.toThrow();
        });
    });

    describe('evictOldestMessageCache', () => {
        it('returns false when no caches exist', () => {
            expect(evictOldestMessageCache()).toBe(false);
        });

        it('evicts the least recently accessed cache', () => {
            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now - 3000);
            appendMessageCache('oldest', [makeMessage('a')], 1);

            vi.spyOn(Date, 'now').mockReturnValue(now - 1000);
            appendMessageCache('middle', [makeMessage('b')], 1);

            vi.spyOn(Date, 'now').mockReturnValue(now);
            appendMessageCache('newest', [makeMessage('c')], 1);
            vi.restoreAllMocks();

            const result = evictOldestMessageCache();
            expect(result).toBe(true);
            expect(loadMessageCacheMeta('oldest')).toBeNull();
            expect(loadMessageCacheMeta('middle')).not.toBeNull();
            expect(loadMessageCacheMeta('newest')).not.toBeNull();
        });

        it('evicts multiple in LRU order', () => {
            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now - 2000);
            appendMessageCache('first', [makeMessage('a')], 1);

            vi.spyOn(Date, 'now').mockReturnValue(now - 1000);
            appendMessageCache('second', [makeMessage('b')], 1);

            vi.spyOn(Date, 'now').mockReturnValue(now);
            appendMessageCache('third', [makeMessage('c')], 1);
            vi.restoreAllMocks();

            evictOldestMessageCache();
            evictOldestMessageCache();

            expect(loadMessageCacheMeta('first')).toBeNull();
            expect(loadMessageCacheMeta('second')).toBeNull();
            expect(loadMessageCacheMeta('third')).not.toBeNull();
        });
    });

    describe('safeSet (quota recovery)', () => {
        it('evicts LRU caches when write fails due to quota', () => {
            const now = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(now - 2000);
            appendMessageCache('old-session', [makeMessage('a')], 1);
            vi.spyOn(Date, 'now').mockReturnValue(now);
            appendMessageCache('new-session', [makeMessage('b')], 1);
            vi.restoreAllMocks();

            // Next write will fail once then succeed
            let failCount = 0;
            const origSet = store.set.bind(store);
            vi.spyOn(store, 'set').mockImplementation((key: string, value: string) => {
                failCount++;
                if (failCount <= 1) {
                    throw new DOMException('Quota exceeded', 'QuotaExceededError');
                }
                return origSet(key, value);
            });

            appendMessageCache('trigger', [makeMessage('c')], 1);

            // old-session should have been evicted
            expect(store.has('msg-cache-data:old-session')).toBe(false);

            vi.restoreAllMocks();
        });

        it('gives up gracefully when nothing left to evict', () => {
            shouldThrowOnSet = true;

            // Should not throw — gives up silently
            expect(() => appendMessageCache('doomed', [makeMessage('a')], 1)).not.toThrow();
        });
    });
});
