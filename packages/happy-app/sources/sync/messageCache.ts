import { MMKV } from 'react-native-mmkv';
import { NormalizedMessage } from './typesRaw';

// ─── Constants ───────────────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const MAX_CACHED_MESSAGES = 1000;
const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const META_PREFIX = 'msg-cache-meta:';
const DATA_PREFIX = 'msg-cache-data:';
const INDEX_KEY = 'msg-cache-index';

// ─── Types ───────────────────────────────────────────────────────────────────

type IndexEntry = {
    sessionId: string;
    accessedAt: number;
};

type MessageCacheMeta = {
    version: number;
    lastSeq: number;
    cachedAt: number;
};

type MessageCache = MessageCacheMeta & {
    messages: NormalizedMessage[];
};

// ─── Storage ─────────────────────────────────────────────────────────────────

// MMKV with default constructor shares the same underlying storage as persistence.ts
const mmkv = new MMKV();

// ─── Index helpers ───────────────────────────────────────────────────────────

function loadIndex(): IndexEntry[] {
    const raw = mmkv.getString(INDEX_KEY);
    if (!raw) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveIndex(index: IndexEntry[]): void {
    mmkv.set(INDEX_KEY, JSON.stringify(index));
}

function touchIndex(sessionId: string): void {
    const index = loadIndex();
    const filtered = index.filter(e => e.sessionId !== sessionId);
    saveIndex([...filtered, { sessionId, accessedAt: Date.now() }]);
}

function removeFromIndex(sessionId: string): void {
    const index = loadIndex();
    const filtered = index.filter(e => e.sessionId !== sessionId);
    if (filtered.length !== index.length) {
        saveIndex(filtered);
    }
}

// ─── LRU eviction ───────────────────────────────────────────────────────────

/**
 * Evict the least recently accessed message cache entry.
 * Returns true if an entry was evicted, false if nothing to evict.
 */
export function evictOldestMessageCache(): boolean {
    const index = loadIndex();
    if (index.length === 0) {
        return false;
    }

    // Find oldest entry (smallest accessedAt)
    let oldestIdx = 0;
    for (let i = 1; i < index.length; i++) {
        if (index[i].accessedAt < index[oldestIdx].accessedAt) {
            oldestIdx = i;
        }
    }

    const oldest = index[oldestIdx];
    mmkv.delete(`${META_PREFIX}${oldest.sessionId}`);
    mmkv.delete(`${DATA_PREFIX}${oldest.sessionId}`);

    const newIndex = index.filter((_, i) => i !== oldestIdx);
    try { saveIndex(newIndex); } catch { /* index save during eviction is best-effort */ }
    return true;
}

// ─── Safe write ─────────────────────────────────────────────────────────────

/**
 * Try mmkv.set; on quota error, evict LRU caches and retry.
 */
function safeSet(key: string, value: string): void {
    while (true) {
        try {
            mmkv.set(key, value);
            return;
        } catch {
            if (!evictOldestMessageCache()) {
                // Nothing left to evict — give up silently
                console.warn('[messageCache] Storage quota exceeded, no caches left to evict');
                return;
            }
        }
    }
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function loadMessageCacheMeta(sessionId: string): MessageCacheMeta | null {
    const raw = mmkv.getString(`${META_PREFIX}${sessionId}`);
    if (!raw) {
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed.version !== CACHE_VERSION) {
            deleteMessageCache(sessionId);
            return null;
        }
        return parsed as MessageCacheMeta;
    } catch {
        deleteMessageCache(sessionId);
        return null;
    }
}

export function loadMessageCache(sessionId: string): MessageCache | null {
    const meta = loadMessageCacheMeta(sessionId);
    if (!meta) {
        return null;
    }

    const raw = mmkv.getString(`${DATA_PREFIX}${sessionId}`);
    if (!raw) {
        deleteMessageCache(sessionId);
        return null;
    }

    try {
        const messages = JSON.parse(raw) as NormalizedMessage[];
        // Touch LRU on successful read
        try { touchIndex(sessionId); } catch { /* best-effort LRU update */ }
        return { ...meta, messages };
    } catch {
        deleteMessageCache(sessionId);
        return null;
    }
}

// Callers MUST hold the session message lock before calling this function.
export function appendMessageCache(
    sessionId: string,
    messages: NormalizedMessage[],
    lastSeq: number,
): void {
    if (messages.length === 0) {
        return;
    }

    const existing = loadMessageCache(sessionId);
    const combined = existing
        ? [...existing.messages, ...messages]
        : [...messages];

    const truncated = combined.length > MAX_CACHED_MESSAGES
        ? combined.slice(combined.length - MAX_CACHED_MESSAGES)
        : combined;

    const meta: MessageCacheMeta = {
        version: CACHE_VERSION,
        lastSeq,
        cachedAt: Date.now(),
    };

    safeSet(`${DATA_PREFIX}${sessionId}`, JSON.stringify(truncated));
    safeSet(`${META_PREFIX}${sessionId}`, JSON.stringify(meta));
    try { touchIndex(sessionId); } catch { /* best-effort LRU update */ }
}

export function deleteMessageCache(sessionId: string): void {
    mmkv.delete(`${META_PREFIX}${sessionId}`);
    mmkv.delete(`${DATA_PREFIX}${sessionId}`);
    removeFromIndex(sessionId);
}

export function cleanExpiredMessageCaches(): void {
    const now = Date.now();
    const index = loadIndex();
    const expired: string[] = [];

    for (const entry of index) {
        const meta = loadMessageCacheMeta(entry.sessionId);
        if (!meta || (now - meta.cachedAt > CACHE_EXPIRY_MS)) {
            expired.push(entry.sessionId);
        }
    }

    for (const sessionId of expired) {
        deleteMessageCache(sessionId);
    }
}
