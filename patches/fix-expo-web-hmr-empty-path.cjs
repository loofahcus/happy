/**
 * Patches expo's web HMR client to avoid crashing the Metro dev server with:
 *   "The given URL '<host>/?platform=web' has an empty path and cannot be
 *    converted to a JSC-safe format."
 *
 * Root cause: expo/src/async-require/getFullBundlerUrl.ts falls back to
 * `location.href` when `document.currentScript` is null (which happens with
 * module scripts and async loads). If the page URL has an empty path (e.g.
 * the root "/"), the resulting bundle URL has no path, and Metro's HmrServer
 * passes it to jsc-safe-url, which throws an unhandled rejection that kills
 * the dev server process.
 *
 * Fix: when currentScript is unavailable, prefer any <script src="...bundle...">
 * already present in the DOM (Expo CLI injects one with the correct
 * monorepo-aware path), and only fall back to location.href as last resort.
 */
const fs = require('fs');
const path = require('path');

const nodeModulesRoots = [
    path.resolve(__dirname, '..', 'node_modules'),
    path.resolve(__dirname, '..', 'packages/happy-app/node_modules'),
];

const PATCHED_CONTENT = `export function getFullBundlerUrl(): string {
  const currentScript = document?.currentScript;
  let baseUrl: string;
  if (currentScript && "src" in currentScript && (currentScript as HTMLScriptElement).src) {
    baseUrl = (currentScript as HTMLScriptElement).src;
  } else {
    // Fallback: document.currentScript is null in module scripts or async loads.
    // Try to find any <script> tag pointing at a Metro bundle URL.
    const scripts = typeof document !== "undefined"
      ? Array.from(document.getElementsByTagName("script"))
      : [];
    const bundleScript = scripts.find(
      (s) => s.src && /\\.bundle(\\?|$)/.test(s.src)
    );
    baseUrl = bundleScript?.src ?? location.href;
  }

  const bundleUrl = new URL(baseUrl, location.href);

  if (!bundleUrl.searchParams.has("platform")) {
    bundleUrl.searchParams.set("platform", process.env.EXPO_OS ?? "web");
  }

  return bundleUrl.toString();
}
`;

let patched = 0;
for (const nodeModulesRoot of nodeModulesRoots) {
    const target = path.join(
        nodeModulesRoot,
        'expo/src/async-require/getFullBundlerUrl.ts'
    );
    if (!fs.existsSync(target)) continue;
    const current = fs.readFileSync(target, 'utf8');
    if (current === PATCHED_CONTENT) continue;
    fs.writeFileSync(target, PATCHED_CONTENT);
    patched++;
    console.log(`[patch] fix-expo-web-hmr-empty-path: patched ${target}`);
}

if (patched === 0) {
    console.log('[patch] fix-expo-web-hmr-empty-path: nothing to patch');
}
