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
    /** Inject Happy's system prompt and tools into Claude sessions (default: false) */
    happyInject?: boolean,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onResumeHistory?: (resumeSessionId: string) => Promise<void>,
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
        customSystemPrompt: initial.mode.customSystemPrompt
            ? opts.happyInject
                ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt
                : initial.mode.customSystemPrompt
            : undefined,
        appendSystemPrompt: initial.mode.appendSystemPrompt
            ? opts.happyInject
                ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt
                : initial.mode.appendSystemPrompt
            : opts.happyInject
                ? systemPrompt
                : undefined,
        allowedTools: opts.happyInject
            ? initial.mode.allowedTools
                ? initial.mode.allowedTools.concat(opts.allowedTools)
                : opts.allowedTools
            : initial.mode.allowedTools,
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
    //    stdin. If a notification arrives during a drain turn, push another drain message
    //    to clear it. Continue until no more notifications, then wait for real user input.
    //
    // B. Normal user turn: notification arrives while Claude is processing a real message.
    //    Claude already handled it inline — do nothing, wait for user response as usual.
    let pendingBackgroundTaskCount = 0;
    let isTaskNotificationTurn = false;
    let isDrainTurn = false; // When true, we are in a drain cycle (prevents double-drain)
    let suppressDrainMessages = false; // When true, suppress onMessage to hide drain turns from webapp
    let postReadyDrainStarted = false; // When true, we already started a post-ready drain cycle

    // Push initial message - always push something so stream-json stdin is unblocked
    // For resume without prompt, send a drain message and suppress it from webapp via isDrainTurn
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    const isResumeWithoutPrompt = !!startFrom && !initial.message.trim();
    if (isResumeWithoutPrompt) { isDrainTurn = true; suppressDrainMessages = true; }
    // Send historical messages to client before starting the drain turn
    if (isResumeWithoutPrompt && startFrom && opts.onResumeHistory) {
        await opts.onResumeHistory(startFrom);
    }
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: isResumeWithoutPrompt ? "This's a drain message, just ignore it and respond with a simple `OK`." : initial.message,
        },
    });

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
                logger.debug(`[claudeRemote] System message subtype: ${subtype}, keys: ${Object.keys(message).join(',')}`); 
                if (subtype === 'task_started') {
                    pendingBackgroundTaskCount++;
                    logger.debug(`[claudeRemote] Background task started, pending count: ${pendingBackgroundTaskCount}`);
                }
                if (subtype === 'task_notification') {
                    pendingBackgroundTaskCount = Math.max(0, pendingBackgroundTaskCount - 1);
                    isTaskNotificationTurn = true;
                    logger.debug(`[claudeRemote] Task notification received, pending count: ${pendingBackgroundTaskCount}, marking turn as task_notification`);
                }
            }

            // Detect background task launches from assistant tool_use blocks
            if (message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                if (assistantMsg.message?.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.input) {
                            const input = block.input as Record<string, unknown>;
                            if (input.run_in_background === true) {
                                logger.debug(`[claudeRemote] Background task detected: ${block.name} (${block.id})`);
                            }
                        }
                    }
                }
            }

            // Handle messages - suppress during drain turns
            if (!suppressDrainMessages) { opts.onMessage(message); }

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages - with hold-and-drain for background task notifications
            if (message.type === 'result') {
                updateThinking(false);

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Branch 1: This result is from a background task notification turn.
                // Only auto-drain if we are already in a drain cycle (isDrainTurn = true).
                // If the notification arrived during a normal user turn, Claude already
                // handled it — fall through and wait for the user to respond normally.
                if (isTaskNotificationTurn) {
                    isTaskNotificationTurn = false;
                    if (isDrainTurn) {
                        // Continue draining: push another synthetic message to clear this turn.
                        // The previous drain already completed (its result was received),
                        // so this is a new drain, not a double-drain race.
                        suppressDrainMessages = true;
                        logger.debug(`[claudeRemote] Task notification in drain turn - continuing drain (pending tasks: ${pendingBackgroundTaskCount})`);
                        messages.push({ type: 'user', message: { role: 'user', content: 'This is a drain message, just ignore it and respond with a simple `OK`' } });
                        updateThinking(true);
                        continue;
                    }
                    // Notification arrived during a normal user turn — Claude already processed it.
                    // Fall through to normal result handling (wait for user).
                    logger.debug(`[claudeRemote] Task notification in normal user turn - not draining, waiting for user (pending tasks: ${pendingBackgroundTaskCount})`);
                }
                // Clear drain state.
                isDrainTurn = false;
                suppressDrainMessages = false;

                // Flush any remaining pending task notifications before accepting user input.
                // postReadyDrainStarted prevents re-triggering: if a drain turn produces no
                // notification, the task is still running — stop and wait for user instead.
                if (!postReadyDrainStarted && pendingBackgroundTaskCount > 0) {
                    postReadyDrainStarted = true;
                    isDrainTurn = true;
                    suppressDrainMessages = true;
                    logger.debug(`[claudeRemote] Post-ready drain: flushing ${pendingBackgroundTaskCount} pending task notification(s)`);
                    messages.push({ type: 'user', message: { role: 'user', content: 'This is a drain message, just ignore it and respond with a simple `OK`' } });
                    updateThinking(true);
                    continue;
                }

                // Done — either no drain needed, or drain cycle just completed.
                postReadyDrainStarted = false;
                logger.debug('[claudeRemote] Result received, waiting for next message');
                opts.onReady();
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;

                // Send user message immediately. Any pending task notifications will be
                // delivered as system messages in this turn; Claude handles them inline.
                logger.debug(`[claudeRemote] Sending user message immediately (pending background tasks: ${pendingBackgroundTaskCount})`);
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
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