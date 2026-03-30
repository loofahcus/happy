import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export async function createSessionScanner(opts: {
    onModelChange?: (modelCode: string) => void,
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedMessageKeys = new Set<string>();

    // Mark existing messages as processed and start watching the initial session
    if (opts.sessionId) {
        let messages = await readSessionLog(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${messages.length} existing messages as processed from session ${opts.sessionId}`);
        for (let m of messages) {
            processedMessageKeys.add(messageKey(m));
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            sessions.push(p);
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionMessages = await readSessionLog(projectDir, session);
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                let key = messageKey(file);
                if (processedMessageKeys.has(key)) {
                    skipped++;
                    continue;
                }
                processedMessageKeys.add(key);
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                // Check for model changes (system or user local-command messages)
                if (opts.onModelChange) {
                    const modelCode = parseModelChangeFromMessage(file);
                    if (modelCode) {
                        opts.onModelChange(modelCode);
                    }
                }
                opts.onMessage(file);
                sent++;
            }
            if (sessionMessages.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(join(projectDir, `${p}.jsonl`), () => { sync.invalidate(); }));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (sessionId: string) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            if (finishedSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already finished, skipping`);
                return;
            }
            if (pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already pending, skipping`);
                return;
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//


/**
 * Parse model change from messages written by Claude Code's /model command.
 * The /model output appears as a user-type message with content wrapped in
 * <local-command-stdout> tags, or occasionally as a system-type message.
 * Returns a model code string (e.g. "opus", "sonnet", "haiku") or undefined.
 */
function parseModelChangeFromMessage(message: RawJSONLines): string | undefined {
    let text = '';
    if (message.type === 'system') {
        const raw = message as Record<string, unknown>;
        text = typeof raw.content === 'string' ? raw.content : typeof raw.message === 'string' ? raw.message : '';
    } else if (message.type === 'user') {
        const content = message.message.content;
        if (typeof content === 'string') {
            text = content;
        } else if (Array.isArray(content)) {
            // content can be an array of content blocks; concatenate text parts
            text = content
                .filter((b: Record<string, unknown>) => typeof b.text === 'string')
                .map((b: Record<string, unknown>) => b.text as string)
                .join('\n');
        }
    } else {
        return undefined;
    }
    // Strip XML wrapper: <local-command-stdout>...</local-command-stdout>
    const stdoutMatch = text.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/);
    if (stdoutMatch) text = stdoutMatch[1];
    // Strip ANSI escape codes (e.g. \x1b[1m, \x1b[22m)
    text = text.replace(/\x1b\[[0-9;]*m/g, '');
    // Match "Set model to <name>" or "Kept model as <name>"
    const match = text.match(/(?:Set model to|Kept model as) (.+)/i);
    if (!match) return undefined;
    const displayName = match[1];
    logger.debug(`[SESSION_SCANNER] Detected model change: "${displayName}"`);
    // Extract base model name (lowercase, simplified)
    const nameLower = displayName.toLowerCase();
    let baseModel: string;
    if (nameLower.includes('opus')) baseModel = 'opus';
    else if (nameLower.includes('haiku')) baseModel = 'haiku';
    else if (nameLower.includes('sonnet')) baseModel = 'sonnet';
    else if (nameLower.includes('gemini')) baseModel = 'gemini';
    else if (nameLower.includes('gpt')) baseModel = 'gpt';
    else baseModel = 'claude'; // fallback
    return baseModel;
}

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages, silently skipping internal events
 */
export async function readSessionLog(projectDir: string, sessionId: string): Promise<RawJSONLines[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let messages: RawJSONLines[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Filter out drain mechanism messages (keepalive pings and PONG responses)
            if (message.type === 'user' && typeof message.message?.content === 'string'
                && message.message.content.startsWith('[SYSTEM: Internal keepalive ping')) {
                continue;
            }
            if (message.type === 'assistant' && Array.isArray(message.message?.content)
                && message.message.content.length === 1 && message.message.content[0]?.type === 'text') {
                const pongText = message.message.content[0]?.text ?? '';
                if (pongText.trim() === 'PONG') {
                    continue;
                }
                if (/^PONG\s*\n/.test(pongText)) {
                    message = { ...message, message: { ...message.message, content: [{ ...message.message.content[0], text: pongText.replace(/^PONG\s*\n+/, '') }] } };
                }
            }

            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                // They will be tracked by processedMessageKeys to avoid reprocessing
                continue;
            }
            messages.push(parsed.data);
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return messages;
}
