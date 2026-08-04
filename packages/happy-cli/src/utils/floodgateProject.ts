/**
 * Machine-scoped Floodgate project token management.
 *
 * The token lives in the shared `~/.happy/settings.json` (multi-process
 * locked), making it the single source of truth for every Happy session
 * process running on the machine:
 *
 * - Setting it (from the app, via the daemon's machine RPC) writes the file.
 * - Each Claude session reads it fresh before every turn's spawn and applies
 *   it to `process.env.FLOODGATE_PROJECT_TOKEN`, so already-running sessions
 *   switch projects on their next message and new sessions inherit it at
 *   startup.
 * - An empty/absent token means "unset" → personal quota.
 */

import { readSettings, updateSettings } from '@/persistence';
import { logger } from '@/ui/logger';

const ENV_KEY = 'FLOODGATE_PROJECT_TOKEN';

/** Normalize a raw token value: trim and treat empty as unset (null). */
function normalizeToken(token: string | null | undefined): string | null {
    if (typeof token !== 'string') {
        return null;
    }
    const trimmed = token.trim();
    return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the active machine-scoped Floodgate project token from settings.
 * Returns null when unset (→ personal quota).
 */
export async function readFloodgateProjectToken(): Promise<string | null> {
    const settings = await readSettings();
    return normalizeToken(settings.floodgateProjectToken);
}

/** Read the cached project name for display purposes (null when unknown). */
export async function readFloodgateProjectName(): Promise<string | null> {
    const settings = await readSettings();
    return settings.floodgateProjectName ?? null;
}

/**
 * Persist the machine-scoped Floodgate project token. Passing null/empty
 * clears it (→ personal quota). The optional projectName is cached alongside
 * for display; it is cleared when the token is unset.
 */
export async function setFloodgateProjectToken(
    token: string | null | undefined,
    projectName?: string | null,
): Promise<string | null> {
    const normalized = normalizeToken(token);
    await updateSettings((current) => ({
        ...current,
        floodgateProjectToken: normalized ?? undefined,
        floodgateProjectName: normalized ? (projectName ?? current.floodgateProjectName) : undefined,
    }));
    logger.debug(`[floodgate] Project token ${normalized ? 'set' : 'cleared'}`);
    return normalized;
}

/** Cache the resolved project name for the active token (display only). */
export async function setFloodgateProjectName(projectName: string | null): Promise<void> {
    await updateSettings((current) => ({
        ...current,
        floodgateProjectName: projectName ?? undefined,
    }));
}

/**
 * Apply the machine-scoped Floodgate project token to `process.env`. The
 * Claude Code subprocess spawned by the SDK inherits `process.env`, so this
 * routes its usage to the selected project. Reads fresh from settings on every
 * call — the machine setting wins over any launch-time `--claude-env` value.
 * Clearing the token deletes the variable so usage falls back to personal.
 */
export async function applyFloodgateProjectTokenToEnv(): Promise<void> {
    const token = await readFloodgateProjectToken();
    if (token) {
        process.env[ENV_KEY] = token;
    } else {
        delete process.env[ENV_KEY];
    }
}

/**
 * Whether the machine-scoped token in settings now differs from the value last
 * applied to `process.env` — i.e. what a running Claude subprocess inherited at
 * spawn. When true, a streaming remote session must re-spawn so its next turn
 * routes to the newly selected project instead of the stale one.
 */
export async function floodgateProjectTokenChanged(): Promise<boolean> {
    const desired = await readFloodgateProjectToken();
    const applied = normalizeToken(process.env[ENV_KEY]);
    return desired !== applied;
}

/**
 * Merge the machine-scoped token into a base env-var map for spawns that build
 * an explicit env object (e.g. the interactive PTY launcher). The settings
 * token wins; when unset, the key is removed from the returned copy.
 */
export async function mergeFloodgateProjectToken(
    baseEnvVars: Record<string, string> | undefined,
): Promise<Record<string, string>> {
    const merged: Record<string, string> = { ...(baseEnvVars ?? {}) };
    const token = await readFloodgateProjectToken();
    if (token) {
        merged[ENV_KEY] = token;
    } else {
        delete merged[ENV_KEY];
    }
    return merged;
}
