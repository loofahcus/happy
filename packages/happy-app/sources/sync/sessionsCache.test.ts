import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock MMKV, backed by a Map with a real localStorage-sized quota ────────
// react-native-mmkv's web backend is plain `localStorage` (~5MB per origin).
// Sessions now carry a materialized `avatar.uri` data URI (decrypted avatar
// image, base64-encoded), which is exactly the kind of payload that blows
// past that quota once more than a couple of sessions have one.

const QUOTA_BYTES = 5 * 1024 * 1024;
const store = new Map<string, string>();

vi.mock('react-native-mmkv', () => ({
    MMKV: class {
        getString(key: string): string | undefined {
            return store.get(key);
        }
        set(key: string, value: string): void {
            const used = [...store.entries()]
                .filter(([k]) => k !== key)
                .reduce((sum, [, v]) => sum + v.length, 0);
            if (used + value.length > QUOTA_BYTES) {
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

import { loadCachedSessions, saveCachedSessions } from './sessionsCache';
import type { Session } from './storageTypes';

function makeAvatarUri(bytes: number): string {
    // A real avatar.uri is `data:<mime>;base64,<...>` — base64 inflates
    // the underlying bytes by ~4/3. Use a plain repeated character; only
    // the resulting string length matters for the quota check.
    return `data:image/webp;base64,${'A'.repeat(Math.ceil(bytes * 4 / 3))}`;
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
        id,
        seq: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        active: true,
        activeAt: Date.now(),
        metadata: null,
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...overrides,
    };
}

beforeEach(() => {
    store.clear();
});

describe('sessionsCache', () => {
    it('round-trips a small session list with no avatars', () => {
        const sessions = [makeSession('a'), makeSession('b')];
        saveCachedSessions(sessions);
        const loaded = loadCachedSessions();
        expect(loaded).not.toBeNull();
        expect(loaded!.map(s => s.id)).toEqual(['a', 'b']);
    });

    it('still caches sessions once a realistic number carry a materialized avatar data URI', () => {
        // Simulate other MMKV consumers (message caches, settings, etc.) already
        // occupying part of the shared localStorage-backed quota, same as in a
        // real app that has been running for a while.
        store.set('other-consumer', 'x'.repeat(2 * 1024 * 1024));

        // A modest downloaded avatar: ~80KB decrypted, which is common for a
        // real photo/bot-face thumbnail well under the 10MB download cap. A
        // user with a long-lived account easily has 100+ sessions listed.
        const sessions = Array.from({ length: 100 }, (_, i) =>
            makeSession(`s${i}`, {
                avatar: { ref: `r${i}`, version: 1, mimeType: 'image/webp', thumbhash: 'x', uri: makeAvatarUri(80_000) },
            }),
        );

        saveCachedSessions(sessions);
        const loaded = loadCachedSessions();

        // 100 * ~107KB (base64) ≈ 10.7MB of avatar data alone — this blows
        // past what's left of the 5MB quota once other consumers' data is
        // accounted for. Loading `null` here means saveCachedSessions hit
        // the quota and deleted the cache instead of falling back, exactly
        // the "cache stopped working after the avatar feature landed"
        // regression this test guards against.
        expect(loaded).not.toBeNull();
        expect(loaded?.length).toBe(100);
    });
});
