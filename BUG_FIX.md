# Bug Fixes — Implementation Notes

This document records each bug fix we implement on top of `upstream/main`, including the root cause, the fix design, and the files changed.

---

## 1. Mode Switch Fix: Process Group Kill + stdin Restoration

### Problem

Three critical bugs when switching between local and remote modes:

| Bug | Symptom |
|-----|---------|
| **Process tree leak** | Old `claude-linux-x64` grandchild processes survive mode switch, accumulate over time |
| **Characters eaten** | First keystrokes lost after switching from remote to local mode |
| **3+ spaces to switch** | Double-space gesture requires 3-5 presses instead of 2 |

**Root cause**: `spawn()` with `signal: opts.abort` only kills the direct child process. Grandchild processes (claude-linux-x64, etc.) survive with `stdio: 'inherit'`, competing with the parent for stdin (fd 0). Additionally, Node.js internal stream state (`_readableState.reading`, libuv handle) can be left inconsistent after Ink teardown, preventing clean handoff.

### Design

Three-part fix:

#### 1. Process group kill (`claudeLocal.ts`)
- Replace `signal: opts.abort` with `detached: true` to create a new process group
- Manual `process.kill(-child.pid, 'SIGTERM')` kills the entire process tree on abort
- Cleanup: remove abort listener on child exit to prevent memory leaks

#### 2. Comprehensive stdin restoration (`restoreStdin.ts`)
7-step idempotent cleanup, called at every mode transition boundary:

| Step | Action | Why |
|------|--------|-----|
| 1 | Disable raw mode | Terminal line editing |
| 2 | `handle.readStop()` | Stop libuv from reading fd 0 |
| 3 | `process.stdin.pause()` | Exit flowing mode |
| 4 | Reset internal state flags | `reading`, `flowing`, `errored`, `constructed`, etc. |
| 5 | Remove all listeners | Safety net for Ink teardown races |
| 6 | Drain buffered data | Prevent phantom keystrokes |
| 7 | Re-enforce handle stop | Drain may have restarted the handle |

#### 3. Stable input handling (`RemoteModeDisplay.tsx`)
- Use refs (`confirmationModeRef`, `actionInProgressRef`) instead of state in `useInput` callback
- Handler identity never changes → `useInput` subscribes once → no keystroke gaps
- Refs updated immediately in handler (before setState) to handle rapid keypresses

### Call sites

```
claudeLocal.ts:     restoreStdin() before spawn, restoreStdin() in finally
claudeRemoteLauncher.ts: restoreStdin() before Ink render, restoreStdin() after unmount
                         + process.nextTick safety net to force-start libuv handle
runClaude.ts:       restoreStdin() in signal cleanup handler
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/utils/restoreStdin.ts` | **New file.** 7-step stdin restoration utility |
| `packages/happy-cli/src/utils/restoreStdin.test.ts` | **New file.** 17 unit tests |
| `packages/happy-cli/src/claude/claudeLocal.ts` | `detached: true` + process group kill; `restoreStdin()` replaces `pause()/resume()` |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | `restoreStdin()` before Ink + after unmount; `process.nextTick` safety net; close turn on switch |
| `packages/happy-cli/src/ui/ink/RemoteModeDisplay.tsx` | Refs for `useInput` handler to prevent re-subscription gaps |
| `packages/happy-cli/src/claude/runClaude.ts` | `restoreStdin()` in signal cleanup handler |

### Test coverage

17 unit tests for `restoreStdin()`:
- Internal state flags (`reading`, `flowing`, `ended`, `encoding`, `errored`, `constructed`)
- Handle operations (`readStop`, `reading` flag)
- Listener cleanup
- Buffer drain
- Re-enforcement after drain
- Idempotency
- Error resilience (non-TTY, missing `_readableState`)

---

## 2. Prevent Orphan Session Files from Metadata Extraction

### Problem

When happy-cli starts, `extractSDKMetadata()` sends a throwaway `"hello"` query to Claude Code to discover available tools and slash commands. This creates a `.jsonl` session file in `~/.claude/projects/...` that only contains a single trivial message. These orphan files accumulate over time and clutter the Claude Code session history.

### Design

Pass `--no-session-persistence` to the Claude Code SDK for the metadata extraction query. This flag tells Claude Code not to write a `.jsonl` session file to disk, preventing the orphan file entirely.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/sdk/types.ts` | Added `noSessionPersistence?: boolean` to `QueryOptions` |
| `packages/happy-cli/src/claude/sdk/query.ts` | Pass `--no-session-persistence` CLI flag when option is set |
| `packages/happy-cli/src/claude/sdk/metadataExtractor.ts` | Set `noSessionPersistence: true` on the throwaway metadata query |

---

## 3. Preserve "Don't Ask Again" Tool Permissions

### Problem

Two bugs caused the "Yes, don't ask again for this tool" permission option to silently degrade to a plain "Yes":

| Bug | Root cause | Symptom |
|---|---|---|
| **State wiped on restart** | `permissionHandler.reset()` in the loop's `finally` block cleared `allowedTools` on every `claudeRemote` restart (tool denial, mode change, error) | User had to re-approve the same tool repeatedly within the same session |
| **Wrong field name** | Agent state sent `allowTools` but the app schema expects `allowedTools` | App never received the tool allowlist, so it couldn't display the "don't ask again" indicator |

### Design

#### 1. `softReset()` method

A new `softReset()` on `PermissionHandler` clears transient state (tool call tracking, pending requests) but **preserves** the `allowedTools`, `allowedBashLiterals`, and `allowedBashPrefixes` sets. Used when `claudeRemote` restarts within the same session (loop `finally` block).

The existing `reset()` (full clear) is still used for:
- New session start (different `sessionId`)
- Final cleanup when leaving remote mode

#### 2. Field name fix

Changed `allowTools` → `allowedTools` in the agent state update so the app receives the correct field and can render the permission indicator.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | Added `softReset()` method; fixed `allowTools` → `allowedTools` field name |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Changed loop `finally` block from `reset()` to `softReset()` |

---

## 4. Permission Request Not Appearing on Webapp (Race Condition)

### Problem

Permission prompts intermittently fail to appear on the webapp. When this happens, the CLI hangs waiting for approval while the webapp shows no permission UI — a deadlock. Once it occurs in a session, subsequent permissions also fail to appear.

### Root cause

A race condition between tool_use message delivery and agentState update:

1. `handlePermissionRequest` released the tool_use message **before** updating agentState
2. When the message arrived at the webapp first, the reducer ran with **stale** agentState (no pending permission)
3. The reducer created the tool message **without** permission info
4. When the agentState update arrived later, `applySessions` updated the store but **never triggered a reducer re-run**
5. Since Claude blocks in `canCallTool` waiting for approval, no new messages are generated — the reducer never re-runs — **deadlock**

The `6b74f59c` commit (changing `previousSessionId` from `null` to `session.sessionId`) removed the initial `reset()` call that previously synced the `agentStateVersion` on first iteration. Without that sync, the first `updateAgentState` call was more likely to hit a version-mismatch, adding retry latency (250ms–1000ms backoff) that made the race condition consistently lose.

### Design

Two-layer fix:

#### 1. CLI: ensure agentState arrives before tool_use message (`permissionHandler.ts`)

- Made `updateAgentState` return its `Promise<void>` (was fire-and-forget)
- In `handlePermissionRequest`, the tool_use message is now released in a `.then()` callback **after** the agentState update is confirmed on the server
- Fallback: if the agentState update fails, the message is still released to avoid permanently blocking the message queue

#### 2. Webapp: re-run reducer when agentState changes with pending permissions (`sync.ts`)

- After `applySessions` processes an agentState update with pending `requests`, call `applyMessages(sessionId, [])` to trigger a reducer re-run with the latest agentState
- This is a safety net: even if the race condition still occurs (message arrives first), the reducer will process the pending permission when the agentState update arrives moments later

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/api/apiSession.ts` | `updateAgentState` now returns `Promise<void>` (was implicit void) |
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | Reordered `handlePermissionRequest`: agentState update first, message release in `.then()` with error fallback |
| `packages/happy-app/sources/sync/sync.ts` | Trigger `applyMessages(sessionId, [])` when agentState update contains pending permission requests |

---

## 5. False "Not a Git Repository" Error When Creating Worktree Sessions

### Problem

Creating a new worktree session sometimes displays "Not a Git repository" even when the project is inside a valid Git repo.

### Root cause

Two issues:

| Bug | Root cause | Symptom |
|---|---|---|
| **Overly broad error mapping** | `createWorktree` treated any `git rev-parse --git-dir` failure as "not a git repo", masking real errors (RPC failures, path validation rejections, timeouts) | User sees "Not a Git repository" when the actual problem is something else entirely |
| **Wrong base path for bash validation** | `registerCommonHandlers` in the daemon used `process.cwd()` for path validation, but the daemon's cwd is arbitrary and may not be a parent of the user's project directory | Bash commands rejected by path validation, causing the git check to fail |

### Design

#### 1. Precise error detection (`worktree.ts`)

Parse `gitCheck.stderr` to determine if Git actually reported "not a git repository". Only return that specific error message when it matches; otherwise, pass through the real error from stderr.

#### 2. Use `homedir()` for path validation (`apiMachine.ts`)

Changed `registerCommonHandlers` from `process.cwd()` to `homedir()`, since the user's home directory is always a valid ancestor for project paths, unlike the daemon's arbitrary cwd.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/utils/worktree.ts` | Parse stderr for actual "not a git repository" message; pass through real errors otherwise |
| `packages/happy-cli/src/api/apiMachine.ts` | Import `homedir` from `os`; replace `process.cwd()` with `homedir()` in `registerCommonHandlers` call |

---

## 6. Context Loss After Remote Abort

### Problem

After clicking "Abort" on the remote client while Claude is idle, sending a new message causes Claude to treat the conversation as a fresh session — losing all prior context. Claude responds: *"No, this is a fresh session\!"*

### Root cause

A design gap that existed since the abort mechanism was introduced (not a regression from any specific commit).

When abort fires while Claude is idle:

1. `abortController.abort()` → `waitForMessagesAndGetAsString` returns `null` → `nextMessage()` returns `null`
2. `claudeRemote` calls `messages.end()` → stdin closes → Claude process exits
3. While loop restarts → new Claude process spawned with `--resume SESSION_ID`
4. The user's real question is sent as the **first stdin message** (non-empty)
5. `isResumeWithoutPrompt = \!\!startFrom && \!initial.message.trim()` evaluates to `false`
6. No `DRAIN_MESSAGE` is sent → Claude Code does **not** load conversation history into its context window
7. Claude treats it as a fresh session

The `DRAIN_MESSAGE` mechanism (`5a8984db`) was designed for the "resume without initial prompt" UI flow and was never connected to the abort-restart path.

### Design

After an abort-while-idle, trigger a drain turn at the start of the next `claudeRemote` call by returning an empty initial message from `nextMessage()`. This reuses the existing `DRAIN_MESSAGE` flow to force Claude Code to load session history before the real user message is sent.

#### State tracking

Three variables persist across while-loop iterations:

| Variable | Purpose |
|---|---|
| `lastMode` | Captures mode at last processed message, used as the mode for the synthetic drain message |
| `drainAfterAbort` | Flag set in `finally` block when abort-while-idle is detected |
| `wasThinkingOnAbort` | Captured in `doAbort()` to distinguish idle abort from processing abort |

#### Drain trigger condition

In the `finally` block, `wasAbortedIdle` is true only when:
- `abortController.signal.aborted` (abort actually fired)
- `\!wasThinkingOnAbort` (Claude was idle, not processing)
- `session.sessionId \!== null` (valid session exists)
- `lastMode \!== null` (at least one message was processed)

#### Session validity guard

Before the drain, `claudeCheckSession()` verifies the session file is still valid. If corrupted/missing, `willDrain` is set to `false` and normal flow resumes (no empty message sent to a fresh session).

#### History replay suppression

`onResumeHistory` is set to `undefined` when `willDrain = true` to prevent duplicate messages in the client UI (the client already has the history from before the abort).

### Flow after fix

```
User aborts (idle) → drainAfterAbort = true
While loop restarts → willDrain = true
claudeRemote starts → nextMessage() returns { message: '', mode: lastMode }
→ isResumeWithoutPrompt = true
→ DRAIN_MESSAGE sent to Claude → Claude loads session history → responds "PONG"
→ nextMessage() called again → returns real user message from queue
→ Claude responds with full context ✓
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Added `lastMode`, `drainAfterAbort`, `wasThinkingOnAbort` state; drain injection in `nextMessage`; session validity guard; conditional `onResumeHistory` suppression |
