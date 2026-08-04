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

---

## 4. Rename Session from the Webapp

### Problem

Sessions could only be identified by their auto-generated summary. There was no way to set a custom title from the webapp — the only related event in the app, `'renamed'`, was consumed by the storage layer but had no UI surface that produced it.

### Design

A generic `sessionUpdateMetadata(sessionId, updater, expectedVersion)` op encrypts the new metadata, ships it via the existing `update-metadata` socket event (already implemented server-side, mirroring `machine-update-metadata`), and handles version mismatches by:

1. Reading the server's latest encrypted metadata returned in the `version-mismatch` response.
2. Decrypting it, applying it to the store as the new base.
3. Re-running the supplied `updater` so the user-intended fields (in this case `summary`) are merged on top.
4. Retrying — up to 3 times — before surfacing the error.

The rename UI is intentionally minimal: a `Modal.prompt` returning the new title, then `sessionUpdateMetadata(id, m => ({ ...m, summary: { text, updatedAt: now } }), session.metadataVersion)`.

### UI surfaces

| Surface | Trigger |
|---|---|
| Session info page header | Tap the session name |
| Session info page → Quick Actions | "Rename Session" item with pencil icon |

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/ops.ts` | New `sessionUpdateMetadata` with optimistic concurrency + retry. Imports `Metadata`. |
| `packages/happy-app/sources/app/(app)/session/[id]/info.tsx` | Adds `handleRenameSession` callback. Wraps the session-name `<Text>` in a `<Pressable>`. Adds a Quick Actions item before "View Machine". |
| `packages/happy-app/sources/text/_default.ts` and 10 translation files | Adds `renameSession`, `renameSessionPrompt`, `renameSessionPlaceholder`, `renameSessionSubtitle`. |

### Notes / deviations from upstream commit `7b9e95d6`

- The fork commit also touched `SessionsList.tsx` to "remove a broken long-press handler". Upstream already has a working `onLongPress: showActionAlert` on session items, so we leave that path alone.
- `Modal.prompt` and `apiSocket.emitWithAck` are the same primitives already used by other update flows (e.g. `machine-update-metadata` for renaming machines), so no new infra.

---

## 5. Integrated Remote Terminal with Encrypted PTY Streaming

### Problem

Users have no way to run shell commands on the remote machine from the webapp. The only option is to ask Claude to execute commands, adding latency and lacking true interactive terminal experience (readline, cursor movement, ncurses apps).

### Design

End-to-end encrypted terminal feature spanning all four packages:

| Layer | Component | Role |
|---|---|---|
| Wire | `terminalProtocol.ts` | Zod schemas for RPC methods (create/attach/resize/destroy/list), event types (input/output), and constants |
| CLI | `terminalHandler.ts` | Registers RPC handlers; segments output for large payloads |
| CLI | `ptyProvider.ts` | Manages PTY lifecycle (spawn/write/resize/destroy); per-terminal `CircularBuffer` for reattach replay |
| CLI | `circularBuffer.ts` | Fixed-size ring buffer storing recent output chunks |
| Server | `socket/terminalHandler.ts` | Routes encrypted terminal events between app and daemon Socket.IO rooms |
| App | `Terminal.web.tsx` | xterm.js integration with FitAddon, dark/light themes, resize observer |
| App | `TerminalPanel.tsx` | Panel chrome with connection status dot and close button |

#### Key features

- **Encrypted streaming**: All I/O flows through the same encrypted event channel as chat (new `sendEncryptedSessionEvent` / `onEncryptedSessionEvent` on both app and CLI sides)
- **PTY persistence**: Terminal survives panel hide/show; `attach` replays `CircularBuffer`
- **Reattach on reconnect**: Socket reconnection auto-reattaches
- **Segmented output**: Large output chunked to avoid socket frame limits
- **Terminal response filtering**: Strips xterm query responses (DA1, CPR, etc.) from input to prevent echo loops
- **Keyboard shortcut**: Ctrl+` toggles the terminal panel (web only)

### Files changed

| File | Change |
|---|---|
| `packages/happy-wire/src/terminalProtocol.ts` | **New.** Zod schemas + constants |
| `packages/happy-wire/src/terminalProtocol.test.ts` | **New.** Schema validation tests |
| `packages/happy-wire/src/index.ts` | Re-export terminal protocol |
| `packages/happy-cli/src/modules/terminal/terminalHandler.ts` | **New.** RPC handler registration |
| `packages/happy-cli/src/modules/terminal/ptyProvider.ts` | **New.** PTY lifecycle + CircularBuffer |
| `packages/happy-cli/src/modules/terminal/circularBuffer.ts` | **New.** Ring buffer |
| `packages/happy-cli/src/modules/terminal/circularBuffer.test.ts` | **New.** Unit tests |
| `packages/happy-cli/src/modules/terminal/ptyProvider.test.ts` | **New.** Unit tests |
| `packages/happy-cli/tests/terminal-benchmark.ts` | **New.** Performance benchmark |
| `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts` | Adds `emitEncryptedEvent`, `onEncryptedEvent`, `offEncryptedEvent`, `attachEventListener` for bidirectional encrypted event streaming |
| `packages/happy-cli/src/api/apiSession.ts` | Registers terminal handlers on connect; destroys terminals on close |
| `packages/happy-cli/package.json` | Adds `node-pty` dependency |
| `packages/happy-server/sources/app/api/socket/terminalHandler.ts` | **New.** Server-side event routing |
| `packages/happy-server/sources/app/api/socket.ts` | Integrates terminal handler |
| `packages/happy-app/sources/components/terminal/Terminal.web.tsx` | **New.** xterm.js with encrypted I/O + reattach |
| `packages/happy-app/sources/components/terminal/Terminal.tsx` | **New.** Native stub (returns null) |
| `packages/happy-app/sources/components/terminal/TerminalPanel.tsx` | **New.** Panel with status indicator |
| `packages/happy-app/sources/-session/SessionView.tsx` | Terminal state, Ctrl+` shortcut, TerminalPanel render |
| `packages/happy-app/sources/components/AgentInput.tsx` | Terminal toggle button (web only) |
| `packages/happy-app/sources/sync/apiSocket.ts` | `sendEncryptedSessionEvent`, `onEncryptedSessionEvent`, `attachEncryptedListeners`, each serialized through the sequencer |
| `packages/happy-app/sources/sync/asyncSequencer.ts` | **New.** `createAsyncSequencer()` — per-key FIFO across the async crypto boundary |
| `packages/happy-app/sources/sync/asyncSequencer.test.ts` | **New.** Ordering / independence / throw-recovery tests |
| `packages/happy-app/package.json` | Adds xterm dependencies |

### Ordering: encrypted I/O is serialized end to end

#### Why the I/O is serialized

In the integrated web terminal, pasting text such as `echo "happy"` intermittently rendered **scrambled** — e.g. `ehappy"` or `e"pp`, differently each time, and sometimes correctly. Command output was equally unstable: the same `echo "happy"` printed its result at the end of the line, on a new line, or not visibly at all.

#### The reordering hazard

Terminal I/O is end-to-end encrypted per session with `AES256Encryption`, whose `rn-encryption` encrypt/decrypt calls are genuinely asynchronous (native / WebCrypto-style). In `packages/happy-app/sources/sync/apiSocket.ts`:

- **Output** — `attachEncryptedListeners` registered an `async` `socket.on` handler that did `await enc.decryptRaw(msg.data)` per packet with no serialization. socket.io delivers packets in order, but two decrypts that *start* in order can *finish* out of order; whichever resolved first called `terminal.write()` first. Because zsh (zle / syntax highlighting) redraws the whole line with cursor-control escapes on every keystroke, a single paste produces many small `terminal:output` chunks — reordering them scrambles the line and misplaces the command output.
- **Input** — `sendEncryptedSessionEvent` had the same shape (`await enc.encryptRaw(data)` then emit), so fast-typed / multi-event paste input could reorder before reaching the PTY.

The CLI side was already ordered (synchronous decrypt on receive, FIFO flush queue on send), so the defect was entirely at the app's async-crypto boundary. These two methods are used **only** by the terminal.

#### The sequencer

Add `createAsyncSequencer()` — a per-key FIFO chain that guarantees tasks run *and complete* in enqueue order, even when the async work inside resolves out of order. Each task is chained onto the tail of the previous one for the same key using microtasks only (no `setTimeout` hop), so it adds no latency to a high-throughput stream.

Wire it into both `apiSocket` paths, keyed by `(event, session)`:

- **Send:** serialize `encrypt → emit`.
- **Receive:** the `socket.on` handler is now synchronous and enqueues `decrypt → dispatch`, capturing socket.io's receipt order at enqueue time.

#### Notes

- One root-cause change fixes both reported symptoms: the paste scramble and the unstable output position are the same reordered `terminal:output` stream.
- `terminal:output` and `terminal:closed` remain independently keyed; strict output-before-`[process exited]` ordering at process exit is not enforced (cosmetic, unchanged from before).

### Deployment

All three deployable units need updates: CLI (daemon), server, and app.

### Notes

- Port of fork commits `8862681a` (terminal) and `d17a975e` (I/O ordering). The former included massive SessionView/AgentInput rewrites (6000+ LOC) that were mostly reformatting — we integrated surgically on the current baseline instead.
- `node-pty` is a native module requiring build tools (python3/make/g++) — the `Dockerfile.webapp` may need Alpine deps added if building in Docker (see commit `5d992d7a`).
- Terminal toggle button is web-only (native doesn't have xterm.js).

---

## 6. Copy Markdown Source via Right-Click on Web

### Problem

The "copy full markdown source" feature (gated behind the `markdownCopyV2` local setting) only works on native (iOS/Android): a long-press opens the `/text-selection` modal. Web had no equivalent trigger — the web branch simply returned the plain content with no gesture and no context-menu handler — so web users could not copy the raw markdown, only the browser-native selection of the *rendered* text.

### Design

Add a web-only right-click (context menu) handler to `MarkdownView` that copies the full markdown source straight to the clipboard.

| Aspect | Behavior |
|---|---|
| Trigger | `onContextMenu` (right-click) on the markdown container, web only |
| Action | `Clipboard.setStringAsync(props.markdown)` → success/failure `Modal.alert` (reuses `textSelection.textCopied` / `textSelection.failedToCopy`) |
| Selection avoidance | If `window.getSelection()` is non-empty, the handler bails out and lets the browser's native menu appear, so users can still copy just their selected portion |
| Gating | Kept behind the existing `markdownCopyV2` local setting, consistent with the native long-press flow (per-device setting; must be enabled on web) |

Native long-press behavior is untouched. `onContextMenu` is a web-only DOM prop forwarded by react-native-web, passed via an `as any` spread to avoid the RN `View` type not declaring it.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/markdown/MarkdownView.tsx` | Adds `copyMarkdownToClipboard` callback; the `Platform.OS === 'web'` branch (still after the `markdownCopyV2` check) now wraps content in a `View` with an `onContextMenu` handler that copies the source when there is no active text selection. |

### Notes

- `markdownCopyV2` is a **per-device** `useLocalSetting` (default off) — it does not sync from iOS, so it must be toggled on in the web app's settings for the right-click to activate.
- Web is a static SPA export (`web.output: "single"`); shipping this only requires rebuilding/redeploying the web bundle — no CLI or server changes.

---

## 7. Custom Model Names in the Model Picker

### Problem

Upstream persists and restores the selected model + effort per session (via `useNewSessionDraft` + `findPreferredModeIndex`), but only for models that appear in the hardcoded list (`getHardcodedModelModes` / `getAvailableModels`). There is no way to point a session at an arbitrary model string (e.g. a dated snapshot like `claude-opus-4-8`, a `[1m]` variant, or an internal alias), and a persisted custom name could never be restored because `findPreferredModeIndex` / `resolveCurrentOption` can only match keys present in the list.

### Design

Add a small, self-contained helper set to `modelModeOptions.ts`:

- `CUSTOM_MODEL_KEY` (`'__custom__'`) — the sentinel key for the "custom…" row.
- `withCustomModelOption(models, currentKey)` — returns a new array that (a) prepends a synthetic entry for `currentKey` when it isn't already in the list, so a persisted custom name shows up as the selected row, and (b) always appends the `custom…` sentinel so the user can enter a new name. Pure/immutable — it copies the input.

Both model pickers are augmented through this helper:

- **New-session screen (`new/index.tsx`)** — a `customModelName` state feeds `withCustomModelOption`. Selecting `custom…` opens `Modal.prompt`; the entered name is stored in the draft (`draft.setModelMode`) so upstream's existing restore path picks it up. A mount-once effect re-injects a persisted custom name from the draft (guarded by a ref) so `findPreferredModeIndex` can match it. Picking a real model afterwards drops the synthetic row. `showModel` is computed from the **base** list so the picker's visibility is unchanged.
- **Active session (`SessionView.tsx` → `SessionStatusBar` model menu)** — `availableModels` is wrapped with `withCustomModelOption(..., session.modelMode)`, and `updateModelMode` prompts for a name when the `custom…` row is chosen, then persists it via `sessionSetAgentModes`.

### Notes / deviations

- Replaces the custom-model portion of fork commit `20de6ad1` (the rest of that commit — Context HUD, model badge, usage telemetry, dynamic context window — is now provided by upstream `#1463` / `#1561` and was dropped).
- Subsumes fork commit `42fab385` ("persist custom model and effort selection"): upstream already persists/restores model + effort for listed models, so only the custom-name gap remained, which this section closes.

### Files changed

- `packages/happy-app/sources/components/modelModeOptions.ts` — `CUSTOM_MODEL_KEY`, `withCustomModelOption`.
- `packages/happy-app/sources/app/(app)/new/index.tsx` — custom option + prompt + persisted-name restore in the new-session picker.
- `packages/happy-app/sources/-session/SessionView.tsx` — custom option + prompt in the active-session model menu.
- `packages/happy-app/sources/text/_default.ts` + all `translations/*.ts` — `newSession.customModel{Title,Description,Placeholder}`.

---

## 8. Floodgate Quota Badge and Context Used / Total in the Composer Status Row

### Problem

Two gaps in the composer status row:

1. Apple-internal users bill Claude usage against a Floodgate budget (personal or per-project). There was no in-app visibility into how much of that budget a session has consumed, and no way to switch which project a machine's sessions bill to.
2. The row showed only "% left" for context — never the absolute numbers behind it. On a 1M session, "% left" alone hides whether the window is 200K or 1M.

Both land together because they share one row, and laying that row out is the same problem for both.

### Design — Floodgate quota

A machine-scoped project token drives everything, and a per-session quota sample is surfaced in the status row.

**CLI**

- `utils/quota.ts` — `fetchQuota()` performs an mTLS GET against the internal Floodgate usage API using cert files under `~/.person/`, honouring the `FLOODGATE_PROJECT_TOKEN` env var. Returns `{ spend, budget, fetchedAt, isProject?, projectName? }`, or `null` (silent) when the certs are absent so non-Apple environments are unaffected.
- `utils/floodgateProject.ts` — read/write the machine-scoped project token + cached name, persisted in the multi-process-locked settings file so every session process shares one source of truth.
- `runClaude.ts` — a 60s interval (plus an immediate first fetch) calls `fetchQuota()` and pushes the result onto session metadata (`session.updateMetadata((m) => ({ ...m, quota }))`); the interval is cleared on cleanup.
- `claudeLocal.ts` / `claudeRemote.ts` — apply the machine-scoped token fresh before every turn's spawn so the spawned child inherits the current project (or personal quota when cleared). The local PTY launcher builds it into the child env directly; the remote SDK path calls `applyFloodgateProjectTokenToEnv()` before each `query()`. `claudeRemoteLauncher.ts` additionally forces a re-spawn (detected via `floodgateProjectTokenChanged()`) when the token changes between turns, so switching project takes effect on the very next message even in a long-lived streaming session — context is preserved across the re-spawn via `--resume`.
- `apiMachine.ts` — `set-floodgate-project` / `get-floodgate-project` RPC handlers; setting a token best-effort resolves the project name and reflects it in machine metadata.

**App**

- `Metadata.quota` schema (`storageTypes.ts`) + `MachineMetadata.floodgateProjectName`.
- `ops.ts` — `machineSetFloodgateProject` / `machineGetFloodgateProject` RPC wrappers.
- `machine/[id].tsx` — a "Floodgate Project" group showing the active project and a "Switch Project" action (prompts for a token, applies it machine-wide).
- `AgentInput.tsx` — the status row renders `$spend/$budget` (colour-escalating as the budget fills) followed by the project name. `SessionView` passes `session.metadata?.quota` through.

### Design — context used / total

The same row renders a compact `used/total` readout (e.g. `180k/1M`) immediately after the "% left" text and before the quota; `formatTokens` renders the k/M suffixes.

The readout is **gated on a known context window**, matching the rule upstream established in `#1561`: until the session reports its real window there is no honest denominator, and a guessed total makes the number jump when the real window arrives. `usageData.contextWindow` is upstream's value, read per model off `SDKResultMessage.modelUsage` — we do not infer it from the model name.

Layout: on the crowded mobile row, the connection status, "% left", `used/total` and `$spend/$budget` are each pinned to a single line and never shrink; the Floodgate project name is the only element allowed to truncate (a separate `flexShrink` text after the budget), so the budget stays visible and a long project name can't collapse the row.

### Notes / deviations

- Extracted from the Floodgate portion of fork commit `20de6ad1`. The rest of that commit — usage telemetry, Context HUD, model badge, dynamic context window — is now provided by upstream `#1463` / `#1561` and was dropped, so the quota value rides upstream's existing encrypted-metadata sync and both readouts sit in upstream's own composer status row.
- The quota chip renders inside `AgentInput`'s status row rather than `SessionStatusBar`, so it is visible without opting into the (default-hidden) status bar.

### Files changed

- CLI: `utils/quota.ts`, `utils/floodgateProject.ts` (+ test), `persistence.ts`, `api/types.ts`, `api/apiMachine.ts`, `claude/claudeLocal.ts`, `claude/claudeRemote.ts`, `claude/claudeRemoteLauncher.ts`, `claude/runClaude.ts`.
- App: `components/AgentInput.tsx` (`quota` + `contextUsage` on the status row, `formatTokens`, `formatQuotaBudget`, `getQuotaColor`), `sync/storageTypes.ts`, `sync/ops.ts`, `app/(app)/machine/[id].tsx`, `-session/SessionView.tsx`, `text/_default.ts` + all `translations/*.ts`.
