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
