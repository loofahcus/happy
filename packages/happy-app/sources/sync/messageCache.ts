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

function loadIndex(): string[] {
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

function saveIndex(index: string[]): void {
    mmkv.set(INDEX_KEY, JSON.stringify(index));
}

function addToIndex(sessionId: string): void {
    const index = loadIndex();
    if (!index.includes(sessionId)) {
        saveIndex([...index, sessionId]);
    }
}

function removeFromIndex(sessionId: string): void {
    const index = loadIndex();
    const filtered = index.filter(id => id !== sessionId);
    if (filtered.length !== index.length) {
        saveIndex(filtered);
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
            // Version mismatch — discard stale cache
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
        // Meta exists but data missing — corrupted, clean up
        deleteMessageCache(sessionId);
        return null;
    }

    try {
        const messages = JSON.parse(raw) as NormalizedMessage[];
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

    // Load existing cached messages (if any)
    const existing = loadMessageCache(sessionId);
    const combined = existing
        ? [...existing.messages, ...messages]
        : [...messages];

    // Truncate oldest if over limit
    const truncated = combined.length > MAX_CACHED_MESSAGES
        ? combined.slice(combined.length - MAX_CACHED_MESSAGES)
        : combined;

    const meta: MessageCacheMeta = {
        version: CACHE_VERSION,
        lastSeq,
        cachedAt: Date.now(),
    };

    mmkv.set(`${DATA_PREFIX}${sessionId}`, JSON.stringify(truncated));
    mmkv.set(`${META_PREFIX}${sessionId}`, JSON.stringify(meta));
    addToIndex(sessionId);
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

    for (const sessionId of index) {
        const meta = loadMessageCacheMeta(sessionId);
        if (!meta || (now - meta.cachedAt > CACHE_EXPIRY_MS)) {
            expired.push(sessionId);
        }
    }

    for (const sessionId of expired) {
        deleteMessageCache(sessionId);
    }
}
