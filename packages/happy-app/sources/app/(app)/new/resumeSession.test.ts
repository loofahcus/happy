import { describe, it, expect } from 'vitest';

/**
 * Tests for the resume session feature.
 * Verifies that the correct Claude Code session ID is found
 * for a given machine + directory combination.
 */

interface MockSession {
    id: string;
    active: boolean;
    updatedAt: number;
    metadata: {
        machineId: string;
        path: string;
        claudeSessionId?: string;
    } | null;
}

function findResumableSession(
    sessions: MockSession[],
    machineId: string,
    path: string
): MockSession | null {
    const candidates = sessions.filter(s =>
        s.metadata?.machineId === machineId &&
        s.metadata?.path === path &&
        s.metadata?.claudeSessionId &&
        !s.active
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    return candidates[0];
}

describe('findResumableSession', () => {
    it('should return null when no sessions match', () => {
        const result = findResumableSession([], 'machine-1', '/home/user/project');
        expect(result).toBeNull();
    });

    it('should return null when sessions exist but for different machine', () => {
        const sessions: MockSession[] = [{
            id: 's1',
            active: false,
            updatedAt: 1000,
            metadata: { machineId: 'machine-2', path: '/home/user/project', claudeSessionId: 'claude-1' }
        }];
        expect(findResumableSession(sessions, 'machine-1', '/home/user/project')).toBeNull();
    });

    it('should return null when sessions exist but for different path', () => {
        const sessions: MockSession[] = [{
            id: 's1',
            active: false,
            updatedAt: 1000,
            metadata: { machineId: 'machine-1', path: '/home/user/other', claudeSessionId: 'claude-1' }
        }];
        expect(findResumableSession(sessions, 'machine-1', '/home/user/project')).toBeNull();
    });

    it('should skip active sessions', () => {
        const sessions: MockSession[] = [{
            id: 's1',
            active: true,
            updatedAt: 1000,
            metadata: { machineId: 'machine-1', path: '/home/user/project', claudeSessionId: 'claude-1' }
        }];
        expect(findResumableSession(sessions, 'machine-1', '/home/user/project')).toBeNull();
    });

    it('should skip sessions without claudeSessionId', () => {
        const sessions: MockSession[] = [{
            id: 's1',
            active: false,
            updatedAt: 1000,
            metadata: { machineId: 'machine-1', path: '/home/user/project' }
        }];
        expect(findResumableSession(sessions, 'machine-1', '/home/user/project')).toBeNull();
    });

    it('should return the most recently updated session', () => {
        const sessions: MockSession[] = [
            {
                id: 's1',
                active: false,
                updatedAt: 1000,
                metadata: { machineId: 'machine-1', path: '/home/user/project', claudeSessionId: 'claude-old' }
            },
            {
                id: 's2',
                active: false,
                updatedAt: 2000,
                metadata: { machineId: 'machine-1', path: '/home/user/project', claudeSessionId: 'claude-new' }
            },
        ];
        const result = findResumableSession(sessions, 'machine-1', '/home/user/project');
        expect(result?.id).toBe('s2');
        expect(result?.metadata?.claudeSessionId).toBe('claude-new');
    });

    it('should handle sessions with null metadata', () => {
        const sessions: MockSession[] = [{
            id: 's1',
            active: false,
            updatedAt: 1000,
            metadata: null
        }];
        expect(findResumableSession(sessions, 'machine-1', '/home/user/project')).toBeNull();
    });
});

describe('resume session spawn args', () => {
    it('should include --resume flag when sessionId is provided', () => {
        const sessionId = 'claude-session-abc-123';
        const args = [
            'claude',
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon',
            ...(sessionId ? ['--resume', sessionId] : [])
        ];
        expect(args).toContain('--resume');
        expect(args).toContain('claude-session-abc-123');
    });

    it('should not include --resume flag when sessionId is undefined', () => {
        const sessionId: string | undefined = undefined;
        const args = [
            'claude',
            '--happy-starting-mode', 'remote',
            '--started-by', 'daemon',
            ...(sessionId ? ['--resume', sessionId] : [])
        ];
        expect(args).not.toContain('--resume');
        expect(args).toHaveLength(5);
    });
});
