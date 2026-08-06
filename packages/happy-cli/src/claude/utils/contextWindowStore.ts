/**
 * Cross-session memory of each model's real context window.
 *
 * The SDK reports a window only on a turn's `result` message, which arrives
 * after the assistant messages it applies to. Within one session that leaves
 * the first turn without a denominator, so the client shows nothing until the
 * second. Remembering the values in the shared (multi-process locked)
 * settings file closes that gap for every model this machine has used before.
 *
 * Nothing is ever guessed — only windows the SDK actually reported are stored.
 */

import { readSettings, updateSettings } from '@/persistence';
import { logger } from '@/ui/logger';

/**
 * Keep only entries usable as a denominator. The settings file is hand-editable
 * and shared across CLI versions, so treat it as untrusted input.
 */
function usableWindows(raw: unknown): Record<string, number> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }
    const result: Record<string, number> = {};
    for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            result[model] = Math.trunc(value);
        }
    }
    return result;
}

/** Windows learned in earlier sessions. Empty when nothing is known yet. */
export async function readContextWindows(): Promise<Record<string, number>> {
    try {
        const settings = await readSettings();
        return usableWindows(settings.contextWindows);
    } catch (error) {
        logger.debug('[contextWindow] Failed to read remembered windows', error);
        return {};
    }
}

/**
 * Persist one model's window. Skipped when the value is already stored, so a
 * session that learns nothing new does not touch the file.
 */
export async function rememberContextWindow(model: string, contextWindow: number): Promise<void> {
    try {
        const known = await readContextWindows();
        if (known[model] === contextWindow) {
            return;
        }
        await updateSettings((current) => ({
            ...current,
            contextWindows: { ...usableWindows(current.contextWindows), [model]: contextWindow },
        }));
        logger.debug(`[contextWindow] Remembered ${model} = ${contextWindow}`);
    } catch (error) {
        logger.warn(
            `⚠️ Failed to remember context window for ${model}: ` +
            (error instanceof Error ? error.message : String(error))
        );
    }
}
