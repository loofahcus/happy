# Local Message Cache for happy-app

## Problem

Every time the mobile app starts or a session becomes visible, it fetches **all** historical messages from the server starting from seq 0. The `sessionLastSeq` Map is in-memory only and resets on app restart. For sessions with hundreds or thousands of messages, this causes unnecessary network traffic and slow initial load.

## Solution

Cache `NormalizedMessage[]` locally using MMKV. On session load, replay cached messages through the existing reducer for instant UI rendering, then fetch only new messages incrementally from the server.

## Scope

- **happy-app only** — the CLI does not need this because Claude Code already caches session history locally in `.jsonl` files.
- **Server: zero changes** — the existing `after_seq` + `limit` API supports incremental fetching natively.

## Cache Data Format

```typescript
const CACHE_VERSION = 1;

type MessageCacheMeta = {
  version: number;     // Format version for future migration
  lastSeq: number;     // Highest seq number in cached messages
  cachedAt: number;    // Timestamp of last cache write (for expiry)
}

type MessageCache = MessageCacheMeta & {
  messages: NormalizedMessage[];
}
```

**Storage keys (MMKV):**
- `msg-cache-meta:${sessionId}` — metadata only (cheap read for seq and expiry checks)
- `msg-cache-data:${sessionId}` — full NormalizedMessage[] array
- `msg-cache-index` — `string[]` of all cached session IDs (avoids iterating full MMKV keyspace)

**Constraints:**
- **Expiry**: 30 days from last `cachedAt`. Active sessions auto-renew on each write.

## Flow

### Session becomes visible (with cache)

1. Read `msg-cache-meta:${sessionId}` — cheap check for existence and seq
2. Read `msg-cache-data:${sessionId}` — deserialize full messages
3. Feed cached `messages` to `enqueueMessages` → reducer replays them → UI renders immediately
4. Set `afterSeq = cache.lastSeq`, also restore `sessionLastSeq` in-memory Map
5. Fetch incremental messages from server (`after_seq=lastSeq`)
6. Append new messages to cache, update `lastSeq` and `cachedAt`

### Session becomes visible (no cache)

1. Existing behavior: fetch all from seq 0
2. After fetch completes, write full result to cache

### Reconnection / memory pressure

When socket reconnects and `sessionLastSeq.get(sessionId)` is 0 but a cache exists in MMKV, read `msg-cache-meta` to restore `afterSeq` before fetching. This prevents re-fetching everything after a long background period.

### Cache expiry cleanup

- On app startup, read `msg-cache-index` array
- For each session ID, read `msg-cache-meta:${sessionId}`
- Delete entries where `Date.now() - cachedAt > 30 days`
- Update the index array

### Logout / clear all

The existing `clearPersistence()` in `persistence.ts` calls `mmkv.clearAll()`, which already wipes all MMKV keys including cache keys. No additional cleanup needed for logout.

## New File

### `sources/sync/messageCache.ts`

Core interface:

```typescript
const CACHE_VERSION = 1;
const CACHE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Load cache metadata only (cheap)
function loadMessageCacheMeta(sessionId: string): MessageCacheMeta | null

// Load full cached messages for a session
function loadMessageCache(sessionId: string): MessageCache | null

// Append new messages and update lastSeq
function appendMessageCache(
  sessionId: string,
  messages: NormalizedMessage[],
  lastSeq: number
): void

// Delete cache for a specific session
function deleteMessageCache(sessionId: string): void

// Remove caches older than 30 days
function cleanExpiredMessageCaches(): void
```

## Modified Files

### `sources/sync/sync.ts`

**`fetchMessages` method:**
- Before the fetch loop: load cache → enqueue cached messages → set `afterSeq`
- After the fetch loop: append new messages to cache
- **Cache writes only happen within the session's `AsyncLock`** to prevent concurrent read-modify-write from the fetch loop and real-time fast path.

**Session deletion handler (~line 1837-1858):**
- Add `deleteMessageCache(sessionId)` call when a session is deleted.

### `sources/sync/persistence.ts`

- Call `cleanExpiredMessageCaches()` during app initialization

## What Does Not Change

- Server API — zero changes
- Reducer — zero changes (idempotent, replay-safe)
- Zustand storage — zero changes
- Message rendering — zero changes
- Encryption — messages are cached post-decryption, no key storage needed

## Edge Cases

1. **Cache format upgrade**: `CACHE_VERSION` constant in `messageCache.ts`. If stored version does not match, discard the cache and fetch fresh.
2. **Corrupted cache**: If JSON parsing fails, discard the cache and fetch fresh. Never throw.
3. **Session deleted**: `deleteMessageCache(sessionId)` called in the delete-session handler.
4. **Reducer logic changes**: Since we cache NormalizedMessages (not final Messages), updated reducer logic automatically applies on replay. No migration needed.
5. **Reconnection after background**: Restore `afterSeq` from cache meta if `sessionLastSeq` is 0 but cache exists.
6. **Large sessions**: No cap on cached messages. MMKV handles large values well via memory-mapped files, and sessions with thousands of messages are uncommon.
