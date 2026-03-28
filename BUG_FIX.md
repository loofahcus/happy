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
