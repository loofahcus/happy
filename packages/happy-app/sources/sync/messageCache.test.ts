import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock MMKV ──────────────────────────────────────────────────────────────

const store = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string): string | undefined {
            return store.get(key);
        }
        set(key: string, value: string): void {
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('messageCache', () => {
    beforeEach(() => {
        store.clear();
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
            store.set('msg-cache-index', JSON.stringify(['session-1']));

            expect(loadMessageCacheMeta('session-1')).toBeNull();
            // Should have cleaned up
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
        });

        it('discards corrupted meta JSON', () => {
            store.set('msg-cache-meta:session-1', 'not-json');
            store.set('msg-cache-index', JSON.stringify(['session-1']));

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
            store.set('msg-cache-index', JSON.stringify(['session-1']));

            expect(loadMessageCache('session-1')).toBeNull();
            expect(store.has('msg-cache-meta:session-1')).toBe(false);
        });

        it('discards when data is corrupted JSON', () => {
            store.set('msg-cache-meta:session-1', JSON.stringify({ version: 1, lastSeq: 1, cachedAt: Date.now() }));
            store.set('msg-cache-data:session-1', 'not-json');
            store.set('msg-cache-index', JSON.stringify(['session-1']));

            expect(loadMessageCache('session-1')).toBeNull();
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
            // Write 999 messages
            const batch1 = Array.from({ length: 999 }, (_, i) => makeMessage(`old-${i}`));
            appendMessageCache('session-1', batch1, 999);

            // Append 5 more — total 1004, should truncate to 1000
            const batch2 = Array.from({ length: 5 }, (_, i) => makeMessage(`new-${i}`));
            appendMessageCache('session-1', batch2, 1004);

            const cache = loadMessageCache('session-1');
            expect(cache!.messages).toHaveLength(1000);
            // First 4 old messages should be gone
            expect(cache!.messages[0].id).toBe('old-4');
            // Last 5 should be the new ones
            expect(cache!.messages[995].id).toBe('new-0');
            expect(cache!.messages[999].id).toBe('new-4');
        });

        it('adds session to index', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-2', [makeMessage('b')], 1);

            const index = JSON.parse(store.get('msg-cache-index')!);
            expect(index).toContain('session-1');
            expect(index).toContain('session-2');
        });

        it('does not duplicate session in index', () => {
            appendMessageCache('session-1', [makeMessage('a')], 1);
            appendMessageCache('session-1', [makeMessage('b')], 2);

            const index = JSON.parse(store.get('msg-cache-index')!);
            expect(index.filter((id: string) => id === 'session-1')).toHaveLength(1);
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

            const index = JSON.parse(store.get('msg-cache-index')!);
            expect(index).not.toContain('session-1');
            expect(index).toContain('session-2');
        });

        it('is safe to call on non-existent session', () => {
            expect(() => deleteMessageCache('does-not-exist')).not.toThrow();
        });
    });

    describe('cleanExpiredMessageCaches', () => {
        it('removes caches older than 30 days', () => {
            appendMessageCache('old-session', [makeMessage('a')], 1);
            // Backdate the meta to 31 days ago
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
            store.set('msg-cache-index', JSON.stringify(['ghost-session']));

            cleanExpiredMessageCaches();

            const index = JSON.parse(store.get('msg-cache-index')!);
            expect(index).not.toContain('ghost-session');
        });

        it('does nothing when no caches exist', () => {
            expect(() => cleanExpiredMessageCaches()).not.toThrow();
        });
    });
});
