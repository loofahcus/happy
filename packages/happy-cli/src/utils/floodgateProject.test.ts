/**
 * Unit tests for the machine-scoped Floodgate project token helpers.
 *
 * Isolation: we point HAPPY_HOME_DIR at a fresh temp directory BEFORE importing
 * the modules so the singleton `configuration` resolves the settings file there
 * — these tests never read or mutate the real ~/.happy/settings.json.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempHome = mkdtempSync(join(tmpdir(), 'happy-floodgate-test-'));
process.env.HAPPY_HOME_DIR = tempHome;

// Imported after HAPPY_HOME_DIR is set so settings land in the temp dir.
let mod: typeof import('./floodgateProject');

beforeAll(async () => {
    mod = await import('./floodgateProject');
});

afterAll(() => {
    rmSync(tempHome, { recursive: true, force: true });
});

beforeEach(async () => {
    // Reset to a clean (unset) state before each test.
    await mod.setFloodgateProjectToken(null);
    delete process.env.FLOODGATE_PROJECT_TOKEN;
});

describe('floodgateProject helpers', () => {
    it('reads null when unset', async () => {
        expect(await mod.readFloodgateProjectToken()).toBeNull();
    });

    it('persists and reads back a token with its project name', async () => {
        const stored = await mod.setFloodgateProjectToken('  tok-123  ', 'My Project');
        expect(stored).toBe('tok-123'); // trimmed
        expect(await mod.readFloodgateProjectToken()).toBe('tok-123');
        expect(await mod.readFloodgateProjectName()).toBe('My Project');
    });

    it('treats empty/whitespace token as unset and clears the name', async () => {
        await mod.setFloodgateProjectToken('tok-123', 'My Project');
        const cleared = await mod.setFloodgateProjectToken('   ');
        expect(cleared).toBeNull();
        expect(await mod.readFloodgateProjectToken()).toBeNull();
        expect(await mod.readFloodgateProjectName()).toBeNull();
    });

    it('applies the token to process.env and deletes it when unset', async () => {
        await mod.setFloodgateProjectToken('tok-abc');
        await mod.applyFloodgateProjectTokenToEnv();
        expect(process.env.FLOODGATE_PROJECT_TOKEN).toBe('tok-abc');

        await mod.setFloodgateProjectToken(null);
        await mod.applyFloodgateProjectTokenToEnv();
        expect(process.env.FLOODGATE_PROJECT_TOKEN).toBeUndefined();
    });

    it('merges the token over base env and removes the key when unset', async () => {
        await mod.setFloodgateProjectToken('tok-merge');
        const withToken = await mod.mergeFloodgateProjectToken({ FOO: 'bar', FLOODGATE_PROJECT_TOKEN: 'old' });
        expect(withToken).toEqual({ FOO: 'bar', FLOODGATE_PROJECT_TOKEN: 'tok-merge' });

        await mod.setFloodgateProjectToken(null);
        const withoutToken = await mod.mergeFloodgateProjectToken({ FOO: 'bar', FLOODGATE_PROJECT_TOKEN: 'old' });
        expect(withoutToken).toEqual({ FOO: 'bar' });
    });

    it('reports no change when settings match the applied env token', async () => {
        expect(await mod.floodgateProjectTokenChanged()).toBe(false); // both unset

        await mod.setFloodgateProjectToken('tok-xyz');
        await mod.applyFloodgateProjectTokenToEnv(); // simulate a spawn picking it up
        expect(await mod.floodgateProjectTokenChanged()).toBe(false);
    });

    it('detects a token change after spawn (switch then clear)', async () => {
        await mod.setFloodgateProjectToken('tok-1');
        await mod.applyFloodgateProjectTokenToEnv(); // spawn with tok-1
        expect(await mod.floodgateProjectTokenChanged()).toBe(false);

        // App switches project mid-session; the running child still holds tok-1.
        await mod.setFloodgateProjectToken('tok-2');
        expect(await mod.floodgateProjectTokenChanged()).toBe(true);

        await mod.applyFloodgateProjectTokenToEnv(); // next spawn re-syncs
        expect(await mod.floodgateProjectTokenChanged()).toBe(false);

        // App clears the project; the running child still holds tok-2.
        await mod.setFloodgateProjectToken(null);
        expect(await mod.floodgateProjectTokenChanged()).toBe(true);
    });
});
