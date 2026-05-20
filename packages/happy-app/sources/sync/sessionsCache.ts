import { MMKV } from 'react-native-mmkv';
import { Session } from './storageTypes';

/**
 * Persists the decrypted **active** session list in MMKV so that opening
 * the app paints the sidebar instantly instead of waiting for the server
 * roundtrip + per-session decryption.
 *
 * Scope: only sessions that are currently visible (not archived). Archived
 * sessions are loaded on demand via the existing server fetch.
 *
 * Volatile fields (`presence`, `thinking`, `thinkingAt`, `latestUsage`)
 * are stripped on save: they would be misleading after a refresh and the
 * next server fetch overwrites the rest of the row anyway.
 */

const mmkv = new MMKV();
const CACHE_VERSION = 1;
const CACHE_KEY = 'sessions-cache:active-v1';
const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type CachedPayload = {
    version: number;
    cachedAt: number;
    sessions: Session[];
};

function isArchived(session: Session): boolean {
    return session.metadata?.lifecycleState === 'archived';
}

export function loadCachedSessions(): Session[] | null {
    const raw = mmkv.getString(CACHE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as CachedPayload;
        if (parsed.version !== CACHE_VERSION) {
            mmkv.delete(CACHE_KEY);
            return null;
        }
        if (Date.now() - parsed.cachedAt > CACHE_EXPIRY_MS) {
            mmkv.delete(CACHE_KEY);
            return null;
        }
        if (!Array.isArray(parsed.sessions)) return null;
        // Restore volatile fields with safe defaults so the rest of the app
        // does not need to know whether a row came from the cache or live.
        // `active`/`activeAt` are forced offline because the saver strips them.
        return parsed.sessions.map((s) => ({
            ...s,
            active: false,
            activeAt: 0,
            presence: 0,
            thinking: false,
            thinkingAt: 0,
        }));
    } catch {
        mmkv.delete(CACHE_KEY);
        return null;
    }
}

export function saveCachedSessions(sessions: Session[]): void {
    const active = sessions
        .filter((s) => !isArchived(s))
        .map((s) => {
            // Strip volatile fields and any draft / local-only state. Also
            // strip `active` / `activeAt` because they go stale fast and the
            // fresh fetchSessions() / socket updates re-populate them within
            // a few hundred ms — better to show "offline" briefly than wrong
            // "online" indefinitely.
            const { thinking, thinkingAt, presence, draft, active: _a, activeAt: _at, ...rest } = s;
            return {
                ...rest,
                active: false,
                activeAt: 0,
                thinking: false,
                thinkingAt: 0,
                presence: 0,
            } as Session;
        });
    const payload: CachedPayload = {
        version: CACHE_VERSION,
        cachedAt: Date.now(),
        sessions: active,
    };
    try {
        mmkv.set(CACHE_KEY, JSON.stringify(payload));
    } catch {
        // Quota exhausted — drop the cache entirely; better an empty
        // sidebar on next refresh than a serialization crash now.
        mmkv.delete(CACHE_KEY);
    }
}

export function clearCachedSessions(): void {
    mmkv.delete(CACHE_KEY);
}
