/**
 * Tests for the cross-session context window memory
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readContextWindows, rememberContextWindow } from './contextWindowStore';

const mockConfiguration = vi.hoisted(() => ({
    happyHomeDir: '',
    settingsFile: '',
    // The logger builds its file path from these at import time.
    logsDir: '/tmp',
    isDaemonProcess: false,
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

describe('contextWindowStore', () => {
    let homeDir: string;

    beforeEach(() => {
        homeDir = mkdtempSync(join(tmpdir(), 'happy-ctx-window-'));
        mockConfiguration.happyHomeDir = homeDir;
        mockConfiguration.settingsFile = join(homeDir, 'settings.json');
    });

    afterEach(() => {
        rmSync(homeDir, { recursive: true, force: true });
    });

    it('returns nothing when no settings file exists', async () => {
        await expect(readContextWindows()).resolves.toEqual({});
    });

    it('round-trips a remembered window', async () => {
        await rememberContextWindow('claude-opus-5', 1_000_000);

        await expect(readContextWindows()).resolves.toEqual({ 'claude-opus-5': 1_000_000 });
    });

    it('keeps windows for other models when remembering a new one', async () => {
        await rememberContextWindow('claude-opus-5', 1_000_000);
        await rememberContextWindow('claude-haiku-4-5', 200_000);

        await expect(readContextWindows()).resolves.toEqual({
            'claude-opus-5': 1_000_000,
            'claude-haiku-4-5': 200_000,
        });
    });

    it('overwrites a stale window for the same model', async () => {
        await rememberContextWindow('claude-opus-5', 200_000);
        await rememberContextWindow('claude-opus-5', 1_000_000);

        await expect(readContextWindows()).resolves.toEqual({ 'claude-opus-5': 1_000_000 });
    });

    it('drops unusable entries from a hand-edited settings file', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            schemaVersion: 2,
            contextWindows: {
                'claude-opus-5': 1_000_000,
                'zero': 0,
                'negative': -5,
                'text': '200000',
                'nan': null,
            },
        }));

        await expect(readContextWindows()).resolves.toEqual({ 'claude-opus-5': 1_000_000 });
    });

    it('survives a non-object contextWindows value', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            schemaVersion: 2,
            contextWindows: 'nonsense',
        }));

        await expect(readContextWindows()).resolves.toEqual({});
    });

    it('leaves unrelated settings untouched', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            schemaVersion: 2,
            onboardingCompleted: true,
            floodgateProjectName: 'my-project',
        }));

        await rememberContextWindow('claude-opus-5', 1_000_000);

        const settings = JSON.parse(readFileSync(mockConfiguration.settingsFile, 'utf8'));
        expect(settings.onboardingCompleted).toBe(true);
        expect(settings.floodgateProjectName).toBe('my-project');
        expect(settings.contextWindows).toEqual({ 'claude-opus-5': 1_000_000 });
    });
});
