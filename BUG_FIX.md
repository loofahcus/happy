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

## 4. Session-List Cache Silently Stopped Working After the Avatar Rebase

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
- Same rebase also surfaced two smaller, related test-mock gaps in this cache's own test files (section 5) and a separate behavioral bug in `claudeRemote.ts` (section 11) — both caught by running the *full* test suite instead of only the targeted tests touched by each conflict resolution.

---

## 5. Sync Test Harnesses Didn't Know About the Message Cache

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
- The terminal feature (`NEW_FEATURES.md` section 5) has the same class of gap in a different test file — see section 8.

---

## 6. React "Cannot read properties of null (reading 'useContext')" via Duplicate React Instance

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

## 7. Markdown Images Render as Gray Boxes on Web

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
