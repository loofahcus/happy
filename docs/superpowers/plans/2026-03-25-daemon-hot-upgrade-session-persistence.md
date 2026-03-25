# Daemon Hot-Upgrade Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist active session state to `daemon.state.json` so a new daemon can recover and control sessions from a previous daemon instance without interrupting them.

**Architecture:** Extend `DaemonLocallyPersistedState` with a serializable `sessions` array. The running daemon writes sessions to disk on every heartbeat and during shutdown. On startup, the new daemon reads sessions from the state file before stopping the old daemon, then reconstructs `pidToTrackedSession` after acquiring the lock.

**Tech Stack:** TypeScript, Vitest (integration tests in `daemon.integration.test.ts`), Node.js `process.kill(pid, 0)` for liveness checks.

---

## Chunk 1: Data Model

### Task 1: Add `PersistedTrackedSession` and extend `DaemonLocallyPersistedState`

**Files:**
- Modify: `packages/happy-cli/src/persistence.ts:270-277`

Context: `DaemonLocallyPersistedState` at line 270 has no `sessions` field. `TrackedSession` (in `daemon/types.ts`) has a `childProcess?: ChildProcess` field that cannot be JSON-serialized — `PersistedTrackedSession` is the serializable subset.

- [ ] **Step 1: Add `Metadata` import to `persistence.ts`**

`persistence.ts` does not currently import `Metadata`. Add it after the existing imports (after line 14, `import { logger } from '@/ui/logger';`):

```typescript
import { Metadata } from '@/api/types';
```

- [ ] **Step 2: Add `PersistedTrackedSession` interface and `sessions` field**

Find the `DaemonLocallyPersistedState` interface (line 270) and update the block:

```typescript
/**
 * Serializable subset of TrackedSession — ChildProcess omitted (not JSON-serializable).
 * Used to persist active sessions across daemon restarts.
 */
export interface PersistedTrackedSession {
  startedBy: string;
  happySessionId?: string;
  happySessionMetadataFromLocalWebhook?: Metadata;
  pid: number;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
  /** tmux session identifier (format: session:window) */
  tmuxSessionId?: string;
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
  /** Active sessions at last write — used for hot-upgrade recovery */
  sessions?: PersistedTrackedSession[];
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd packages/happy-cli && yarn tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/src/persistence.ts
git commit -m "feat(daemon): add PersistedTrackedSession type and sessions field to DaemonLocallyPersistedState"
```

---

## Chunk 2: Session Write Strategy

### Task 2: Include sessions in heartbeat write

**Files:**
- Modify: `packages/happy-cli/src/daemon/run.ts:776-790` (heartbeat write block)

Context: The heartbeat runs every 60s (or `HAPPY_DAEMON_HEARTBEAT_INTERVAL` ms). Around line 778 it calls `writeDaemonState(updatedState)`. We extend `updatedState` with the current sessions. Only sessions that have a `happySessionId` are persisted — sessions still awaiting their webhook are excluded.

- [ ] **Step 1: Import `PersistedTrackedSession` at top of `run.ts`**

Find the import line that already imports from `@/persistence` (line 16):

```typescript
import { writeDaemonState, DaemonLocallyPersistedState, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';
```

Add `PersistedTrackedSession` to that import:

```typescript
import { writeDaemonState, DaemonLocallyPersistedState, PersistedTrackedSession, readDaemonState, acquireDaemonLock, releaseDaemonLock, readSettings, getActiveProfile, getEnvironmentVariables, validateProfileForAgent, getProfileEnvironmentVariables } from '@/persistence';
```

- [ ] **Step 2: Add `serializeSessions` helper inside `startDaemon` and update heartbeat write**

In `startDaemon()`, immediately after `pidToTrackedSession` is defined (line 168), add the helper. This placement ensures it closes over `pidToTrackedSession` once the map is available:

```typescript
/** Serialize current session map, stripping non-serializable ChildProcess. */
const serializeSessions = (): PersistedTrackedSession[] =>
  Array.from(pidToTrackedSession.values())
    .filter(s => s.happySessionId !== undefined)
    .map(({ childProcess: _ignored, ...rest }) => rest);
```

Then in the heartbeat block (around line 778), extend `updatedState` to include sessions:

```typescript
const updatedState: DaemonLocallyPersistedState = {
  pid: process.pid,
  httpPort: controlPort,
  startTime: fileState.startTime,
  startedWithCliVersion: packageJson.version,
  lastHeartbeat: new Date().toLocaleString(),
  daemonLogPath: fileState.daemonLogPath,
  sessions: serializeSessions(),  // ← add this line
};
writeDaemonState(updatedState);
```

- [ ] **Step 3: Add sessions snapshot write in `cleanupAndShutdown`**

In `cleanupAndShutdown` (around line 798), add a sessions write immediately before `cleanupDaemonState()` is called. This gives `doctor` access to the last-known sessions even on graceful shutdown:

```typescript
// Write final session snapshot before cleanup (useful for doctor and hot-upgrade)
try {
  const daemonStateBeforeCleanup = await readDaemonState();
  if (daemonStateBeforeCleanup) {
    writeDaemonState({ ...daemonStateBeforeCleanup, sessions: serializeSessions() });
  }
} catch (shutdownWriteErr) {
  logger.debug('[DAEMON RUN] Failed to write sessions snapshot on shutdown:', shutdownWriteErr);
}

await cleanupDaemonState();
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd packages/happy-cli && yarn tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/happy-cli/src/daemon/run.ts
git commit -m "feat(daemon): write active sessions to state file on heartbeat and shutdown"
```

### Task 3: Integration test — sessions appear in state file after heartbeat

**Files:**
- Modify: `packages/happy-cli/src/daemon/daemon.integration.test.ts`

Context: Integration tests run with `yarn test:integration-test-env`. They use the `notifyDaemonSessionStarted` helper to simulate a session registering. The env var `HAPPY_DAEMON_HEARTBEAT_INTERVAL` controls heartbeat frequency — tests set it to 1000ms for speed. The test registers a session, waits for one heartbeat cycle, then reads the state file.

- [ ] **Step 1: Add integration test for sessions in state file**

Add the following test inside the existing `describe` block in `daemon.integration.test.ts`, after the existing tests:

```typescript
it('should write active sessions to state file on heartbeat', async () => {
  // Register a terminal session using the test process's own PID
  // (guaranteed to be alive for the duration of the test)
  const mockMetadata: Metadata = {
    path: '/test/path',
    host: 'test-host',
    homeDir: '/test/home',
    happyHomeDir: '/test/happy-home',
    happyLibDir: '/test/happy-lib',
    happyToolsDir: '/test/happy-tools',
    hostPid: process.pid,
    startedBy: 'terminal',
    machineId: 'test-machine-session-write'
  };
  await notifyDaemonSessionStarted('session-write-test-001', mockMetadata);

  // Wait for one heartbeat cycle to write sessions
  // HAPPY_DAEMON_HEARTBEAT_INTERVAL must be set to a low value (e.g. 1000ms) in
  // the integration test env for this to run quickly
  const heartbeatMs = parseInt(process.env.HAPPY_DAEMON_HEARTBEAT_INTERVAL || '60000');
  await new Promise(resolve => setTimeout(resolve, heartbeatMs + 500));

  const state = await readDaemonState();
  expect(state).not.toBeNull();
  expect(state!.sessions).toBeDefined();

  const recovered = state!.sessions!.find(s => s.happySessionId === 'session-write-test-001');
  expect(recovered).toBeDefined();
  expect(recovered!.pid).toBe(process.pid);
  expect(recovered!.startedBy).toBe('happy directly - likely by user from terminal');
});
```

- [ ] **Step 2: Run the integration test (requires local server)**

```bash
cd packages/happy-cli && HAPPY_DAEMON_HEARTBEAT_INTERVAL=1000 yarn test:integration-test-env --testNamePattern="should write active sessions"
```

Expected: PASS. The session should appear in `state.sessions` after one heartbeat.

- [ ] **Step 3: Commit**

```bash
git add packages/happy-cli/src/daemon/daemon.integration.test.ts
git commit -m "test(daemon): verify active sessions are written to state file on heartbeat"
```

---

## Chunk 3: Startup Recovery

### Task 4: Read sessions before stopping old daemon, recover map after lock

**Files:**
- Modify: `packages/happy-cli/src/daemon/run.ts:133-168` (startup section)

Context: The startup flow is:
1. `isDaemonRunningCurrentlyInstalledHappyVersion()` reads `daemon.state.json` — file still exists here.
2. If version mismatch: `stopDaemon()` triggers old daemon `cleanupAndShutdown` which **deletes** the file.
3. `acquireDaemonLock()` acquires the lock.
4. `pidToTrackedSession = new Map()` initialises the session map.

We must read `sessions` from the state file at step 1 (before `stopDaemon()`) and populate the map at step 4 (after initialisation).

- [ ] **Step 1: Extract sessions from state file before stopping old daemon**

Find this block in `startDaemon()` (around line 133):

```typescript
const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
if (!runningDaemonVersionMatches) {
  logger.debug('[DAEMON RUN] Daemon version mismatch detected, restarting daemon with current CLI version');
  await stopDaemon();
} else {
  logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
  console.log('Daemon already running with matching version');
  process.exit(0);
}
```

Replace with:

```typescript
// Read sessions from state file BEFORE stopping old daemon.
// stopDaemon() causes the old daemon to run cleanupAndShutdown which deletes the file.
// Capturing sessions first ensures hot-upgrade recovery is possible.
const previousStateForRecovery = await readDaemonState();
const sessionsToRecover: PersistedTrackedSession[] = previousStateForRecovery?.sessions ?? [];

const runningDaemonVersionMatches = await isDaemonRunningCurrentlyInstalledHappyVersion();
if (!runningDaemonVersionMatches) {
  logger.debug(`[DAEMON RUN] Daemon version mismatch detected, restarting. Sessions to recover: ${sessionsToRecover.length}`);
  await stopDaemon();
} else {
  logger.debug('[DAEMON RUN] Daemon version matches, keeping existing daemon');
  console.log('Daemon already running with matching version');
  process.exit(0);
}
```

- [ ] **Step 2: Reconstruct `pidToTrackedSession` from recovered sessions**

Find this block (around line 168):

```typescript
// Setup state - key by PID
const pidToTrackedSession = new Map<number, TrackedSession>();
```

Replace with:

```typescript
// Setup state - key by PID
const pidToTrackedSession = new Map<number, TrackedSession>();

// Recover sessions from the previous daemon instance.
// Each PID is verified alive before re-adding — dead processes are silently skipped.
for (const session of sessionsToRecover) {
  try {
    process.kill(session.pid, 0); // signal 0: check existence without sending a signal
    pidToTrackedSession.set(session.pid, { ...session });
    logger.debug(`[DAEMON RUN] Recovered session PID ${session.pid} (happySessionId: ${session.happySessionId ?? 'none'})`);
  } catch {
    logger.debug(`[DAEMON RUN] Skipping dead session PID ${session.pid} during recovery`);
  }
}
if (sessionsToRecover.length > 0) {
  logger.debug(`[DAEMON RUN] Recovery complete: ${pidToTrackedSession.size}/${sessionsToRecover.length} sessions alive`);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd packages/happy-cli && yarn tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/happy-cli/src/daemon/run.ts
git commit -m "feat(daemon): recover active sessions from state file on hot-upgrade restart"
```

### Task 5: Integration test — sessions recovered after daemon restart

**Files:**
- Modify: `packages/happy-cli/src/daemon/daemon.integration.test.ts`

Context: We simulate hot-upgrade recovery without triggering a real version mismatch (which would require `yarn build`). The test directly writes a fake state file with a session, then starts a fresh daemon that reads it. The session's `pid` is the test process's own PID (always alive). After the new daemon starts, `listDaemonSessions()` should include the recovered session.

- [ ] **Step 1: Extend the persistence import in the test file**

The test file already imports from `@/persistence` at line 30:
```typescript
import { readDaemonState, clearDaemonState } from '@/persistence';
```

Add `DaemonLocallyPersistedState` and `PersistedTrackedSession` to that import:
```typescript
import { readDaemonState, clearDaemonState, DaemonLocallyPersistedState, PersistedTrackedSession } from '@/persistence';
```

(`writeFileSync` is already imported from `fs` at line 19, `Metadata` is already imported from `@/api/types` at line 31 — no additional imports needed.)

- [ ] **Step 2: Add integration test for session recovery on restart**

Add this test inside the `describe` block in `daemon.integration.test.ts`:

```typescript
it('should recover sessions from previous daemon state on restart', async () => {
  // Stop the daemon started by beforeEach
  await stopDaemon();
  await waitFor(async () => !existsSync(configuration.daemonStateFile), 3000);

  // Write a fake state file that simulates what a previous daemon would have written.
  // Using process.pid guarantees the "session process" is alive for the liveness check.
  const fakeSession: PersistedTrackedSession = {
    startedBy: 'happy directly - likely by user from terminal',
    happySessionId: 'session-recovery-test-001',
    pid: process.pid,  // test process is alive, so recovery will succeed
    happySessionMetadataFromLocalWebhook: {
      path: '/test/path',
      host: 'test-host',
      homeDir: '/test/home',
      happyHomeDir: '/test/happy-home',
      happyLibDir: '/test/happy-lib',
      happyToolsDir: '/test/happy-tools',
      hostPid: process.pid,
      startedBy: 'terminal',
      machineId: 'test-machine-recovery'
    }
  };
  const fakeState: DaemonLocallyPersistedState = {
    pid: 0,           // placeholder — not used for recovery
    httpPort: 0,      // placeholder
    startTime: new Date().toLocaleString(),
    startedWithCliVersion: '0.0.0-fake',
    sessions: [fakeSession]
  };

  // writeFileSync is already imported from 'fs' at line 19
  writeFileSync(configuration.daemonStateFile, JSON.stringify(fakeState, null, 2), 'utf-8');

  // Start a new daemon — it will read the fake state file and recover the session
  void spawnHappyCLI(['daemon', 'start'], { stdio: 'ignore' });

  await waitFor(async () => {
    const state = await readDaemonState();
    return state !== null && state.pid !== 0;
  }, 15_000, 250);

  // The recovered session should appear in the tracked list
  await waitFor(async () => {
    const sessions = await listDaemonSessions();
    return sessions.some((s: any) => s.happySessionId === 'session-recovery-test-001');
  }, 5_000, 200);

  const sessions = await listDaemonSessions();
  const recovered = sessions.find((s: any) => s.happySessionId === 'session-recovery-test-001');
  expect(recovered).toBeDefined();
  expect(recovered!.pid).toBe(process.pid);
  expect(recovered!.startedBy).toBe('happy directly - likely by user from terminal');
});
```

- [ ] **Step 3: Run the integration test**

```bash
cd packages/happy-cli && HAPPY_DAEMON_HEARTBEAT_INTERVAL=1000 yarn test:integration-test-env --testNamePattern="should recover sessions"
```

Expected: PASS. The daemon should list the pre-seeded session after restart.

- [ ] **Step 4: Run all integration tests to check for regressions**

```bash
cd packages/happy-cli && HAPPY_DAEMON_HEARTBEAT_INTERVAL=1000 yarn test:integration-test-env
```

Expected: all tests pass (the version-mismatch test takes ~1 minute, others are fast).

- [ ] **Step 5: Final compile check**

```bash
cd packages/happy-cli && yarn tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/happy-cli/src/daemon/daemon.integration.test.ts
git commit -m "test(daemon): verify session recovery after daemon restart via state file"
```
