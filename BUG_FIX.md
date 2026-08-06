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

## 2. MCP SDK Bump Trips TS2589 in `registerTool` Generics

### Problem

After `@modelcontextprotocol/sdk` was bumped to 1.29.0, `tsc --noEmit` in the CLI build script started failing with `TS2589: Type instantiation is excessively deep and possibly infinite`. The error fires inside `startHappyServer.ts` where `registerTool` is invoked with an inferred generic. Runtime behaviour is unaffected — only the typecheck step is broken, which gates `pnpm build`.

### Root Cause

The new MCP SDK overload signature for `registerTool` exposes a recursive Zod-derived inference path that TypeScript cannot evaluate within its instantiation depth limit.

### Fix

A targeted `// @ts-expect-error TS2589` on the single failing call. This is a known third-party generics false positive — narrower than `// @ts-ignore`, and `tsc` will surface it again the moment the SDK fixes its types.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/startHappyServer.ts` | Single-line `@ts-expect-error TS2589` above the offending `registerTool` call. |

---

## 3. 1M Context Window Never Actually Enabled in Remote Mode

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

## 4. React "Cannot read properties of null (reading 'useContext')" via Duplicate React Instance

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

## 5. Markdown Images Render as Gray Boxes on Web

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

## 6. CLI `npm pack` Fails: `@slopus/happy-wire` Not Found on Registry

### Problem

When running `npm pack` (or `npm publish`) on `packages/happy-cli`, the resulting tarball lists `@slopus/happy-wire` as a runtime dependency. Users installing the tarball via `npm install` then fail because `@slopus/happy-wire` doesn't exist on any public registry — it's a workspace-only package.

### Root Cause

`@slopus/happy-wire` was listed under `dependencies` in `packages/happy-cli/package.json`. In the monorepo this resolves via pnpm workspace symlink, but the published tarball has no workspace protocol — npm/yarn try to fetch it from the configured registry and 404.

### Fix

Move `@slopus/happy-wire` from `dependencies` to `devDependencies`. pkgroll (the CLI's bundler) already follows import paths at build time and inlines the wire package into `dist/`, so it doesn't need to be a runtime dep.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/package.json` | `@slopus/happy-wire: "workspace:*"` moved from `dependencies` to `devDependencies`. |

---

## 7. SDK Query Fails Under Apple Claude Code Auth

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

---

## 8. Silent Session Stalls: 429 / API Errors Not Surfaced

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

## 9. Context Used/Total and "% Left" Disappear on Opus 5

### Symptom

The composer status row stopped showing both context readouts — the `% left` warning and the `180k/1M` used/total chip. Nothing else about the row changed: project name, connection status and the quota chip were all still there.

Confusingly, the model picker showed **opus 4.8** — a model on which the readouts had always worked.

### Root cause

Two independent bugs compounding.

**a) `modelUsage` keys the 1M Opus 5 variant as `claude-opus-5[1m]`, while assistant messages report `claude-opus-5`.**

The SDK reports a model's real context window only on `result` messages (`modelUsage[model].contextWindow`), so `SDKToLogConverter` remembers it per model and stamps it onto later assistant `usage.context_window` (see `NEW_FEATURES.md` section 8). The lookup key is the assistant message's `message.model`, which never matches the beta-variant key:

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

`getClaudeModelModes()` offered `{ key: 'opus', name: 'opus 4.8' }`. The CLI's `opus` alias now resolves to `claude-opus-5[1m]` — Opus 5 at 1M, without any beta flag being passed. So the entry labelled 4.8 was precisely the one broken variant, real 4.8 was unreachable from the picker, and the badge misreported the running model. This is why the symptom looked impossible: the readouts were missing on the one model where they had never failed.

### Fix

**a)** Record the window under the canonical model name as well as the raw key. The SDK reports the mapping as `canonicalModel` — a runtime field its published `ModelUsage` type omits — so read it defensively and fall back to stripping a trailing `[...]` suffix. Both names are recorded so a message naming the variant outright still resolves; later turns overwrite, keeping the window current across model switches.

**b)** Key the entry by the full model ID, `claude-opus-4-8`, which passes straight through to the API — the same reasoning as the `claude-opus-5` entry above it.

Removing `opus` from the offered list left `codeAgentDefaults.claude.modelMode` pointing outside it, which would render the default as a `custom` entry via `withCustomModelOption`. Moved that default to `claude-opus-5`: identical effective model (Opus 5 at 1M, once `claudeRemote` adds the beta) with a key that stays in the list. A test pins the invariant.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts` | `canonicalModelName()` helper; record the window under both the raw key and the canonical name |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.test.ts` | Variant-key, missing-`canonicalModel`, and raw-variant-message cases |
| `packages/happy-app/sources/components/modelModeOptions.ts` | `opus 4.8` entry keyed `claude-opus-4-8` instead of the `opus` alias |
| `packages/happy-app/sources/sync/agentDefaults.ts` | Claude default `modelMode` `opus` → `claude-opus-5` |
| `packages/happy-app/sources/components/modelModeOptions.test.ts` | Updated key list and default; new test that the default stays inside the offered list |

### Notes / scope

- `runClaude.ts`'s `DEFAULT_CLAUDE_MODEL = 'opus'` is deliberately left as the alias: it is a CLI-side default for a bare `happy claude`, not a user-facing label, and fix (a) covers its readout.
- Sessions with `modelMode: 'opus'` already persisted keep working and show as `opus / custom` in the picker until re-selected.

---

## 10. Context Readout Blank on the First Turn, and Vanishing Mid-Session

Two robustness gaps in the used/total readout, both exposed while verifying section 9.

### Symptom

1. **Blank first turn.** A freshly started (or resumed) session showed no readout until its *second* turn — long enough that the feature read as broken.
2. **Vanishing mid-session.** Once shown, the readout could disappear again partway through a session.

### Root cause

**1. The window is only reported at turn end.** `modelUsage[model].contextWindow` rides the `result` message, which arrives *after* the assistant messages of the same turn. `SDKToLogConverter` therefore has nothing to stamp during turn 1, and the map died with the process — every new session paid the cost again, even for a model the machine had used hundreds of times.

**2. `processUsageData` replaced `latestUsage` wholesale.** In `reducer.ts`, a message whose `usage` carried no `context_window` produced a new `latestUsage` with no `contextWindow` at all, and the app's gate then renders nothing. Sub-agent turns run on a different model, so the first time one appears — before any result message has reported *that* model's window — its usage arrives windowless and blanks the readout for the main thread.

### Fix

**1. Remember windows across sessions.** Values the SDK reported are persisted in the shared, multi-process-locked `~/.happy/settings.json` under `contextWindows`, and seeded back into the converter's map at construction. The first turn of a session is then already covered for every model this machine has used before. Only observed values are stored — never a guess — so a model's very first turn is still honestly blank.

The converter stays I/O-free: the caller passes a `ContextWindowMemory` (`known` to seed, `onLearned` to persist), and `claudeRemoteLauncher` supplies it. `onLearned` fires only when a value actually changes, so a seeded session that learns nothing writes nothing.

**2. Carry the last known window forward.** `processUsageData` falls back to the previous `contextWindow` when a message omits it. A message that reports its own window still replaces it, so switching models still corrects the denominator.

### Files changed

| File | Change |
|---|---|
| `packages/happy-cli/src/claude/utils/contextWindowStore.ts` | **New.** `readContextWindows()` / `rememberContextWindow()` over the locked settings file; treats the hand-editable file as untrusted and keeps only positive token counts |
| `packages/happy-cli/src/claude/utils/contextWindowStore.test.ts` | **New.** Round-trip, multi-model, overwrite, garbage-filtering, and "leaves unrelated settings alone" cases |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.ts` | `ContextWindowMemory` seed/report hook; `isUsableWindow()` shared by the seed and result paths; `recordContextWindow()` reports only on change |
| `packages/happy-cli/src/claude/utils/sdkToLogConverter.test.ts` | First-turn stamp from a remembered window, unusable seed values, learn-reported-once, seeded-not-reported-back |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Loads remembered windows before constructing the converter; persists newly learned ones |
| `packages/happy-cli/src/persistence.ts` | `contextWindows?: Record<string, number>` on `Settings` |
| `packages/happy-app/sources/sync/reducer/reducer.ts` | `processUsageData` carries the last known window forward |
| `packages/happy-app/sources/sync/reducer/reducer.spec.ts` | Carry-forward and still-replaceable cases |

### Notes / scope

- **Local (interactive) mode is unaffected and still shows no readout.** It does not go through `SDKToLogConverter` at all — the watcher forwards Claude's own transcript, which never contains `context_window`. Pre-existing, out of scope here.
- `convertSDKToLog()` in `sdkToLogConverter.ts` has no callers and was left as-is; it takes no memory, so a hypothetical caller keeps the old turn-1-blank behaviour.
- The carry-forward keeps a denominator from a *different* model for the one windowless sub-agent message, rather than blanking. Self-corrects on the next result. Whether sub-agent usage should drive the composer's readout at all is a separate question — its `contextSize` is the sub-agent's, not the main thread's.
