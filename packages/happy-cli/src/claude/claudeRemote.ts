import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, type SDKAssistantMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join, resolve } from 'node:path';
import { projectPath } from "@/projectPath";
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void | Promise<void>,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt : systemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        executable: opts.jsRuntime ?? 'node',
        abort: opts.signal,
        pathToClaudeCodeExecutable: (() => {
            return resolve(join(projectPath(), 'scripts', 'claude_remote_launcher.cjs'));
        })(),
        settingsPath: opts.hookSettingsPath,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Background task drain mechanism.
    // When Claude Code has pending background task notifications, they are delivered
    // as system messages (subtype: task_notification) during a turn. Two cases:
    //
    // A. Drain cycle (isDrainTurn = true): started by resume-without-prompt to unblock
    //    stdin. If a notification arrives during a drain turn, only push another drain
    //    message if none are already queued (outstandingDrainCount prevents orphans).
    //    Continue until no more notifications, then wait for real user input.
    //
    // B. Normal user turn (inline): notification arrives while Claude is processing a real
    //    message. Claude already handled it inline — do nothing, wait for user response.
    //
    // C. Auto-delivered notification: SDK delivers the notification as a separate sub-turn
    //    BEFORE processing the pending user message. bgCountAtLastPush > 0 detects this —
    //    skip onReady/nextMessage and let the for-await loop process the user message response.
    let pendingBackgroundTaskCount = 0;
    let isTaskNotificationTurn = false;
    let isDrainTurn = false;
    let outstandingDrainCount = 0;  // Track drain messages pushed to SDK queue but not yet consumed
    let bgCountAtLastPush = 0;  // pendingBackgroundTaskCount at the time the last user message was pushed

    const DRAIN_MESSAGE = "This is a drain message, just ignore it and respond with a simple `OK`";

    // Push initial message - always push something so stream-json stdin is unblocked.
    // For resume without prompt, send a drain message and suppress it from webapp.
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    const isResumeWithoutPrompt = !!startFrom && !initial.message.trim();
    if (isResumeWithoutPrompt) { isDrainTurn = true; outstandingDrainCount++; }
    // Send historical messages to client when resuming a session (first spawn only)
    const isFirstResume = opts.claudeArgs?.includes('--resume') ?? false;
    if (isFirstResume && startFrom && opts.onResumeHistory) {
        await opts.onResumeHistory(startFrom);
    }
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: isResumeWithoutPrompt ? DRAIN_MESSAGE : initial.message,
        },
    });
    bgCountAtLastPush = pendingBackgroundTaskCount;
    if (!isResumeWithoutPrompt) { pendingUserMessage = { message: initial.message, mode: initial.mode }; }

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    updateThinking(true);
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Track background task lifecycle and detect task_notification turns
            if (message.type === 'system') {
                const subtype = (message as any).subtype;
                if (subtype === 'task_started') {
                    pendingBackgroundTaskCount++;
                    logger.debug(`[claudeRemote] Background task started, pending count: ${pendingBackgroundTaskCount}`);
                }
                if (subtype === 'task_notification') {
                    pendingBackgroundTaskCount = Math.max(0, pendingBackgroundTaskCount - 1);
                    isTaskNotificationTurn = true;
                    logger.debug(`[claudeRemote] Task notification received, pending count: ${pendingBackgroundTaskCount}`);
                }
            }

            // If an assistant message arrives after a task_notification, the notification was
            // delivered inline (not as a separate sub-turn). Reset the flag so the next result
            // is not misclassified as a notification sub-turn result, which would cause a hang.
            if (message.type === 'assistant' && isTaskNotificationTurn) {
                logger.debug('[claudeRemote] Assistant message after task_notification — inline notification, clearing isTaskNotificationTurn');
                isTaskNotificationTurn = false;
            }

            // Always suppress drain-related messages and strip PONG from mixed content.
            // PONG-only responses and DRAIN_MESSAGE echoes are never legitimate content.
            let messageToForward: SDKMessage | null = message;
            if (message.type === 'user' && typeof (message as SDKUserMessage).message?.content === 'string'
                && (message as SDKUserMessage).message.content === DRAIN_MESSAGE) {
                messageToForward = null;
            } else if (message.type === 'assistant') {
                const c = (message as SDKAssistantMessage).message?.content as any;
                if (typeof c === 'string' && c.trim() === 'PONG') {
                    messageToForward = null;
                } else if (Array.isArray(c) && c.length === 1 && c[0].type === 'text') {
                    const text = c[0].text ?? '';
                    if (text.trim() === 'PONG') {
                        messageToForward = null;
                    } else if (/^PONG\s*\n/.test(text)) {
                        const stripped = text.replace(/^PONG\s*\n+/, '');
                        messageToForward = { ...message as SDKAssistantMessage, message: { ...(message as SDKAssistantMessage).message, content: [{ ...c[0], text: stripped }] } } as SDKMessage;
                        logger.debug('[claudeRemote] Stripped PONG prefix from mixed assistant content');
                    }
                }
            }
            if (messageToForward) { opts.onMessage(messageToForward); }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                updateThinking(true);
                const systemInit = message as SDKSystemMessage;
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages - with drain mechanism for background task notifications
            if (message.type === 'result') {
                updateThinking(false);
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) { opts.onCompletionEvent('Compaction completed'); }
                    isCompactCommand = false;
                }

                // Branch 1: Result from a task notification turn.
                if (isTaskNotificationTurn) {
                    isTaskNotificationTurn = false;
                    if (isDrainTurn) {
                        logger.debug(`[claudeRemote] Task notification in drain turn - continuing drain (pending: ${pendingBackgroundTaskCount}, outstanding drains: ${outstandingDrainCount})`);
                        outstandingDrainCount = Math.max(0, outstandingDrainCount - 1);
                        if (outstandingDrainCount <= 0) {
                            outstandingDrainCount++;
                            messages.push({ type: 'user', message: { role: 'user', content: DRAIN_MESSAGE } });
                        }
                        updateThinking(true);
                        continue;
                    }
                    // Auto-delivered notification: SDK processes the notification as a separate
                    // sub-turn before the real user message. If pendingUserMessage is set, the
                    // user message has not been processed yet — continue to read its response.
                    if (pendingUserMessage) {
                        logger.debug(`[claudeRemote] Notification sub-turn with pending user message, continuing to user message response`);
                        continue;
                    }
                    // Inline notification (no pending user message) — fall through to Done.
                }

                // Decrement outstanding drain counter for completed drain turns
                if (isDrainTurn) {
                    outstandingDrainCount = Math.max(0, outstandingDrainCount - 1);
                }

                // Clear drain state when all outstanding drain messages are consumed
                if (outstandingDrainCount <= 0) {
                    isDrainTurn = false;
                }


                // Done
                logger.debug('[claudeRemote] Result received, waiting for next message');
                pendingUserMessage = null;
                await opts.onReady();
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
                bgCountAtLastPush = pendingBackgroundTaskCount;
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
    }
}