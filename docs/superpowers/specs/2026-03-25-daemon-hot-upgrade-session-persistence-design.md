# Daemon Hot-Upgrade Session Persistence

**Date:** 2026-03-25
**Status:** Approved for Implementation

## Problem

When the Happy CLI daemon restarts due to a version upgrade, it loses all in-memory session tracking (`pidToTrackedSession`). Session processes survive because they are spawned with `detached: true`, but the new daemon has no knowledge of them — they become uncontrollable orphans until they re-register via webhook (which never happens because each session only fires its webhook once at startup).

## Goal

Allow a new daemon to recover active sessions from the previous daemon with zero downtime for the session processes themselves. Recovered sessions should be fully controllable (list, stop) just like freshly spawned ones.

## Design

### Data Model Changes

**`src/persistence.ts`**

Add a serializable subset of `TrackedSession` (omitting `ChildProcess` which cannot be JSON-serialized):

```typescript
export interface PersistedTrackedSession {
  startedBy: string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  tmuxSessionId?: string;
}
```

Extend `DaemonLocallyPersistedState` with an optional `sessions` field:

```typescript
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
  sessions?: PersistedTrackedSession[];  // NEW
}
```

The field is optional for backwards compatibility — existing state files without `sessions` parse cleanly.

### Session Write Strategy

Sessions are written to `daemon.state.json` at two points in `src/daemon/run.ts`:

1. **Heartbeat (every 60s)** — the existing `writeDaemonState` call is extended to include current sessions:
   ```typescript
   sessions: Array.from(pidToTrackedSession.values())
     .filter(s => s.happySessionId)          // only sessions that registered with the backend
     .map(({ childProcess: _, ...rest }) => rest)  // strip non-serializable ChildProcess
   ```

2. **Shutdown** — `cleanupAndShutdown` writes one final snapshot immediately before calling `cleanupDaemonState()`. This snapshot is useful for the `doctor` command even if it is deleted moments later.

### Startup Recovery Flow

The critical invariant is: **new daemon reads sessions before stopping the old daemon.**

```
New daemon starts
  ↓
isDaemonRunningCurrentlyInstalledHappyVersion()
  → reads daemon.state.json          ← file still exists, old daemon is alive
  → version mismatch → false
  ↓
readDaemonState() → extract sessions into sessionsToRecover[]
  ↓
stopDaemon()                          ← old daemon runs cleanupAndShutdown → deletes file
  ↓
acquireDaemonLock()
  ↓
pidToTrackedSession = new Map()
  ↓
for each session in sessionsToRecover:
  process.kill(pid, 0)
    alive → add to pidToTrackedSession (without childProcess)
    dead  → skip
  ↓
Normal startup continues (HTTP server, WebSocket, RPC handlers…)
```

This sequence is race-free: the sessions are captured in memory before `stopDaemon()` is called, so the subsequent file deletion by the old daemon is irrelevant.

### Edge Cases

| Situation | Behaviour |
|-----------|-----------|
| Session started within 60s before upgrade | Not in state file; not recovered. Process keeps running but is not tracked by new daemon. It remains controllable only via `happy doctor`. |
| Old daemon crashes (no graceful shutdown) | State file preserved with last heartbeat sessions. New daemon reads it on next start. |
| Recovered session has no `childProcess` | `stopSession()` already has a `process.kill(pid, SIGTERM)` fallback path for externally-started sessions — recovered sessions use this path. |
| tmux session | `tmuxSessionId` is serializable and preserved; existing tmux kill logic applies. |
| State file corrupt or missing | `readDaemonState()` returns `null`; `sessionsToRecover` defaults to `[]`; startup proceeds normally. |
| `happySessionId` not yet assigned at heartbeat time | Session filtered out by `.filter(s => s.happySessionId)`. Sessions awaiting webhook have a 15-second timeout (see `run.ts`); if they haven't registered by the next heartbeat they will not be persisted until they do. |

## Files Changed

| File | Change |
|------|--------|
| `src/persistence.ts` | Add `PersistedTrackedSession` interface; add `sessions?` to `DaemonLocallyPersistedState` |
| `src/daemon/run.ts` | Extract sessions before `stopDaemon()`; repopulate map after lock; add sessions to heartbeat write; add sessions to shutdown write |

**Estimated diff:** ~60 lines across 2 files. No new files. No breaking API changes.

## Non-Goals

- Persisting sessions more frequently than the heartbeat interval (future improvement).
- Eliminating the webhook gap entirely (requires sessions to periodically re-register, a separate concern).
- Adding a `status` / `stateReason` field to `daemon.state.json` (noted in CLAUDE.md improvements, out of scope here).
