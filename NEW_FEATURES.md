# New Features — Implementation Notes

This document records each feature we re-implement on top of `upstream/main`, including the problem it solves, the design, and the files changed.

---

## 1. Drain Message Mechanism

### Problem

Claude Code SDK uses `stream-json` for stdin. When a session is resumed without a prompt, or when background tasks complete, stdin must be unblocked by pushing a synthetic "drain" message. Claude responds with "PONG" to this drain message. **That "PONG" must never leak to the mobile app.**

Two scenarios require draining:

| Scenario | Trigger | Why drain is needed |
|---|---|---|
| **Resume without prompt** | User opens an existing session without typing anything | SDK requires at least one user message to start the `for await` loop; we send a drain message to unblock it |
| **Post-ready drain** | A turn completes while background tasks are still pending | Background task notifications (`task_notification` system messages) arrive in the *next* turn; we send a drain message to flush them before prompting the user for input |

### Design

A state machine inside `claudeRemote.ts` with 5 variables:

```
pendingBackgroundTaskCount  — incremented on task_started, decremented on task_notification
isTaskNotificationTurn      — true when the current turn contains a task_notification
isDrainTurn                 — true when we are in a drain cycle
suppressDrainMessages       — global gate: when true, opts.onMessage() is NOT called
postReadyDrainStarted       — one-shot flag preventing infinite post-ready drain loops
```

#### State transitions

```
                    ┌──────────────────────────┐
                    │  Normal turn (no drain)   │
                    │  suppressDrainMessages=F  │
                    └────────────┬─────────────┘
                                 │ result received
                     ┌───────────▼───────────┐
                     │ pendingBackgroundTask  │
                     │ Count > 0 ?           │
                     └───┬───────────────┬───┘
                    yes  │               │ no
          ┌──────────────▼──────┐   ┌────▼─────────────┐
          │ Post-ready drain    │   │ onReady()         │
          │ isDrainTurn=T       │   │ wait for user msg │
          │ suppress=T          │   └──────────────────┘
          │ push drain message  │
          └──────────┬──────────┘
                     │ SDK responds
          ┌──────────▼──────────────────┐
          │ task_notification arrived?   │
          └───┬─────────────────────┬───┘
         yes  │                     │ no
   ┌──────────▼──────────┐  ┌──────▼──────────┐
   │ Continue drain       │  │ Clear drain     │
   │ push another drain   │  │ isDrainTurn=F   │
   │ suppress=T           │  │ suppress=F      │
   └──────────────────────┘  │ onReady()       │
                             └─────────────────┘
```

#### Key invariant

`suppressDrainMessages` is set to `true` **before** the drain message is pushed and only set to `false` **after** the drain result is fully processed. Since the `for await` loop processes messages sequentially, there is no window where a "PONG" can slip through.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/claudeRemote.ts` | Added drain state machine, `suppressDrainMessages` gate on `opts.onMessage()`, resume-without-prompt detection, post-ready drain, and drain chaining for consecutive notifications |
| `packages/happy-cli/src/claude/claudeRemote.test.ts` | **New file.** 6 test scenarios covering: normal turn, resume-without-prompt suppression, drain chaining on notification, no drain on normal-turn notification, post-ready drain flush, and full message-type suppression during drain |

### Test coverage

| # | Scenario | Assertion |
|---|---|---|
| 1 | Normal turn (no background tasks) | All messages visible, assistant text present |
| 2 | Resume without prompt | "PONG" NOT in visible assistants, `onReady` called |
| 3 | Drain + task_notification → chain drain | No "PONG" visible, `onReady` called once |
| 4 | task_notification during normal user turn | Assistant response IS visible (not suppressed) |
| 5 | Post-ready drain (pending > 0 after normal turn) | Real response visible, drain "PONG" not visible |
| 6 | All message types suppressed during drain | Zero assistant messages visible |

### Known limitation

The drain mechanism suppresses messages at the `claudeRemote` level. The Claude Code SDK still writes drain turns to the `.jsonl` session log. If a client reads the raw log file (e.g. for history replay), it will see drain messages. Filtering at the log-read layer is a separate concern.

---

## 2. Context HUD with Model Name Display and Floodgate Quota

### Problem

The webapp had a basic text-only context warning ("X% remaining") with a **hardcoded** `MAX_CONTEXT_SIZE = 190000`. When users switched to extended-context models (e.g., `sonnet[1m]`), the percentage was wrong because the denominator never changed. There was also no visibility into API spend or budget, and no way to see which model was currently active.

Additionally, in local mode the Anthropic API returns `model: "claude-opus-4-6"` without the `[1m]` suffix, so `getContextWindowForModel()` returned 200K instead of 1M for extended-context models.

### Design

A compact `ContextHUD` component replaces the old warning. It shows:

| Element | Description |
|---|---|
| **Progress bar** | Visual fill based on `contextSize / contextWindowSize`, color-coded: green (0–65%), yellow (65–85%), red (85%+) |
| **Used %** | `XX%` in the bar color (percentage of context consumed) |
| **Token counts** | `Xk/Yk` (used / window size) |
| **Quota** | `$spend/$budget` from Floodgate, color-coded by usage (green < 50%, yellow 50–80%, red > 80%) |

The HUD is hidden when context usage < 50% (unless `alwaysShowContextSize` setting is on, or quota data is present).

#### Model name display

The active model is shown as a badge (CPU icon + label) in the input bar. Model names are abbreviated for compact display:

| API model name | Display |
|---|---|
| `claude-opus-4-6-20250514` | `opus` |
| `claude-sonnet-4-6-20250514` | `sonnet` |
| `claude-haiku-4-5-20251001` | `haiku` |
| `gemini-2.5-pro-...` | `gemini pro` |
| `gemini-2.5-flash-...` | `gemini flash` |

Display priority:
1. If the user selected a non-default model mode from the app → show that name
2. Otherwise → show abbreviated actual model name from the API response

#### Dynamic context window size

`getContextWindowForModel(apiModel, localModelCode)` maps model codes to their context window:
- Models containing `[1m]` → 1,000,000 tokens
- All other Claude models → 200,000 tokens (default)

The function checks `localModelCode` first (from settings or `/model` command), then falls back to the API model name. This ensures extended-context models are correctly detected even when the API strips the `[1m]` suffix.

#### Model detection and tracking

Model detection works across both local and remote modes:

| Mode | Source | When | How |
|---|---|---|---|
| **Local** | `~/.claude/settings.json` | At session start | Read the `model` field (e.g., `"opus[1m]"`) |
| **Local** | JSONL messages | During session | Parse `/model` command output from system messages or `<local-command-stdout>` tags in user messages |
| **Remote** | Mode change RPC | When user changes model from app | `claudeRemoteLauncher` calls `setLocalModelCode()` |
| **Both** | Assistant message | Every response | `body.message.model` extracted and attached to session protocol envelope |

The detected model code is stored as `localModelCode` in `ClaudeSessionProtocolState`. When `setLocalModelCode()` is called, it immediately pushes a service message envelope with the updated `context_window` so the HUD reflects the change without waiting for the next assistant response.

#### Context-window-only updates

When a model change triggers `processUsageData()` with zero tokens but a valid `context_window`, the reducer updates only the window size and model name without resetting token counts. This prevents the HUD from showing 0/0 tokens after a model switch.

#### Session protocol `model` field

The `model` field was added to `SessionEnvelope` and flows through the entire pipeline:

```
CLI (assistant message body.message.model)
  → sessionProtocolMapper attaches to first content envelope
  → SessionEnvelope { ..., model: "claude-opus-4-6-...", usage: {...} }
  → App typesRaw normalizeSessionEnvelope() preserves model on NormalizedMessage
  → Reducer processUsageData(state, usage, timestamp, model)
  → state.latestUsage.modelName stored
  → SessionView passes actualModelName to AgentInput
  → abbreviateModelName() → display label
```

#### Floodgate quota

The CLI fetches spend/budget data from the internal Floodgate personal usage API (`https://floodgate.g.apple.com/api/usage/v1/personal`) using mTLS certs from `~/.person/`. Results are cached for 60 seconds and stored in session metadata. The app reads `metadata.quota` and displays it in the ContextHUD.

If mTLS certs are missing or the API is unreachable, quota is silently omitted.

### Data flow

```
CLI (runClaude.ts)
  → fetchQuota() every 60s via setInterval
  → session.updateMetadata({ quota: { spend, budget, fetchedAt } })
  → synced to app via WebSocket

CLI model tracking:
  Local: readInitialModelCode() from ~/.claude/settings.json
    → session.client.setLocalModelCode(modelCode)
    → sessionScanner onModelChange callback updates on /model switch
  Remote: claudeRemoteLauncher receives mode.model from app
    → session.client.setLocalModelCode(mode.model)

setLocalModelCode(modelCode):
  → updates claudeSessionProtocolState.localModelCode
  → creates service envelope with context_window + model
  → sends immediately to app (HUD updates without waiting for next turn)

App (SessionView → AgentInput → ContextHUD)
  → reads metadata.quota
  → displays $spend/$budget with color coding

Context tokens:
  Assistant message (has usage + model)
    → mapper attaches model to first content envelope
    → getContextWindowForModel(apiModel, localModelCode)
    → reducer processUsageData(state, usage, timestamp, model)
      → context-window-only path: updates window + modelName only
      → full update path: calculates contextSize, contextWindowSize, modelName
      → stores in state.latestUsage
    → useSessionUsage(sessionId) selector
    → SessionView passes to AgentInput
    → AgentInput renders <ContextHUD> + model badge
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/utils/quota.ts` | **New file.** Floodgate quota fetcher with mTLS, caching, and error handling |
| `packages/happy-cli/src/claude/runClaude.ts` | Added 60s quota fetch interval with cleanup on exit |
| `packages/happy-cli/src/api/types.ts` | Added `quota` to `Metadata` type |
| `packages/happy-cli/src/api/apiSession.ts` | Added `setLocalModelCode()` with immediate context-window push via service envelope |
| `packages/happy-app/sources/sync/storageTypes.ts` | Added `quota` to `MetadataSchema`; added `modelName` to `latestUsage` |
| `packages/happy-app/sources/components/ContextHUD.tsx` | **New file.** Progress bar + used% + token breakdown + quota display |
| `packages/happy-app/sources/components/AgentInput.tsx` | Replaced `getContextWarning()` with `<ContextHUD>`; added model badge with `abbreviateModelName()` |
| `packages/happy-app/sources/-session/SessionView.tsx` | Passes `actualModelName` from `latestUsage.modelName` to AgentInput |
| `packages/happy-app/sources/components/modelModeOptions.ts` | Added `opus[1m]`/`sonnet[1m]` to model list; added `getContextWindowForModel()`; added `abbreviateModelName()` |
| `packages/happy-app/sources/sync/reducer/reducer.ts` | Dynamic `contextWindowSize`; context-window-only update path; `modelName` in `processUsageData()` and result |
| `packages/happy-app/sources/sync/typesRaw.ts` | Added `model` field to `sessionEnvelopeSchema`; propagated through `normalizeSessionEnvelope()` to all event types |
| `packages/happy-cli/src/claude/claudeLocalLauncher.ts` | Read `~/.claude/settings.json` at startup; wire `onModelChange` from scanner to update `localModelCode` |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Wire `mode.model` from app mode changes to `setLocalModelCode()` |
| `packages/happy-cli/src/claude/utils/sessionScanner.ts` | Enhanced to parse model changes from user messages with `<local-command-stdout>` tags; strips ANSI codes |
| `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts` | Exported `getContextWindowForModel()`; attaches `model` field to session envelopes |
| `packages/happy-wire/src/sessionProtocol.ts` | Added `model` to `SessionEnvelope` schema and `CreateEnvelopeOptions` |
| `packages/happy-cli/scripts/claude_local_launcher.cjs` | Reverted debug Anthropic API response logging |
---

## 3. `--happy-inject` Flag

### Problem

By default, happy-cli injects a Happy system prompt and starts an MCP server into every Claude Code session. This couples the CLI to Happy-specific behavior even when the user wants vanilla Claude Code. There was no way to opt out.

### Design

A new CLI flag `--happy-inject` (default: `false`) gates all Happy-specific injections:

| `--happy-inject` | System prompt | MCP server | `allowedTools` |
|---|---|---|---|
| **not passed** (default) | Not injected | Not started | Empty |
| **passed** | Appended | Started on dynamic port | `mcp__happy__*` tools added |

The flag flows through the entire call chain:

```
index.ts (parse --happy-inject)
  → StartOptions.happyInject
    → runClaude.ts (conditional server start)
      → LoopOptions.happyInject
        → Session.happyInject
          → claudeLocal.ts (gate --append-system-prompt)
          → claudeRemote.ts (gate customSystemPrompt / appendSystemPrompt)
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/index.ts` | Parse `--happy-inject` flag |
| `packages/happy-cli/src/claude/runClaude.ts` | Added `happyInject` to `StartOptions`; conditional MCP server start; conditional `allowedTools`/`mcpServers` in loop call; optional chaining on `happyServer?.stop()` |
| `packages/happy-cli/src/claude/loop.ts` | Added `happyInject` to `LoopOptions`; passed through to `Session` |
| `packages/happy-cli/src/claude/session.ts` | Added `happyInject` property (default `false`) |
| `packages/happy-cli/src/claude/claudeLocalLauncher.ts` | Passes `happyInject` from session to `claudeLocal` |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Passes `happyInject` from session to `claudeRemote` |
| `packages/happy-cli/src/claude/claudeLocal.ts` | Added `happyInject` to opts; gates `--append-system-prompt` behind it |
| `packages/happy-cli/src/claude/claudeRemote.ts` | Added `happyInject` to opts; gates `customSystemPrompt` and `appendSystemPrompt` behind it |

---

## 4. Chat Timestamps

### Problem

Messages in the chat view had no timestamps, making it hard to track when messages were sent.

### Design

- **Today's messages**: show time only (e.g., `14:30`)
- **Other days**: show date + time (e.g., `Mar 22 14:30`)

Applied to user messages, agent messages, and agent event blocks (e.g., usage limit messages).

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/MessageView.tsx` | Added `formatMessageTime()` with smart date logic; added timestamp display to `UserTextBlock`, `AgentTextBlock`, and `AgentEventBlock`; added `userTimestamp` and `agentTimestamp` styles |

---

## 5. Session Rename

### Problem

Sessions could only be identified by their auto-generated summary. There was no way to rename a session from the webapp.

### Design

Session rename uses optimistic concurrency control via the encrypted WebSocket `update-metadata` event. On version mismatch, the client fetches the server's latest metadata, merges the rename, and retries (up to 3 attempts).

Rename is available from:
- **Session info page**: tap on the session name, or use the "Rename Session" quick action
- **Session list**: long-press on a session item

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/ops.ts` | Added `sessionUpdateMetadata()` with optimistic concurrency, encryption, and retry |
| `packages/happy-app/sources/app/(app)/session/[id]/info.tsx` | Tap-to-rename on name, "Rename Session" quick action |
| `packages/happy-app/sources/components/SessionsList.tsx` | Long-press rename |
| Translation files (11) | Added `renameSession`, `renameSessionPrompt`, `renameSessionPlaceholder`, `renameSessionSubtitle` |

---

## 6. Local Message Cache with LRU Eviction

### Problem

Every time the app loaded a session, it re-fetched all historical messages from the server. On slow connections or for sessions with long history, this caused noticeable loading delays.

### Design

MMKV-backed message cache stores `NormalizedMessage[]` per session. On session load, cached messages replay through the reducer instantly before any server fetch.

| Aspect | Detail |
|---|---|
| **Storage** | MMKV (default instance shared with persistence.ts) |
| **Keys** | `msg-cache-meta:{sessionId}`, `msg-cache-data:{sessionId}`, `msg-cache-index` |
| **Max messages** | 1000 per session (oldest truncated) |
| **Expiry** | 30 days (cleaned on app startup) |
| **LRU eviction** | When MMKV quota is exceeded (5MB on web/localStorage), the least recently accessed session cache is evicted automatically |
| **Safe writes** | All MMKV writes in persistence.ts wrapped in `safeSet()` with quota recovery |

### Data flow

```
fetchMessages(sessionId)
  ├─ if preSeq === 0 → loadMessageCache(sessionId) → enqueueMessages (instant UI)
  ├─ acquire lock → fetch new messages from server
  ├─ enqueueMessages(new) + collect allNewNormalized
  └─ appendMessageCache(allNewNormalized, afterSeq) → write cache
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/messageCache.ts` | **New file.** Full cache module with LRU eviction and `safeSet()` |
| `packages/happy-app/sources/sync/messageCache.test.ts` | **New file.** Unit tests |
| `packages/happy-app/sources/sync/sync.ts` | Cache integration: load before lock, append after fetch, delete on session delete, clean expired on init |
| `packages/happy-app/sources/sync/persistence.ts` | Added `safeSet()` wrapper; replaced all `mmkv.set()` calls with `safeSet()` for quota safety |

---

## 7. Git Tracking Toggle (Per-Session with Global Default)

### Problem

Background git tracking ran unconditionally for all sessions. There was no way to disable it for sessions where git status monitoring is unnecessary (e.g., non-code conversations), and no way to control the global default.

### Design

Three-level resolution for git tracking state:

| Level | Storage | Value |
|---|---|---|
| **Global default** | `settings.enableGitTracking` (synced) | `true` / `false` |
| **Per-session override** | `session.enableGitTracking` (MMKV) | `true` / `false` / `null` |
| **Resolved** | `null` → inherit global; `true`/`false` → session wins | — |

The `isGitTrackingEnabled(sessionId)` helper in `sync.ts` resolves the effective state. All `gitStatusSync` invalidation calls are guarded behind this check.

UI surfaces:
- **Settings → Features**: Global toggle (affects all new sessions)
- **Session → Files**: Per-session toggle (overrides global for that session)

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/settings.ts` | Added `enableGitTracking: z.boolean()` with default `true` |
| `packages/happy-app/sources/sync/storageTypes.ts` | Added `enableGitTracking?: boolean \| null` to `Session` |
| `packages/happy-app/sources/sync/storage.ts` | Added `updateSessionGitTracking()` action, `useSessionGitTrackingEnabled()` hook, merge in `applySessions`, cleanup on delete |
| `packages/happy-app/sources/sync/persistence.ts` | Added `loadSessionGitTracking()` / `saveSessionGitTracking()` |
| `packages/happy-app/sources/sync/sync.ts` | Added `isGitTrackingEnabled()` helper; guarded all `gitStatusSync.invalidate()` calls |
| `packages/happy-app/sources/-session/SessionView.tsx` | Uses `useSessionGitTrackingEnabled(sessionId)` instead of `useSetting()` |
| `packages/happy-app/sources/app/(app)/session/[id]/files.tsx` | Per-session toggle via `updateSessionGitTracking()` |
| `packages/happy-app/sources/app/(app)/settings/features.tsx` | Global toggle in Features settings |
| Translation files (11) | Added `settingsFeatures.gitTracking*` keys |


---

## 8. Verbose Mode — Show Model Thinking Content

### Problem

The Claude Code SDK returns `thinking` blocks containing the model's internal reasoning. These blocks were fully captured and transmitted through the entire pipeline (CLI → wire protocol → server → app), but the app unconditionally hid them (`MessageView` returned `null` for `isThinking` messages). Previously on `origin/main`, thinking was gated behind the `experiments` flag, but that coupling was removed. Users had no way to see thinking content.

### Design

A dedicated `verbose` boolean setting (default: `false`) controls whether thinking messages are displayed. When enabled, thinking blocks render with `opacity: 0.35` for visual distinction from regular agent messages. Timestamps are hidden for thinking messages.

| `verbose` | Thinking messages |
|---|---|
| `false` (default) | Hidden (`return null`) |
| `true` | Shown with `opacity: 0.35` |

The toggle is in **Settings → Features** with a purple chat bubble icon.

### Data flow (pre-existing, unchanged)

```
Claude SDK (thinking block)
  → sessionProtocolMapper (envelope with thinking: true)
  → server stores message
  → app reducer (AgentTextMessage.isThinking = true, text wrapped in *italics*)
  → MessageView (NEW: checks verbose setting before hiding)
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/settings.ts` | Added `verbose: z.boolean()` with default `false` |
| `packages/happy-app/sources/components/MessageView.tsx` | Import `useSetting`; read `verbose` setting; show thinking when enabled with `opacity: 0.35` |
| `packages/happy-app/sources/app/(app)/settings/features.tsx` | Added verbose toggle with `useSettingMutable('verbose')` |
| `packages/happy-app/sources/text/_default.ts` | Added `verbose` and `verboseSubtitle` i18n keys |
| Translation files (10: en, ru, zh-Hans, zh-Hant, ja, es, pt, it, pl, ca) | Added `verbose` and `verboseSubtitle` translations |

### Deployment

Only `happy-app` needs redeployment. The thinking content pipeline (CLI → wire → server) is unchanged.

---

## 9. Send Historical Messages When Resuming Session on Remote

### Problem

When a user resumes a session directly on the remote client (without sending an initial message), historical messages were not displayed. This occurred because the drain turn suppresses all `onMessage` calls to prevent "PONG" from leaking to the mobile app. As a result, users would see an empty conversation history when resuming.

### Root cause

The `isResumeWithoutPrompt` path (when `startFrom` is set and `initial.message` is empty) triggers a drain turn immediately:

1. `isDrainTurn = true` → `suppressDrainMessages = true`
2. DRAIN_MESSAGE sent to Claude → Claude responds "PONG"
3. All messages during drain are suppressed by `suppressDrainMessages` gate
4. Historical messages are never sent to the client

### Design

Added `onResumeHistory` callback to `claudeRemote` options, invoked **before** the drain turn starts when `isResumeWithoutPrompt = true`. The callback:

1. Reads the original session JSONL file using `readSessionLog(projectDir, resumeSessionId)`
2. Sends all historical messages to the client via `session.client.sendClaudeSessionMessage(msg)`
3. Closes the session turn with `session.client.closeClaudeSessionTurn('completed')` if any messages were sent

Since this happens **before** `suppressDrainMessages` is set, the historical messages bypass the suppression gate and appear in the client UI.

### Data flow

```
claudeRemote detects isResumeWithoutPrompt
  → calls opts.onResumeHistory(startFrom) if provided
    → claudeRemoteLauncher reads original session JSONL
    → sends NormalizedMessage[] to client (visible immediately)
    → closes turn to signal end of history
  → then sets suppressDrainMessages = true
  → pushes DRAIN_MESSAGE (suppressed, not sent to client)
  → Claude responds "PONG" (also suppressed)
  → suppressDrainMessages = false after drain completes
  → normal conversation resumes with full history context
```

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/claudeRemote.ts` | Added `onResumeHistory?: (resumeSessionId: string) => Promise<void>` callback option; invoked before drain turn if `isResumeWithoutPrompt && startFrom` |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Implemented `onResumeHistory` callback: reads session log with `readSessionLog()`, sends historical messages to client, closes turn if any messages sent; imports `readSessionLog` and `getProjectPath` |
| `packages/happy-cli/src/claude/utils/sessionScanner.ts` | Minor change (function signature update for session reading) |

---

## 10. Drain Mechanism E2E Testing Tools

### Problem

The drain mechanism (background task notification delivery) had multiple bugs that were hard to catch without end-to-end testing: message offset when task_notification arrived before user message processing, PONG leaking into webapp, and blocking behavior that prevented async workflows.

### Design

A suite of E2E test scripts that spawn daemon sessions, send encrypted messages via the server API, poll for responses, and verify correct behavior. Scripts also support abort testing via Socket.IO RPC.

| Script | Purpose |
|---|---|
| `register-local.mjs` | Register test credentials with local server (backs up existing credentials) |
| `drain-bg-task-e2e.mjs` | Test background task notification delivery: single task + 3 concurrent tasks |
| `drain-resume-abort-e2e.mjs` | Test drain during abort/resume scenarios via Socket.IO abort RPC |
| `drain-offset-test.mjs` | Targeted reproduction of the message offset bug (bg task completes → user sends message → verify response order) |

All scripts check for PONG/DRAIN message leaks and report violations.

### Files

| File | Description |
|---|---|
| `packages/happy-cli/scripts/register-local.mjs` | Test credential registration with backup protection |
| `packages/happy-cli/scripts/drain-bg-task-e2e.mjs` | Background task drain E2E test |
| `packages/happy-cli/scripts/drain-resume-abort-e2e.mjs` | Resume & abort drain E2E test |
| `packages/happy-cli/scripts/drain-offset-test.mjs` | Message offset bug reproduction test |

### Usage

```bash
# Start local server first, then:
cd packages/happy-cli
HAPPY_SERVER_URL=http://localhost:3005 node scripts/register-local.mjs
HAPPY_SERVER_URL=http://localhost:3005 ./bin/happy.mjs daemon start
APPLE_CLAUDE_CODE_PORT=3111 HAPPY_SERVER_URL=http://localhost:3005 node scripts/drain-bg-task-e2e.mjs
# Restore credentials after testing:
cp ~/.happy/access.key.bak ~/.happy/access.key
```
