# New Features — Implementation Notes

This document records each feature we re-implement on top of `upstream/main`, including the problem it solves, the design, and the files changed.

---

## 1. Show Date Alongside Timestamp for Non-Today Messages

### Problem

Upstream renders no per-message timestamp. Old conversations are timeless, so when scrolling far up there is no way to tell whether a message is from today or last week.

### Design

Add a small right-aligned timestamp under each user bubble and a left-aligned one under each agent message. Format depends on the day:

| Date | Format |
|---|---|
| Today | `HH:MM` (24h) |
| Other days | `Mon DD HH:MM` (e.g. `Mar 22 14:30`) |

Same logic also applies to the `limit-reached` agent event so quota windows remain unambiguous across day boundaries.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/MessageView.tsx` | Adds `formatMessageTime()` helper. Renders `<Text style={styles.userTimestamp}>` after both the slash-command chip and the regular bubble inside `UserTextBlock`. Renders `<Text style={styles.agentTimestamp}>` after the markdown in `AgentTextBlock`. Inlines the same logic into `AgentEventBlock`'s `formatTime` for `limit-reached`. Adds `userTimestamp` + `agentTimestamp` styles; reduces `userMessageBubble`/`commandChip` `marginBottom` from 12 to 4 so the timestamp sits close beneath. |

### Notes / deviations from upstream commit `f5558f46`

- Re-implemented on top of upstream's restructured `UserTextBlock` (slash-command chip path, fork-from-message `Pressable` long-press) — fork's diff didn't apply cleanly.
- Both render paths inside `UserTextBlock` now carry the timestamp (chip + bubble); the fork only had the single bubble path because the chip didn't exist yet.

---

## 2. Verbose Mode: Show Model Thinking Content

### Problem

Upstream silently drops every assistant message marked `isThinking`. Users investigating why a turn took the path it did have no way to see the model's reasoning blocks — they're not even toggleable.

### Design

Add a `verbose` boolean setting (default `false`) and gate the existing `if (props.message.isThinking) return null;` on it. When verbose is on, thinking blocks render in the same `agentMessageContainer` but at `opacity: 0.35` so they read as visually distinct from the actual response. Timestamps are still suppressed for thinking blocks (they fire constantly during a turn — adding timestamps would be noise).

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/settings.ts` | Adds `verbose: z.boolean()` to `SettingsSchema` and default `false`. |
| `packages/happy-app/sources/components/MessageView.tsx` | `AgentTextBlock` now reads `useSetting('verbose')`; thinking blocks render with reduced opacity instead of being dropped when verbose is on. |
| `packages/happy-app/sources/app/(app)/settings/features.tsx` | Adds the **Verbose Mode** toggle in Settings → Features (chatbox-ellipses icon). |
| `packages/happy-app/sources/text/_default.ts` | New i18n keys `settingsFeatures.verbose` + `settingsFeatures.verboseSubtitle`. |
| `packages/happy-app/sources/text/translations/{en,es,ca,it,ja,pl,pt,ru,zh-Hans,zh-Hant}.ts` | Same keys translated in all 10 languages. |

### Notes

- Stacks naturally on the timestamp work (#1): thinking blocks intentionally do **not** get a timestamp because Claude emits many rapid thinking segments per turn.
- Port of fork commit `713d0f03`. Diff applies cleanly on top of upstream's restructured `MessageView`.

---

## 3. Local Cache for Sessions and Messages (Instant Cold-Start Paint)

### Problem

Two annoyances on every refresh / cold open of the webapp:

1. The sidebar is empty for several seconds while `GET /v1/sessions` round-trips, decrypts every session's metadata, and finally lands in the store.
2. Opening any session fetches the full message history from the server, even though most of it has not changed since the last visit. Long sessions take noticeably longer to render.

### Design

Two MMKV-backed caches sit beside `persistence.ts`:

| Cache | Key shape | What it stores | Lifetime |
|---|---|---|---|
| **Sessions** (new in this fork — extends fork commit `d79520ec`) | `sessions-cache:active-v1` | The decrypted **active** (non-archived) `Session[]`, with `presence`/`thinking`/`thinkingAt`/`draft` stripped or normalised | 30 days, refreshed on every `fetchSessions` |
| **Messages** (port of fork commit `d79520ec`) | `msg-cache-meta:{sid}`, `msg-cache-data:{sid}`, `msg-cache-index` | Up to 1,000 `NormalizedMessage[]` per session, with `lastSeq` | 30 days, accessed-time index for LRU |

#### Cold-start flow

```
sync.#init()
  ├─ loadCachedSessions()    → applySessions(cached) + applyReady() instantly
  ├─ cleanExpiredMessageCaches()
  └─ sessionsSync.invalidate() (fetchSessions)
        └─ overwrites cached rows with fresh server state
        └─ saveCachedSessions(active)
```

The fork commit only covered the per-session message cache. The session-list cache is the user-requested addition: without it, the sidebar still showed a blank state while the server roundtrip ran. Hydrating from MMKV first lets `applyReady()` fire on the very first frame.

#### Per-session message flow

```
fetchMessages(sid)
  ├─ if sessionLastSeq.get(sid) is undefined (first visit)
  │     loadMessageCache(sid) → applyMessages + sessionLastSeq.set
  ├─ acquire lock
  ├─ fetchInitialLatestPage / fetchForwardSince (decrypt + applyMessages)
  └─ each applyFetchedMessages call appends to the on-disk cache
```

Message cache writes piggy-back on `applyFetchedMessages`, the single fan-in point for both initial and incremental loads, so cache stays in sync with the store.

#### LRU eviction + quota safety

Web platforms back MMKV with `localStorage` (~5 MB). To survive that ceiling:

- All `mmkv.set` calls in `persistence.ts` now go through `safeSet()`, which retries the write after evicting the oldest message-cache entry (`evictOldestMessageCache`).
- The session-list cache uses a single key with bounded payload (active sessions only), so it never triggers LRU but is also tolerant to a full-disk write failing — the cache simply gets cleared and the next `fetchSessions` repopulates it.

#### Lifecycle hooks

| Event | Cache action |
|---|---|
| Cold start | Hydrate sessions, clean expired msg caches |
| `fetchSessions` resolves | Save active sessions |
| `applyFetchedMessages` (initial or forward) | Append to message cache |
| `delete-session` server event | `deleteMessageCache(sid)` |
| Logout (`clearPersistence`) | Already wipes everything via `mmkv.clearAll()` |

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/messageCache.ts` | **New.** Per-session message cache module with LRU + safeSet (port of fork commit). |
| `packages/happy-app/sources/sync/messageCache.test.ts` | **New.** 26 unit tests (mocks MMKV with quota throw). |
| `packages/happy-app/sources/sync/sessionsCache.ts` | **New (project addition).** Single-key cache for the active session list. |
| `packages/happy-app/sources/sync/persistence.ts` | Adds `safeSet()` (signature widened to `string \| number \| boolean` to match `mmkv.set`); rewrites all bare `mmkv.set` calls to `safeSet`. |
| `packages/happy-app/sources/sync/sync.ts` | Imports both caches; `#init()` hydrates sessions + cleans expired msg caches; `fetchSessions` persists active list; `fetchMessages` hydrates per-session cache before lock; `applyFetchedMessages` appends to cache; `delete-session` event drops cache. |

### Notes / deviations from upstream commit `d79520ec`

- Upstream `fetchMessages` was refactored into `fetchInitialLatestPage` + `fetchForwardSince` since the fork commit. We hook the cache at `applyFetchedMessages` (the shared sink) instead of the original single while-loop, so both initial and incremental fetches keep the cache fresh with no duplication.
- Sessions cache is **new** — the fork did not cache the session list itself. It addresses the real-world pain of "blank sidebar for several seconds on every refresh."
