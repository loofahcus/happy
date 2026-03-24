import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage, SDKSystemMessage, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from '@/claude/sdk';
import type { EnhancedMode } from './loop';
import { PushableAsyncIterable } from '@/utils/PushableAsyncIterable';

// ---------------------------------------------------------------------------
// Helpers – reusable SDK message factories
// ---------------------------------------------------------------------------

function systemInit(sessionId: string): SDKSystemMessage {
    return { type: 'system', subtype: 'init', session_id: sessionId };
}

function systemTaskStarted(): SDKMessage {
    return { type: 'system', subtype: 'task_started' } as SDKMessage;
}

function systemTaskNotification(): SDKMessage {
    return { type: 'system', subtype: 'task_notification' } as SDKMessage;
}

function assistantText(text: string): SDKAssistantMessage {
    return {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
    };
}

function result(sessionId = 'test-session'): SDKResultMessage {
    return {
        type: 'result',
        subtype: 'success',
        result: '',
        num_turns: 1,
        total_cost_usd: 0,
        duration_ms: 0,
        duration_api_ms: 0,
        is_error: false,
        session_id: sessionId,
    };
}

const defaultMode: EnhancedMode = { permissionMode: 'default' };

// ---------------------------------------------------------------------------
// Mock – `query` returns a controllable async iterable (sdkStream).
// Tests push messages into sdkStream to simulate SDK output.
// We also capture what user messages were pushed into the prompt iterable.
// ---------------------------------------------------------------------------

let sdkStream: PushableAsyncIterable<SDKMessage>;
let capturedPrompt: AsyncIterable<SDKUserMessage> | null;

const { mockQuery, mockCheckSession, mockAwaitFileExist, mockParseSpecialCommand } = vi.hoisted(() => ({
    mockQuery: vi.fn(),
    mockCheckSession: vi.fn(),
    mockAwaitFileExist: vi.fn(),
    mockParseSpecialCommand: vi.fn(),
}));

vi.mock('@/claude/sdk', () => ({
    query: mockQuery,
    AbortError: class AbortError extends Error {},
}));

vi.mock('./utils/claudeCheckSession', () => ({
    claudeCheckSession: mockCheckSession,
}));

vi.mock('@/modules/watcher/awaitFileExist', () => ({
    awaitFileExist: mockAwaitFileExist,
}));

vi.mock('@/parsers/specialCommands', () => ({
    parseSpecialCommand: mockParseSpecialCommand,
}));

vi.mock('@/lib', () => ({
    logger: { debug: vi.fn(), debugLargeJson: vi.fn() },
}));

vi.mock('./utils/permissionMode', () => ({
    mapToClaudeMode: (m: string) => m,
}));

vi.mock('@/projectPath', () => ({
    projectPath: () => '/tmp/test',
}));

vi.mock('./utils/path', () => ({
    getProjectPath: () => '/tmp/test/.claude/projects',
}));

vi.mock('./utils/systemPrompt', () => ({
    systemPrompt: '',
}));

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

/** Collects every user message pushed into the PushableAsyncIterable prompt */
function collectPushedUserMessages(prompt: AsyncIterable<SDKUserMessage>): string[] {
    // The prompt is a PushableAsyncIterable – its internal queue holds pushed values.
    // We intercept `push` via the reference captured by mockQuery.
    const messages: string[] = [];
    const orig = (prompt as PushableAsyncIterable<SDKUserMessage>).push.bind(prompt);
    (prompt as PushableAsyncIterable<SDKUserMessage>).push = (value: SDKUserMessage) => {
        messages.push(typeof value.message.content === 'string' ? value.message.content : JSON.stringify(value.message.content));
        orig(value);
    };
    return messages;
}

beforeEach(() => {
    vi.clearAllMocks();

    sdkStream = new PushableAsyncIterable<SDKMessage>();
    capturedPrompt = null;

    mockQuery.mockImplementation((config: { prompt: AsyncIterable<SDKUserMessage> }) => {
        capturedPrompt = config.prompt;
        return sdkStream;
    });

    mockCheckSession.mockReturnValue(false);
    mockAwaitFileExist.mockResolvedValue(true);
    mockParseSpecialCommand.mockReturnValue({ type: null });
});

// ---------------------------------------------------------------------------
// Build default opts for claudeRemote – callers can override individual fields
// ---------------------------------------------------------------------------

function makeOpts(overrides: {
    nextMessages?: Array<{ message: string; mode: EnhancedMode } | null>;
    onMessage?: ReturnType<typeof vi.fn>;
    onReady?: ReturnType<typeof vi.fn>;
    onSessionFound?: ReturnType<typeof vi.fn>;
    onThinkingChange?: ReturnType<typeof vi.fn>;
    sessionId?: string | null;
} = {}) {
    const nextMessages = overrides.nextMessages ?? [
        { message: 'Hello', mode: defaultMode },
        null, // end
    ];
    let callIndex = 0;

    const onReady = overrides.onReady ?? vi.fn();

    return {
        sessionId: overrides.sessionId ?? null,
        path: '/tmp/test',
        allowedTools: [],
        hookSettingsPath: '/tmp/hooks.json',
        canCallTool: vi.fn().mockResolvedValue({ behavior: 'allow' as const, updatedInput: {} }),
        nextMessage: vi.fn(async () => {
            const msg = nextMessages[callIndex];
            callIndex++;
            return msg ?? null;
        }),
        onReady,
        isAborted: vi.fn().mockReturnValue(false),
        onSessionFound: overrides.onSessionFound ?? vi.fn(),
        onThinkingChange: overrides.onThinkingChange ?? vi.fn(),
        onMessage: overrides.onMessage ?? vi.fn(),
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Lazy import so mocks are installed first
const importClaudeRemote = () => import('./claudeRemote').then(m => m.claudeRemote);

describe('claudeRemote – drain mechanism', () => {

    // -----------------------------------------------------------------------
    // Scenario A: Normal message without background tasks
    // -----------------------------------------------------------------------
    it('delivers a normal response without drain interference', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();
        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: 'What is X?', mode: defaultMode },
                null,
            ],
        });

        const promise = claudeRemote(opts);

        // Wait for query to be called
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());

        // SDK sends assistant response + result
        sdkStream.push(assistantText('X is great'));
        sdkStream.push(result());

        // After result, claudeRemote calls onReady then nextMessage (which returns null → exit)
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        // User should see the assistant message
        expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'assistant',
        }));
    });

    // -----------------------------------------------------------------------
    // Scenario B: User message + 1 pending notification → drain → re-send
    // -----------------------------------------------------------------------
    it('re-sends the user message after draining a single notification', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();
        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: 'What is X?', mode: defaultMode },
                null,
            ],
        });

        const promise = claudeRemote(opts);
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());

        // Intercept pushes to see user messages sent to SDK
        const pushed = collectPushedUserMessages(capturedPrompt!);

        // Turn 1: Claude delivers a task notification instead of answering
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Background task completed'));
        sdkStream.push(result());

        // After Branch 1: a drain message should be auto-pushed
        await vi.waitFor(() => {
            expect(pushed.some(m => m.includes('drain message'))).toBe(true);
        });

        // Turn 2 (drain): Claude responds OK → suppressed
        sdkStream.push(assistantText('OK'));
        sdkStream.push(result());

        // After drain: Branch 2 re-sends user message
        await vi.waitFor(() => {
            expect(pushed.filter(m => m === 'What is X?').length).toBe(1); // re-send only (initial push is before wrapper) // initial + re-send
        });

        // Turn 3 (re-send): Claude answers properly
        sdkStream.push(assistantText('X is the answer'));
        sdkStream.push(result());

        // Wait for ready (session back to idle)
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        // User should see: notification response + real answer, but NOT drain "OK"
        const visibleAssistants = (onMessage.mock.calls as [SDKMessage][])
            .filter(([m]) => m.type === 'assistant')
            .map(([m]) => ((m as SDKAssistantMessage).message.content[0] as { text: string }).text);

        expect(visibleAssistants).toContain('Background task completed');
        expect(visibleAssistants).toContain('X is the answer');
        expect(visibleAssistants).not.toContain('OK');
    });

    // -----------------------------------------------------------------------
    // Scenario C: User message + 2 pending notifications → chained drain
    // -----------------------------------------------------------------------
    it('handles two consecutive notifications without hanging', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();
        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: 'What is X?', mode: defaultMode },
                null,
            ],
        });

        const promise = claudeRemote(opts);
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());
        const pushed = collectPushedUserMessages(capturedPrompt!);

        // Turn 1: notification A
        sdkStream.push(systemTaskStarted()); // for count tracking
        sdkStream.push(systemTaskStarted());
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Task A done'));
        sdkStream.push(result());

        // Drain message pushed
        await vi.waitFor(() => {
            expect(pushed.some(m => m.includes('drain message'))).toBe(true);
        });

        // Turn 2 (drain): notification B delivered during drain
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Task B done'));
        sdkStream.push(result());

        // Another drain should be pushed (previously this would hang)
        await vi.waitFor(() => {
            const drainCount = pushed.filter(m => m.includes('drain message')).length;
            expect(drainCount).toBe(2);
        });

        // Turn 3 (drain): clean OK
        sdkStream.push(assistantText('OK'));
        sdkStream.push(result());

        // Should re-send user message
        await vi.waitFor(() => {
            expect(pushed.filter(m => m === 'What is X?').length).toBe(1); // re-send only (initial push is before wrapper)
        });

        // Turn 4 (re-send): actual answer
        sdkStream.push(assistantText('X is the answer'));
        sdkStream.push(result());

        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        // Verify visibility: notification responses visible, drain OKs suppressed
        const visibleAssistants = (onMessage.mock.calls as [SDKMessage][])
            .filter(([m]) => m.type === 'assistant')
            .map(([m]) => ((m as SDKAssistantMessage).message.content[0] as { text: string }).text);

        expect(visibleAssistants).toContain('Task A done');
        expect(visibleAssistants).not.toContain('Task B done'); // suppressed (during drain)
        expect(visibleAssistants).not.toContain('OK');
        expect(visibleAssistants).toContain('X is the answer');
    });

    // -----------------------------------------------------------------------
    // Scenario D: Resume without prompt + notification → no hang
    // -----------------------------------------------------------------------
    it('drains notification during resume-without-prompt without re-sending', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();

        mockCheckSession.mockReturnValue(true);

        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: '  ', mode: defaultMode }, // blank → resume without prompt
                null,
            ],
            sessionId: 'existing-session',
        });

        const promise = claudeRemote(opts);
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());
        const pushed = collectPushedUserMessages(capturedPrompt!);

        // Initial drain turn encounters notification
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Task done'));
        sdkStream.push(result());

        // Another drain should be pushed
        await vi.waitFor(() => {
            const drainCount = pushed.filter(m => m.includes('drain message')).length;
            expect(drainCount).toBe(1); // notification drain only (initial drain push before wrapper)
        });

        // Clean drain
        sdkStream.push(assistantText('OK'));
        sdkStream.push(result());

        // Should NOT re-send (lastUserMessage is null for resume-without-prompt)
        // Should go to onReady
        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        // All messages from drain turns should be suppressed
        const visibleAssistants = (onMessage.mock.calls as [SDKMessage][])
            .filter(([m]) => m.type === 'assistant');
        expect(visibleAssistants).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Scenario E: Resume with prompt + notification → re-send initial message
    // -----------------------------------------------------------------------
    it('re-sends initial message if consumed by notification during resume-with-prompt', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();

        mockCheckSession.mockReturnValue(true);

        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: 'Do something', mode: defaultMode },
                null,
            ],
            sessionId: 'existing-session',
        });

        const promise = claudeRemote(opts);
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());
        const pushed = collectPushedUserMessages(capturedPrompt!);

        // Turn 1: notification instead of answer
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Background task done'));
        sdkStream.push(result());

        // Drain pushed
        await vi.waitFor(() => {
            expect(pushed.some(m => m.includes('drain message'))).toBe(true);
        });

        // Drain turn
        sdkStream.push(assistantText('OK'));
        sdkStream.push(result());

        // Should re-send initial message
        await vi.waitFor(() => {
            expect(pushed.filter(m => m === 'Do something').length).toBe(1); // re-send only
        });

        // Re-send turn: answer
        sdkStream.push(assistantText('Done!'));
        sdkStream.push(result());

        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        const visibleAssistants = (onMessage.mock.calls as [SDKMessage][])
            .filter(([m]) => m.type === 'assistant')
            .map(([m]) => ((m as SDKAssistantMessage).message.content[0] as { text: string }).text);

        expect(visibleAssistants).toContain('Background task done');
        expect(visibleAssistants).toContain('Done!');
        expect(visibleAssistants).not.toContain('OK');
    });

    // -----------------------------------------------------------------------
    // Scenario F: Drain suppresses all message types during drain turns
    // -----------------------------------------------------------------------
    it('suppresses system and result messages during drain turns', async () => {
        const claudeRemote = await importClaudeRemote();
        const onMessage = vi.fn();
        const onReady = vi.fn();
        const opts = makeOpts({
            onMessage,
            onReady,
            nextMessages: [
                { message: 'Hello', mode: defaultMode },
                null,
            ],
        });

        const promise = claudeRemote(opts);
        await vi.waitFor(() => expect(mockQuery).toHaveBeenCalled());
        const pushed = collectPushedUserMessages(capturedPrompt!);

        // Turn 1: notification
        sdkStream.push(systemTaskNotification());
        sdkStream.push(assistantText('Notification'));
        sdkStream.push(result());

        // Wait for drain message to be pushed
        await vi.waitFor(() => {
            expect(pushed.some(m => m.includes('drain message'))).toBe(true);
        });

        // Drain turn: push system + assistant + result — all should be suppressed
        sdkStream.push({ type: 'system', subtype: 'other' } as SDKMessage);
        sdkStream.push(assistantText('OK'));
        sdkStream.push(result());

        // Wait for re-send to be pushed
        await vi.waitFor(() => {
            expect(pushed.some(m => m === 'Hello')).toBe(true);
        });

        // Re-send turn: real answer
        sdkStream.push(assistantText('Real answer'));
        sdkStream.push(result());

        await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
        await promise;

        // The system 'other' and assistant 'OK' during drain should NOT appear
        const allTypes = (onMessage.mock.calls as [SDKMessage][]).map(([m]) => `${m.type}:${(m as any).message?.content?.[0]?.text ?? (m as any).subtype ?? ''}`);
        expect(allTypes).not.toContain('system:other');
        expect(allTypes).not.toContain('assistant:OK');
        expect(allTypes).toContain('assistant:Real answer');
    });
});
