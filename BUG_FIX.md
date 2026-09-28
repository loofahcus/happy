# Bug Fixes — Implementation Notes

This document records each bug fix we implement on top of `upstream/main`, including the root cause, the fix design, and the files changed.

---

## 1. Expo Web HMR: Empty-Path Bundle URL Crashes Dev Server

### Problem

Running `pnpm start --web` (Expo SDK 54), the Metro dev server crashes with an unhandled rejection as soon as a browser opens the root URL:

```
Error: The given URL "http://localhost:3006/?platform=web" has an empty path
and cannot be converted to a JSC-safe format.
    at Object.toJscSafeUrl (.../jsc-safe-url/index.js:74:11)
    at parseBundleOptionsFromBundleRequestUrl (.../metro/src/lib/parseBundleOptionsFromBundleRequestUrl.js:88:32)
    at HmrServer._registerEntryPoint (.../metro/src/HmrServer.js:85:53)
```

Clearing browser cache, restarting with `--clear`, and reopening tabs do not help — the error reproduces on every fresh connection.

### Root Cause

In `node_modules/expo/src/async-require/getFullBundlerUrl.ts` (web HMR client):

```ts
const currentScript = document?.currentScript;
const bundleUrl = new URL(
  currentScript && 'src' in currentScript ? currentScript.src : location.href,
  location.href
);
```

`document.currentScript` is `null` whenever the script is loaded as a module (`<script type="module">`) or asynchronously — the norm in modern Expo web setups. The code then falls back to `location.href`. When the user is browsing the dev server root (`http://localhost:3006/`), the resulting "bundle URL" is `http://localhost:3006/?platform=web` — a URL with an **empty path but non-empty query**. Metro's HmrServer passes it to `jsc-safe-url`, which rejects empty paths and throws synchronously inside an `async` `_registerEntryPoint`. The rejection is unhandled and kills the dev server process.

### Design

Patch `getFullBundlerUrl.ts` so that when `currentScript` is unavailable, we look for an existing `<script src="…bundle…">` tag in the DOM (Expo CLI injects one with the correct monorepo-aware path such as `/packages/happy-app/index.bundle?platform=web`). Only fall back to `location.href` as a last resort.

We deliberately do **not** hardcode a path like `/index.bundle`: in this monorepo Metro's `unstable_serverRoot` is the workspace root, so the real entry path is `/packages/happy-app/index.bundle`, which differs per app.

### Mechanism

The repo already uses idempotent `.cjs` patch scripts under `patches/` applied via `scripts/postinstall.cjs`. We follow the same pattern so the fix survives `pnpm install` and is shared via git.

### Files Changed

| File | Change |
|------|--------|
| `patches/fix-expo-web-hmr-empty-path.cjs` | New idempotent patch script that rewrites `node_modules/expo/src/async-require/getFullBundlerUrl.ts` (covers both `node_modules/` roots in the workspace) |
| `scripts/postinstall.cjs` | Register the new patch script in the postinstall chain |

### Notes

- Long-term fix is an upstream PR to `expo/expo`; this patch is a local workaround.
- Only the web HMR path is affected — native iOS/Android builds use `hmrUtils.native.ts` and are untouched.

---

## 2. 1M Context Window Never Actually Enabled in Remote Mode

### Problem

Opus is natively a 1M-token model, and the `/model` picker also offers explicit `[1m]` variants of other models. But in remote mode the Claude Agent SDK defaults to a 200K window: without the `context-1m-2025-08-07` beta header a `[1m]` selection never actually got 1M, so long sessions auto-compacted prematurely.

### Fix

Thread a `betas` option through the SDK adapter and set the 1M beta when the active model warrants it.

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/sdk/types.ts` | Add `betas?: string[]` to `QueryOptions`. |
| `packages/happy-cli/src/claude/sdk/query.ts` | Import `type SdkBeta`; pass `betas: opts?.betas as SdkBeta[]` into the SDK call. |
| `packages/happy-cli/src/claude/claudeRemote.ts` | Set `betas: ['context-1m-2025-08-07']` when `initial.mode.model` is an Opus model or contains `[1m]`. Opus is sent the beta explicitly rather than assuming a native 1M window; the header is harmless for models that don't need it. |

### Scope: enablement only, not display

An earlier version of this fix also resolved the window **app-side** for display, because the Anthropic `usage` payload carries no `context_window` and the Claude protocol mapper never synthesised one — so the indicator measured against a hardcoded 200K even on a genuine 1M session. Upstream has since fixed that properly in `#1561`: `sdkToLogConverter` records the real per-model window off `SDKResultMessage.modelUsage` and stamps it onto subsequent usage, and the app hides the indicator until the window is known. That is strictly better than our model-name heuristic, since the same model ID maps to different windows depending on the account. Our display half was dropped in favour of upstream's; only the enablement half — which upstream does not do at all — is kept here.

### Deviation from fork commit `45f41ba5`

The original fork forced 1M for any Opus/Sonnet via `/opus|sonnet/i`; we enable it for Opus and any explicit `[1m]` selection, so standard Sonnet/Haiku stay 200K.

---

## 3. Session-List Cache Silently Stopped Working After the Avatar Rebase

### Problem

Users reported that the session-list cold-start cache (section 3) "stopped working" after an upstream rebase: the sidebar went back to painting blank while `fetchSessions` round-tripped, instead of instantly showing the last-known list.

### Root Cause

`saveCachedSessions` (`sessionsCache.ts`) never stripped `session.avatar` before serializing sessions into the single MMKV key backing this cache. `avatar` is a materialized data URI — the full decrypted avatar image, base64-encoded, up to ~13MB (`MAX_BYTES = 10MB` raw in `sessionAvatars.ts`) — a capability upstream added (`37e94799`, `eb482897`, `38251304`) in the same round of commits this fork rebased onto.

On web, MMKV is backed by `localStorage` (~5MB per origin, shared with the message cache and everything else `persistence.ts` writes). Once enough sessions in the list carried a materialized avatar, `mmkv.set` threw `QuotaExceededError`, and `saveCachedSessions`'s catch block — by design, per section 3's original notes — deleted the entire cache rather than partially writing it. The next cold start then found no cache at all, which reads exactly like "the cache stopped working," because on every subsequent app run the immediately-prior save had already wiped it.

### Fix

Strip `avatar` from the cached payload; keep `avatarDescriptor` (a few KB at most — `ref`/`preview`/`version`). The descriptor alone is enough for `sessionAvatars.refresh()` to redecode the image in the background after hydrate, the same path a cold, uncached load already takes. The sidebar now paints instantly with placeholder avatars that fill in a moment later, instead of not painting at all.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/sessionsCache.ts` | `saveCachedSessions` also destructures out `avatar` before spreading the rest into the cached row. |
| `packages/happy-app/sources/sync/sessionsCache.test.ts` | **New.** Reproduces the quota failure with a realistic avatar-bearing session list (100 sessions × ~80KB decrypted avatar, plus simulated contention from other MMKV consumers) and asserts the cache still round-trips. |

### Notes

- This is the first regression test this cache has had since it was introduced in section 3.
- Same rebase also surfaced two smaller, related test-mock gaps in this cache's own test files (section 4) and a separate behavioral bug in `claudeRemote.ts` (section 14) — both caught by running the *full* test suite instead of only the targeted tests touched by each conflict resolution.

---

## 4. Sync Test Harnesses Didn't Know About the Message Cache

### Problem

After adding the local message cache (section 3), four existing test files failed with `ReferenceError` instead of running their assertions: `sync.history.spec.ts`, `sync.receipts.spec.ts` (both extract `Sync` class methods by source text into an isolated `new Function(...)` harness with an explicit dependency allowlist), and `sync.preload.test.ts` / `sync.send.test.ts` (both mock every import of `sync.ts` directly).

### Root Cause

None of the four knew about `loadMessageCache`/`appendMessageCache` — fork additions that landed in `sync.ts` after these test files' mock/allowlist surfaces were last touched. `sync.history.spec.ts`'s allowlist-based harness threw `loadMessageCache is not defined` the moment a whitelisted method that now calls it actually ran.

### Fix

Add the missing mock/allowlist entries, matching each file's existing pattern exactly — no-op mocks for the cache reads/writes (`loadMessageCache`/`loadCachedSessions` return `null`; the rest are `vi.fn()`).

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/sync.history.spec.ts` | Injects `loadMessageCache`/`appendMessageCache` into the compiled harness. |
| `packages/happy-app/sources/sync/sync.receipts.spec.ts` | Same, via the raw `new Function(...)` call. |
| `packages/happy-app/sources/sync/sync.preload.test.ts` | `vi.mock`s `@/sync/messageCache` and `@/sync/sessionsCache`. |
| `packages/happy-app/sources/sync/sync.send.test.ts` | Same. |

### Notes

- These four files weren't touched by any rebase conflict — they applied cleanly, so nothing flagged them during conflict resolution. They only surfaced by running the package's *full* test suite as a separate verification pass, not just the tests for files a conflict actually touched.
- The terminal feature (`NEW_FEATURES.md` section 5) has the same class of gap in a different test file — see section 7.

---

## 5. React "Cannot read properties of null (reading 'useContext')" via Duplicate React Instance

### Problem

In local web development the webapp intermittently crashed at the top-level error boundary with:

```
Something went wrong
Error: Cannot read properties of null (reading 'useContext')
```

It was reproducible after a Metro `--clear` rebuild, and went away with hard refresh + incognito — i.e. the classic "two copies of React" failure mode where the second React's `__internals.ReactCurrentDispatcher.current` is `null`.

### Root Cause

`@pierre/diffs` is bundled by Metro as its own chunk (visible in dev-server output: `Web Bundled … node_modules/@pierre/diffs/dist/index.js (216 modules)` and a sibling `…/dist/react/index.js (226 modules)`). Inside that chunk Metro re-resolves `react` against the package's nested `node_modules`, producing a second physical `react.js` module. When `@pierre/diffs` then renders into the same React tree as the app, hooks like `useContext` are dispatched on the second React's null-initialised dispatcher, blowing up.

The repo had already pinned `preact` and `preact/hooks` to a single CJS path for the same class of bug (see header comment in `metro.config.js`, fork commit `force-preact-cjs.cjs`). React was missing from that pinning.

### Fix

Extend the existing `config.resolver.resolveRequest` shim in `metro.config.js` to also pin `react`, `react-dom`, `react/jsx-runtime`, and `react/jsx-dev-runtime` to the app workspace's single resolved file. Anything that imports those module names — including `@pierre/diffs`'s nested chunk — now lands on the same physical module as the app shell, so `ReactCurrentDispatcher` is shared.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/metro.config.js` | Resolves `react`, `react-dom`, and the two JSX runtimes via `require.resolve` once at config load time and short-circuits matching `moduleName` lookups in `resolver.resolveRequest`. |

### Notes

- Requires a Metro restart (`pnpm start --clear`) — `metro.config.js` is read once on dev-server boot, HMR will not pick up the change.
- The same shape of fix can be reused for any future package that ships its own React copy.

---

## 6. Markdown Images Render as Gray Boxes on Web

### Problem

Images embedded in markdown messages (`![](path/to/image.png)`) renders as a fully gray placeholder on the webapp. Both server-side absolute paths and locally referenced images are affected. The RN `<Image>` component does not surface any error — it silently produces a gray rectangle.

### Root Cause

Two compounding issues in `MarkdownView.RenderImageBlock`:

1. **RN `<Image>` on web does not reliably render base64 data URIs nor `file://` paths.** When a markdown URL is anything except an `http(s)://` web asset, the upstream code passed it straight into `<Image source={{ uri }}>`, which on the React Native Web build resolves to an `<img>` element with malformed `src` and renders the gray default background.
2. **No RPC bridge to fetch the file.** Even when the URL is a local path the agent wrote (e.g. `./screenshot.png`), there was no code path to actually read it from the machine the session is running on. The webapp has no filesystem.

### Fix

Rewrite `RenderImageBlock` to:

| Step | Behaviour |
|---|---|
| Detect non-web URL | `isLocalFilePath()` — anything that isn't `http(s)`, `data:`, or `blob:` |
| Fetch via existing RPC | `sessionReadFile(sessionId, url)` returns base64; we wrap it in `data:<mime>;base64,…` using the file extension to pick the MIME type |
| Render correctly | On **web**, use the native `<img>` element via `React.createElement('img', …)`. On native platforms, keep RN `<Image>`. Both have `onError` handlers that surface a fallback caption |
| Loading + error states | Show `ActivityIndicator` while fetching; show "⚠ Image failed to load — <path>" caption on failure |

`sessionReadFile` and the `MarkdownView`'s optional `sessionId` prop already existed upstream — the missing piece was wiring them through `<RenderImageBlock>` and bypassing RN `<Image>` on web.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/markdown/MarkdownView.tsx` | Adds `ActivityIndicator` + `sessionReadFile` imports; passes `sessionId` to `<RenderImageBlock>`; replaces the body with the fetch-aware version above. |

### Notes / scope

- Port of the **image-display portion** of fork commit `9bb4b079`. The other halves of that commit (large-payload base64/AES stack overflows, RPC retry, image upload picker fallback) are deferred — symptoms haven't been observed yet on this fork's deployment.

---

## 7. Terminal Feature Left an Existing Test's RPC Mock Dangling

### Problem

After adding terminal RPC handlers (`NEW_FEATURES.md` section 5), `apiSession.test.ts` failed with `TypeError: rpc.registerHandler is not a function` instead of running its assertions.

### Root Cause

The test's stub `RpcHandlerManager` mock — used to construct a real `ApiSessionClient` without native services — lacked a `registerHandler` method, since it was last touched before this fork added terminal support. `registerTerminalHandlers`, called unconditionally from `ApiSessionClient`'s constructor, threw the moment it tried to use it; `destroyAllTerminals`, called from `close()`, threw the same way for a separate batch of tests.

### Fix

Add `vi.mock('@/modules/terminal/terminalHandler', ...)` with no-op `registerTerminalHandlers`/`destroyAllTerminals`, matching the existing `vi.mock('@/modules/common/registerCommonHandlers', ...)` pattern already in the file.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/api/apiSession.test.ts` | `vi.mock`s `@/modules/terminal/terminalHandler` (`registerTerminalHandlers`, `destroyAllTerminals`). |

### Notes

- This file wasn't touched by any rebase conflict — it applied cleanly, so nothing flagged it during conflict resolution. It only surfaced by running the package's *full* test suite as a separate verification pass.
- The message/session cache (`NEW_FEATURES.md` section 3) has the same class of gap in four other sync test files — see section 4.

---

## 8. Terminal Input Failures Left No Trace

### Symptom

On a phone browser the terminal renders and streams output normally, but typing does nothing — with some third-party IMEs. The iOS system keyboard works. There was no way to tell where the keystroke went: the app has no reachable devtools on a phone, and the daemon logged nothing on the input path.

### Root cause of the blind spot

The input path crosses five boundaries — soft keyboard → xterm's helper textarea → xterm's `onData` → our response filter → socket → daemon → PTY — and none of them was observable:

1. **App side had no instrumentation at all.** `console.log` is not reachable on a phone, so even adding logs would not have helped.
2. **The daemon swallowed rejects silently.** `rpc.onEncryptedEvent(TERMINAL_EVENTS.input, ...)` called `terminalInputPayloadSchema.parse(raw)`, which *throws* on a malformed payload. The throw escaped into the socket.io listener, so a dropped keystroke produced neither a log line nor an error the user could see.

### Fix

**Observability where it can actually be read.** Opt in with `?termdebug=1`. Diagnostics are written into the xterm buffer itself rather than to the console, because the output path is known to work and is the one channel a phone can display. Each layer announces itself, so one session on the device says which boundary drops the keystroke:

| Layer | Marker |
|---|---|
| Browser → helper textarea | `keydown` (key + keyCode), `input` (value), `compositionstart/update/end`, `focus`/`blur` |
| xterm → us | `onData` with control bytes rendered readable (`a<0d>b`) |
| Response filter | whether it emptied the payload |
| Send | `sendEncryptedSessionEvent` resolved or rejected |
| Round trip | measured `echo rtt` in ms, stamped on send and read by the first output back |

`keyCode 229` on `keydown` is the Android composition key; seeing `input`/`composition*` without a following `onData` means xterm swallowed the keystroke, and seeing nothing at all means the focused element is not xterm's textarea.

**Stop losing keystrokes silently.** `safeParse` plus a debug log, and drop. Deliberately no per-keystroke success log — that would put file I/O on the echo path this feature is trying to keep fast.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/terminal/terminalKeys.ts` | **New.** `stripTerminalResponses` moved out of `Terminal.web.tsx` so it is testable without xterm, its CSS, or the socket layer; adds `describeBytes` for readable control bytes. |
| `packages/happy-app/sources/components/terminal/terminalKeys.test.ts` | **New.** Device-reply stripping, the arrow keys surviving it, and byte formatting. |
| `packages/happy-app/sources/components/terminal/Terminal.web.tsx` | `TERM_DEBUG` / `diag()`; textarea event listeners; `onData`, filter, and send markers; echo-RTT measurement. |
| `packages/happy-cli/src/modules/terminal/terminalHandler.ts` | `safeParse` + log instead of a throwing `parse`. |

### Notes / scope

- The regex is deliberately **case-sensitive** and a test pins it: the DA1 pattern ends in a lowercase `c`, so `ESC [ C` — the right-arrow key — must not match it. Adding an `i` flag would silently eat every right-arrow.
- The third-party IME failure itself is **not fixed here**; this commit only makes it diagnosable. The iOS system keyboard is a working workaround.

## 9. Flaky PTY Test: Fixed Sleeps Instead of the Actual Condition

### Symptom

`PtyProvider > fires onExit when process exits` fails intermittently with `expected false to be true` — a message that says nothing about what went wrong. Observed across a session: 3/3 failures in one sampling of the whole file, 1/3 in another, and 1/6 when run in isolation.

### Root cause

Three tests in `ptyProvider.test.ts` drive a real shell through a real pty, and every wait was a guess at how long that takes:

| Test | Guesses |
|---|---|
| `writes to terminal and receives echo` | 500 ms for the shell to come up, 500 ms for the echo |
| `buffers output for replay` | 300 ms, then 500 ms |
| `fires onExit when process exits` | 300 ms, then 2000 ms for the exit |

Those numbers held on an idle machine. They are violated exactly when the suite is under load — which is the normal case, since these tests run right after eight others that each spawn their own shell. The exit test was also boxed in by vitest's default 5 s test timeout, so its budget could not grow past 2.3 s without the runner killing it first.

The assertion made this worse: `expect(exited).toBe(true)` reports `expected false to be true`, which is indistinguishable from a genuine "onExit never fires" regression.

### Fix

Poll for the condition instead of guessing at its duration. A local `waitFor(description, condition)` polls every 10 ms up to 8 s and, on timeout, throws a message naming what it was waiting for. The per-test timeout is raised to 15 s so that message is what fails, rather than vitest's generic 5 s cutoff.

No fixed sleep remains, so there is no timing assumption left to violate. Two waits disappeared entirely:

- **"Wait for the shell to be ready" is unnecessary.** The tty buffers a write that arrives before the shell reads it, so writing immediately still produces the sentinel; the poll for the sentinel is the only thing that has to be correct.
- **The replay-buffer test now polls the buffer** rather than the `onData` callback. The buffer is what a reattaching client replays, so it is also what the test is about.

Faster as a side effect: the file drops from 4197 ms to 1846 ms, since roughly 3.6 s of it was sleeping.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/modules/terminal/ptyProvider.test.ts` | `waitFor()` helper; the echo, replay-buffer, and exit tests poll for their condition and carry an explicit 15 s timeout. |

### Notes / scope

- **Verification is honest but incomplete:** the original failure could not be reproduced deterministically. Under a constructed load (three concurrent suites plus a busy `tsc`) the *old* code passed 3/3, so that was not the trigger. The fix is therefore justified by removing the class of failure — there is no longer a duration being guessed — rather than by a red-to-green reproduction.
- After the fix: 6/6 sequential runs of the file, and 3/3 under the same concurrent load.
- `ptyProvider.ts` itself is untouched; this was only ever a test defect.

---

## 10. `node-pty` Native Build Silently Skipped by pnpm's Build-Script Gate

### Problem

`ptyProvider.test.ts` and any other code path that actually `require()`s `node-pty` at runtime fails with `Failed to load native module: pty.node, checked: build/Release, build/Debug, prebuilds/linux-x64`. `node-pty` ships prebuilt binaries only for darwin/win32; on Linux its `install` script must run `node-gyp rebuild` locally.

### Root Cause

pnpm 10 refuses to run a dependency's `install`/`postinstall` scripts unless that dependency is explicitly listed in `pnpm.onlyBuiltDependencies` (root `package.json`) or approved via `pnpm approve-builds`. `node-pty` was a real dependency again (`packages/happy-cli/package.json`) but the allowlist entry for it had been dropped in an unrelated earlier cleanup and never restored, so pnpm silently printed "Ignored build scripts: node-pty" instead of building it — no error, just a native module that's never there until something tries to `require` it.

### Fix

Add `"node-pty"` back to `pnpm.onlyBuiltDependencies` in the root `package.json`.

### Files changed

| File | Change |
|---|---|
| `package.json` | Added `"node-pty"` to `pnpm.onlyBuiltDependencies`. |

---

## 11. SDK Query Fails Under Apple Claude Code Auth

### Problem

Remote mode fails with "Invalid API key · Fix external API key" when running under Apple Claude Code.

### Root cause

Upstream switched the SDK wrapper from spawning a `claude` child process to calling the SDK in-process. The old spawn approach inherited Apple's auth environment (the Apple wrapper starts a local auth proxy and injects `ANTHROPIC_BASE_URL` into the child process). The new in-process approach bypasses the Apple wrapper entirely, so the SDK has no auth proxy URL and falls back to direct Anthropic API auth — which fails without a valid `ANTHROPIC_API_KEY`.

Additionally, the daemon process (which hosts remote sessions) is detached and does not inherit Apple's per-session env vars (`ANTHROPIC_BASE_URL`, `APPLE_CLAUDE_CODE_PORT`, etc.), so even passing `process.env` to the SDK doesn't help.

### Design

Two-part fix:

1. **Detect Apple Claude Code wrapper** (`appleAuth.ts`): Discover the Apple wrapper script (`@apple/claude-code/bin/cli.js`) by checking the npm global prefix or resolving the `claude` command. Result is cached after first lookup.

2. **Set `pathToClaudeCodeExecutable`** (`query.ts`): When the Apple wrapper is found, pass it to the SDK via `pathToClaudeCodeExecutable`. This makes the SDK spawn the wrapper as a child process (instead of running in-process), so the Apple wrapper starts its auth proxy and injects all necessary env vars — matching the behavior of the old spawn-based approach.

Also always pass `process.env` to `sdkOptions.env` (previously only set when MCP servers were present), as a baseline for non-Apple environments.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/sdk/appleAuth.ts` | **New file.** Discovers Apple Claude Code wrapper path from npm global prefix or `which claude` |
| `packages/happy-cli/src/claude/sdk/query.ts` | Always set `sdkOptions.env`; set `pathToClaudeCodeExecutable` when Apple wrapper is found |
| `packages/happy-cli/src/claude/sdk/types.ts` | Added `env` field to `QueryOptions` |

## 12. Web Right-Click Markdown Copy Silently Unreachable

### Symptom

Right-clicking a message in the web app no longer copies the markdown source. Nothing happens — the browser's own context menu appears as if the feature were never built.

### Root cause

The handler was gated on `markdownCopyV2`, and after the upstream rebase there is no way to turn that on:

1. It is a **per-device** `useLocalSetting`, default `false` — it does not sync from another device where it may have been enabled.
2. Its toggle lived in `settings/features.tsx`, which upstream **deleted** when it consolidated settings (`c82ef72f`, `e34e5922`).
3. The only surviving toggle is on the developer screen, and `SettingsView.tsx` renders the entry to it behind `__DEV__ || devModeEnabled`. On a production web build that is unreachable.

So the gate was permanently false. Our own commit chose that gate, so this is a self-inflicted regression exposed by the rebase, not an upstream removal.

### Fix

Web takes the right-click handler unconditionally, and the `markdownCopyV2` gate now applies only to the native long-press modal it was written for.

The gate was wrong on the merits too, which is why removing it rather than restoring a toggle is the right call. `markdownCopyV2` means "replace native paragraph selection with a long-press modal" — a trade that only exists on native. On web:

- `selectable` is already `Platform.OS === 'web' || …`, so native text selection is never disabled there;
- the handler returns early whenever `window.getSelection()` is non-empty, leaving the browser's menu alone.

It therefore cannot take anything away from ordinary selection copying. There is nothing to opt into, so there is no reason to ask.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/markdown/MarkdownView.tsx` | Web branch moved above the `markdownCopyV2` check; that check, plus `externalCopyHandler`, now guards only the native long-press path. |

### Notes

- Native behaviour is unchanged: the long-press modal still requires `markdownCopyV2`, and a parent that owns copy (`LongPressCopyable`) still suppresses it so only one gesture fires.
- The lesson worth keeping: gating a feature on a default-off setting is only safe while a reachable toggle exists. Upstream deleting the screen turned an opt-in into dead code with no test or type error to show for it.

---

## 13. Silent Session Stalls: 429 / API Errors Not Surfaced

### Symptom

After redeploying the latest build, sessions would sometimes stop mid-turn with **no error shown** in the app — the turn simply appeared to freeze or end. Older builds used to print the 429 (rate limit) error.

### Root cause

The bundled `@anthropic-ai/claude-agent-sdk` (0.3.167) surfaces API failures through two message shapes that `claudeRemote.ts` never handled:

1. **`system` / `api_retry`** (`SDKAPIRetryMessage`) — emitted before each backoff when a request fails with a retryable error (`error_status: 429`, `error: 'rate_limit'`, `attempt`/`max_retries`/`retry_delay_ms`). The message loop only handled `system` + `subtype: 'init'`, so every retry was dropped.
2. **`result`** (`SDKResultError` / `SDKResultSuccess` with `is_error: true`) — the terminal result once retries are exhausted. `SDKToLogConverter`'s `case 'result'` is an intentional no-op, and the result handler only called `onReady()` — it never inspected `is_error` / `api_error_status` / `subtype`. This is exactly the "runs halfway and stops with no error" case.

Both paths were swallowed, so a 429 (or billing / overloaded / server error) ended the turn silently.

### Fix

In `packages/happy-cli/src/claude/claudeRemote.ts`, surface both paths through the existing `onCompletionEvent` channel (which the launcher forwards as `sendSessionEvent({ type: 'message' })`, rendering as a visible message in the app — the same channel the transcript-missing warning uses):

- **Transient retries:** handle `system` + `subtype: 'api_retry'` → `⏳ rate limit (429) [rate_limit] — retrying 2/10 in 8s…`
- **Terminal errors:** in the `result` handler, when `is_error || subtype !== 'success'` → `⚠️ Turn stopped — rate limit (429). Please try again.` (or the error subtype + `errors[]` for non-API failures like `error_max_turns`).

A `labelApiStatus()` helper maps HTTP statuses to short labels, calling out **429 (rate limit)** explicitly while still surfacing 401/403/400/5xx/overloaded and any other status generically — so it is not limited to 429.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/claudeRemote.ts` | Added `labelApiStatus()` helper; handle `system/api_retry`; detect `is_error`/error-subtype results and emit a clear completion event |
| `packages/happy-cli/src/claude/sdk/types.ts` | Re-export `SDKAPIRetryMessage` from the SDK |
| `packages/happy-cli/src/claude/sdk/index.ts` | Re-export `SDKAPIRetryMessage` |
| `packages/happy-cli/src/claude/claudeRemote.test.ts` | Tests for api_retry surfacing, terminal 429 result, and error-subtype result |

---

## 14. Provider-Auth Detection and 429/Error Surfacing Fought Over the Same Result Message

### Problem

Two features that never coexisted before this rebase — our own `1e034c04` ("surface 429 and API errors instead of stalling silently") and upstream's `297004a1` ("explain expired Claude provider login") — both inspect every `result` message in `claudeRemote.ts`'s response loop. Combined, an auth-failure result fired `onCompletionEvent` twice, and an exhausted-429 result (`{ type: 'result', subtype: 'success', is_error: true, api_error_status: 429 }`, no `result` text) crashed instead of surfacing anything.

### Root Cause

1. `claudeProviderAuthMessage` (`providerAuth.ts`) assumed a `success`-subtype error result always carries `result` text: `const errors = message.subtype === 'success' ? [message.result] : message.errors;`. An exhausted-429 result has no `result` field, so `errors` became `[undefined]`, and `isOAuthExpired(undefined)` crashed calling `.trim()` on it.
2. `claudeRemote.ts`'s generic "Turn stopped" error banner fired unconditionally for any `is_error` result — including ones `claudeProviderAuthMessage` had already classified and reported as an auth failure earlier in the same loop body, firing `onCompletionEvent` twice for one terminal result.

### Fix

- `claudeProviderAuthMessage` now filters both branches (`[message.result]` and `message.errors`) down to actual strings before testing them, instead of assuming either shape.
- The generic error banner is now skipped whenever `claudeProviderAuthMessage` already returned a truthy `authMessage` for the same message (`if (!authMessage && (resultMsg.is_error || ...))`).

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/providerAuth.ts` | Filters `errors` to strings before calling `isOAuthExpired` on each. |
| `packages/happy-cli/src/claude/claudeRemote.ts` | Generic error banner gated on `!authMessage`. |

### Notes

- Caught by running this package's *full* test suite as a separate verification pass after the rebase's conflicts were all resolved — neither feature's own conflict-resolution touched the other's code path, so nothing flagged the interaction earlier.

---

## 15. Context Readouts Disappear on Opus 5

### Symptom

The composer stopped showing the context readout — no `% left`, no token counts. Nothing else changed: project name, connection status and the quota chip were all still there.

Confusingly, the model picker showed **opus 4.8** — a model on which the readout had always worked.

### Root cause

Two independent bugs compounding.

**a) `modelUsage` keys the 1M Opus 5 variant as `claude-opus-5[1m]`, while assistant messages report `claude-opus-5`.**

The SDK reports a model's real context window only on `result` messages (`modelUsage[model].contextWindow`), so `SDKToLogConverter` remembers it per model and stamps it onto later assistant `usage.context_window` (upstream `#1561`). The lookup key is the assistant message's `message.model`, which never matches the beta-variant key:

| launch | assistant model | `modelUsage` key | window | match |
|---|---|---|---|---|
| `--model opus` | `claude-opus-5` | `claude-opus-5[1m]` | 1M | ✗ |
| `--model claude-opus-5` | `claude-opus-5` | `claude-opus-5` | 200k | ✓ |
| `--model claude-opus-5 --betas=context-1m-2025-08-07` | `claude-opus-5` | `claude-opus-5` | 1M | ✓ |
| `--model claude-opus-4-8` | `claude-opus-4-8` | `claude-opus-4-8` | 200k | ✓ |
| `--model claude-opus-4-8 --betas=context-1m-2025-08-07` | `claude-opus-4-8` | `claude-opus-4-8` | 1M | ✓ |

(measured with `claude --print --output-format stream-json --verbose` on apple-claude-code 2.1.143)

The `[1m]` suffix is Opus-5-only — 4.8 keeps the plain key even with the 1M beta enabled. With no window recorded under the canonical name, `usage.context_window` is never stamped, and the app deliberately renders nothing rather than divide by a guessed denominator (`AgentInput.tsx`'s `getContextWarning` and `contextUsage`), so both readouts vanish together.

**b) The picker's `opus 4.8` entry selected Opus 5.**

`getClaudeModelModes()` offered `{ key: 'opus', name: 'opus 4.8' }`. The CLI's `opus` alias now resolves to `claude-opus-5[1m]` — Opus 5 at 1M, without any beta flag being passed. So the entry labelled 4.8 was precisely the one broken variant, real 4.8 was unreachable from the picker, and the badge misreported the running model. This is why the symptom looked impossible: the readout was missing on the one model where it had never failed.

### Fix

**a)** Record the window under the canonical model name as well as the raw key. The SDK reports the mapping as `canonicalModel` — a runtime field its published `ModelUsage` type omits — so read it defensively and fall back to stripping a trailing `[...]` suffix. Both names are recorded so a message naming the variant outright still resolves; later turns overwrite, keeping the window current across model switches.

**b)** Upstream reached the same conclusion independently and rebuilt the whole list around full model IDs (`ac68e914`, `a755c2ad`), which resolves the mislabelled `opus` alias and moves the Claude default to `claude-opus-5`. Only one gap remained: upstream offers the current generation exclusively, so 4.8 is unreachable. This adds `claude-opus-4-8` back as a fourth row, keyed by the full ID for the same reason as its neighbours.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts` | `canonicalModelName()` helper; record the window under both the raw key and the canonical name |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.test.ts` | Variant-key, missing-`canonicalModel`, and raw-variant-message cases |
| `packages/happy-app/sources/components/modelModeOptions.ts` | Adds the `Opus 4.8` row, keyed `claude-opus-4-8`, to upstream's current-generation list |
| `packages/happy-app/sources/components/modelModeOptions.test.ts` | 4.8 added to the expected key and name lists |

### Notes / scope

- `runClaude.ts`'s `DEFAULT_CLAUDE_MODEL = 'opus'` is gone upstream (`dd568d91`): a remote turn now inherits whatever the user's own Claude config resolves to, and fix (a) covers its readout either way.
- Sessions with `modelMode: 'opus'` already persisted keep working and show as `opus / custom` in the picker until re-selected.
- `agentDefaults.ts` is untouched now — upstream already moved the Claude default to `claude-opus-5`.

### Also fixed: window not remembered across sessions

The window is only reported at turn end — `modelUsage[model].contextWindow` rides the `result` message, which arrives *after* the assistant messages of the same turn — so `SDKToLogConverter` has nothing to stamp during turn 1, and the map lived only in memory. Every new session paid the "blank until turn 2" cost again, even for a model this machine had used hundreds of times.

Persist values the SDK reports in the shared, multi-process-locked `~/.happy/settings.json` under `contextWindows`, seeded back into the converter's map at construction. Only observed values are stored — never a guess — so a model's very first turn on this machine is still honestly blank. The converter stays I/O-free: the caller passes a `ContextWindowMemory` (`known` to seed, `onLearned` to persist), and `claudeRemoteLauncher` supplies it; `onLearned` fires only when a value actually changes, so a seeded session that learns nothing writes nothing.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/contextWindowStore.ts` | **New.** `readContextWindows()` / `rememberContextWindow()` over the locked settings file; treats the hand-editable file as untrusted and keeps only positive token counts |
| `packages/happy-cli/src/claude/utils/contextWindowStore.test.ts` | **New.** Round-trip, multi-model, overwrite, garbage-filtering, and "leaves unrelated settings alone" cases |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts` | `ContextWindowMemory` seed/report hook; `isUsableWindow()` shared by the seed and result paths; `recordContextWindow()` reports only on change |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.test.ts` | First-turn stamp from a remembered window, unusable seed values, learn-reported-once, seeded-not-reported-back |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Loads remembered windows before constructing the converter; persists newly learned ones |
| `packages/happy-cli/src/persistence.ts` | `contextWindows?: Record<string, number>` on `Settings` |

- `convertSDKToLog()` in `sdkToLogConverter.ts` has no callers and was left as-is; it takes no memory, so a hypothetical caller keeps the old turn-1-blank behaviour.

---

## 16. Context Readout Vanishes Mid-Session

### Symptom

Once shown, the context readout could disappear again partway through a session.

### Root cause

`processUsageData` replaced `latestUsage` wholesale. In `reducer.ts`, a message whose `usage` carried no `context_window` produced a new `latestUsage` with no `contextWindow` at all, and the app's gate then renders nothing. Sub-agent turns run on a different model, so the first time one appears — before any result message has reported *that* model's window — its usage arrives windowless and blanks the readout for the main thread.

### Fix

`processUsageData` falls back to the previous `contextWindow` when a message omits it. A message that reports its own window still replaces it, so switching models still corrects the denominator.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/sync/reducer/reducer.ts` | `processUsageData` carries the last known window forward |
| `packages/happy-app/sources/sync/reducer/reducer.spec.ts` | Carry-forward and still-replaceable cases |

### Notes / scope

- **Local (interactive) mode is unaffected and still shows no readout.** It does not go through `SDKToLogConverter` at all — the watcher forwards Claude's own transcript, which never contains `context_window`. Pre-existing, out of scope here.
- The carry-forward keeps a denominator from a *different* model for the one windowless sub-agent message, rather than blanking. Self-corrects on the next result. Whether sub-agent usage should drive the composer's readout at all is a separate question — its `contextSize` is the sub-agent's, not the main thread's.

---

## 17. Output Bursts Stall the Client's Ordered Decrypt Queue

### Symptom

Terminal responsiveness degrades while output is flowing: the echo of a keystroke typed during a command's output arrives late, well beyond the round trip it should have cost.

### Root cause

`apiSocket.attachEncryptedListeners` serializes decrypt-and-dispatch per `(event, scope)`. That serialization is necessary and deliberate — `rn-encryption`'s decrypt is genuinely asynchronous, and two decrypts that *start* in order can *finish* out of order, which scrambles a byte stream (this is the bug fixed by the sequencer in `NEW_FEATURES.md` section 5). But it means the queue is strictly FIFO: anything behind a backlog waits for all of it.

The daemon was filling that queue with one socket event per PTY chunk. A shell redrawing its prompt line emits many tiny writes in quick succession, and each one cost a separate encrypt, socket frame, relay hop, and ordered decrypt on the client. Measured with node-pty against `bash --norc`:

| Command | Bytes | Socket events |
|---|---|---|
| `ls -la` | 2007 | 4 |
| `echo hello` | 38 | 4 |
| a single keystroke's echo | 1 | 1 |

Note the last row: **a single keystroke already costs exactly one event.** Chunk count is not what makes per-key echo feel slow (that is four network legs — see `NEW_FEATURES.md` section 10). What the fan-out does hurt is the keystroke typed *during* output, which lands behind the backlog.

### Fix

Concatenate queued chunks into as few payloads as the segment limit allows, with a **trailing-only** window:

- The first chunk after an idle period goes out **immediately**. A lone keystroke's echo is therefore never delayed by a single millisecond.
- Only the followers — which by definition already lost the race — wait out an 8 ms window and travel merged.

Measured after the change: `ls -la` and `echo hello` drop from 4 events to 1; single-keystroke echo stays at 1 event with no added latency.

The merge itself is a pure function in its own module so it is testable without node-pty or a socket. Per-terminal timers are cleared when a terminal is destroyed, rather than left alive on a dead entry.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/modules/terminal/outputCoalescer.ts` | **New.** `coalesceSegments()` — order-preserving merge, splits an oversized chunk, drops empties. |
| `packages/happy-cli/src/modules/terminal/outputCoalescer.test.ts` | **New.** Merge, segment-limit splitting, oversized chunks, empty chunks, order preservation. |
| `packages/happy-cli/src/modules/terminal/terminalHandler.ts` | Leading-edge-immediate + 8 ms trailing coalesce; `disposeOutputState()` clears the timer with the terminal. |

### Notes / scope

- `COALESCE_MS = 8` is a throughput/latency trade that only ever applies to followers. Raising it merges more of a long burst (an 8 ms window already collapses these commands to one event) at no cost to interactive echo.
- The client's sequencer is left exactly as it is. It is load-bearing for correctness; this reduces what it has to carry.

---

## 18. Model, Effort, and Permission Mode Invisible on Web

### Symptom

In a browser — desktop or phone — the composer shows a bare gear icon where the model, effort level, and permission mode used to be readable. There is no way to tell which model a session is on, or that it is running in yolo, without opening the menu.

### Root cause

Not a rebase casualty: those labels were upstream's own code, and upstream removed them.

At the old base (`16ea2acc`) `AgentInputStatusRow` took `displayPermissionMode`, `permissionLabel`, `sessionStatusModelLabel`, and `sessionStatusEffortLabel` and printed them on the status-bar line. Our Floodgate commit only ever *added* `contextUsage` and `quota` to that row. Upstream then deleted the line's contents in `c15eeee9` ("kill the status bar line"), leaving connection status, git branch, and git changes — and deleted the `sessionStatusBarDisplay` setting that turned the line on.

What replaced it is split by platform, and the browser lost out:

| Surface | Condition | Model / effort / permission |
|---|---|---|
| Narrow native phone | `compactMobileComposer` = `Platform.OS !== 'web' && !mac && width <= 700` | text chips in the composer |
| **Web (any width), Mac desktop, native tablet** | anything else → `desktopActionControls` | a single `Octicons name="gear"`, values only inside the menu |

`useNativeSettingsMenus` is `platform === 'ios' && !runningOnMac`, so web and Mac take the plain `Pressable` gear and a native tablet takes the `NativeSettingsMenu` gear. All three showed the icon alone.

### Fix

Render the values next to the gear, in both gear branches, so every surface that had only an icon now reads e.g. `yolo · Opus 5 · high`. The gear already opens the combined permission + model + effort menu, so this labels the control that changes them rather than adding another one.

`formatModeSummary` joins the known values with a middot and **omits** absent ones. Filling a gap with a placeholder was the tempting alternative and is worse: `Model` sitting where a model name belongs reads like a value. With nothing known it returns null and the bare icon renders, unchanged from today.

The summary shrinks before the buttons to its right do (`flexShrink: 1`, `minWidth: 0`) and clips inside `actionButtonsLeft`'s existing `overflow: hidden`, so a long model name on a narrow phone browser cannot push the send button off the row.

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/modelModeOptions.ts` | **New** `formatModeSummary()` — pure, omits absent values, null when nothing is known. |
| `packages/happy-app/sources/components/modelModeOptions.test.ts` | Joining, omission, and the all-empty case. |
| `packages/happy-app/sources/components/AgentInput.tsx` | `modeSummary` + `renderSettingsSummary()`; both gear branches in `desktopActionControls` render it; `settingsSummary*` styles. |

### Notes / scope

- Deliberately **not** behind a setting. Upstream removed the old one along with the line; adding a toggle to see what a session is running trades one invisible state for another.
- The narrow-native-phone composer is untouched — it already shows the values as chips.
- Zen mode still hides the whole left group, as before.
- **Bug found and fixed**: the summary's `useNativeSettingsMenus` branch (iOS tablets) had no `flexShrink` on either the `NativeSettingsMenu` wrapper or `settingsSummaryFrame`, so a long model name could not truncate there — only the web/Mac `Pressable` branch had it. `react-native-web`'s own `View` base style sets `flexShrink: 0` (unlike CSS), so every wrapper between a row and a truncating text has to opt in explicitly; this one didn't. Added `flexShrink: 1` to both.

---

## 19. Audit: Shrink Chains and Platform Variants Across the UI Changes

### Why

A wrapper with no `flexShrink` stopped a Floodgate project name from truncating, and a popup was dead on web because `NativeSettingsMenu` renders nothing but its children there. Neither is visible to `tsc` or to any test in this repo. Every other UI change on this branch was written the same way, so all of them were audited against the same two failure modes.

### The criterion

Two facts from `react-native-web`'s own source settle how to read this code:

```js
// node_modules/react-native-web/dist/exports/View/index.js — view$raw
flexShrink: 0,
minHeight: 0,
minWidth: 0,
```

- **`flexShrink` defaults to 0**, unlike CSS. Every wrapper between a row and a text meant to truncate must opt in explicitly. Miss one link and the text stops truncating and starts pushing its siblings out of the row.
- **`minWidth: 0` is already set** on every `View`, so the `minWidth: 0` that CSS flexbox would require is redundant here. Harmless, but not what makes a chain work.

### Findings

| Area | Verdict |
|---|---|
| Mode summary, `useNativeSettingsMenus` branch | **Broken.** `NativeSettingsMenu style={{ height: 40 }}` and `settingsSummaryFrame` both lacked `flexShrink`, so a long model name could not truncate on an iOS tablet. Fixed. |
| Mode summary, web/Mac branch | Clean — the `Pressable` carries `flexShrink: 1`. |
| Quota chip (`AgentInputUsageRow`, from section 8) | Clean as landed — its project-name `Text` already carries `flexShrink: 1` and its wrapping `View` carries `flexShrink: 1, marginRight: 'auto'`. The status-row consolidation this finding originally referred to (moving the chip up beside the git branch, deduping it against the plan's week stat) did not survive rebasing onto upstream's own composer-row redesign (`9de28e0a`) and was dropped — see the Notes below. |
| `TerminalPanel` pointer check | **Hardened.** `IS_TOUCH` was sampled once at module load, so a desktop browser toggled into device emulation never grew the key bar without a reload — exactly how it gets tested. Now a subscribed `matchMedia` hook. Its dead `Platform.OS !== 'web'` branch is gone; the panel is web-only. |
| `copyAction` in the message footer | Behaviour fine, comment misleading. `alignSelf: 'flex-start'` was written for a **column** parent, where the cross axis is horizontal and it meant "shrink-wrap the glyph". Reparenting it into a row flipped the axis to vertical, where it means "top-align" — and it changes nothing because the button is the tallest item in that row. Comment corrected rather than the style. |
| `NativeSettingsMenu` JSX sites | Clean. 5 real sites (9 grep hits included `…Option`/`…Group` **type** references); every one is behind `useNativeSettingsMenus` or an explicit web branch. |
| `Pressable` + `onMouseDown`/`onTouchStart` (key bar) | Clean. `_excluded` does not strip them, and `PressResponder.getEventHandlers()` returns only `onStartShouldSetResponder`, `onKeyDown`, `onResponder*`, `onContextMenu` — so they are not overwritten and reach the DOM through `View`'s forwarded `mouseProps`/`touchProps`. |
| `View` + `onContextMenu` (markdown copy) | Clean — `onContextMenu` is in the forwarded `clickProps`. |
| Other `.web.tsx` variants (`Shaker`, `ShimmerText`, `PlusPlus`, `NativeOptionsPicker`) | Clean — all real implementations. `NativeSettingsMenu.web` is the only no-op in the tree. |

### Files changed

| File | Change |
|---|---|
| `packages/happy-app/sources/components/AgentInput.tsx` | `flexShrink: 1` on the native-menu wrapper and `settingsSummaryFrame`. |
| `packages/happy-app/sources/components/terminal/TerminalPanel.tsx` | `useCoarsePointer()` replaces the module-load `IS_TOUCH`. |
| `packages/happy-app/sources/components/MessageView.tsx` | Comment on `copyAction` corrected for its new parent. |

### Notes / scope

- **Static analysis cannot catch either failure mode.** A missing `flexShrink` is a valid style and a no-op wrapper component is valid JSX; both typecheck and both pass every test here. The remaining verification for all of these changes is looking at them on a device.
- The `TerminalPanel` height drag handle is still mouse-only (`onMouseDown` + `mousemove`), so it cannot be dragged on a phone. Known and unaddressed.
- This audit originally covered two fork commits ("put budget, project, and context on the status row" and "merge the plan week quota and Floodgate budget into one slot") that moved the Floodgate chip up next to the git branch and deduped it against the plan's week percentage. Rebasing onto upstream commit `9de28e0a` ("redesign composer status rows with usage gauge"), which landed in between and restructured the same rows independently, made both commits' diffs inapplicable. They were dropped rather than force-merged; the Floodgate quota chip from section 8 still renders in `AgentInputUsageRow`, just without that later layout pass.
- The "rename session" `Pressable` audited in an earlier pass of this section no longer exists: upstream deleted the whole avatar/title/status header from `info.tsx` (`dcf38e10`) while this branch was rebasing, taking the wrapped `Text` with it. See `NEW_FEATURES.md` section 4.
