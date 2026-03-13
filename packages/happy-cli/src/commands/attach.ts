/**
 * Attach command - take local control of a remote session.
 *
 * Flow:
 * 1. Query daemon for active sessions
 * 2. User picks (or specifies) a session
 * 3. Stop the daemon's child process for that session
 * 4. Start a new happy process in the session's directory,
 *    resuming the Claude Code conversation via --resume
 */

import chalk from 'chalk';
import { logger } from '@/ui/logger';
import {
    listDaemonSessions,
    stopDaemonSession,
    DaemonSession,
} from '@/daemon/controlClient';
import { runClaude, StartOptions } from '@/claude/runClaude';
import { Credentials } from '@/persistence';

export async function handleAttachCommand(
    args: string[],
    credentials: Credentials,
): Promise<void> {
    let targetSessionId: string | undefined;

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '-h' || arg === '--help') {
            printHelp();
            return;
        }
        // First non-flag argument is the session ID
        if (!arg.startsWith('-') && !targetSessionId) {
            targetSessionId = arg;
        }
    }

    // Fetch active sessions from daemon
    let sessions: DaemonSession[];
    try {
        sessions = await listDaemonSessions();
    } catch {
        console.error(chalk.red('Failed to connect to daemon. Is it running?'));
        console.error(chalk.gray('Start it with: happy daemon start'));
        process.exit(1);
    }

    if (sessions.length === 0) {
        console.error(chalk.yellow('No active sessions found in daemon.'));
        process.exit(1);
    }

    // Resolve target session
    let session: DaemonSession | undefined;

    if (targetSessionId) {
        // Match by happy session ID (prefix match)
        session = sessions.find(
            (s) =>
                s.happySessionId === targetSessionId ||
                s.happySessionId.startsWith(targetSessionId!),
        );
        if (!session) {
            console.error(
                chalk.red(`Session not found: ${targetSessionId}`),
            );
            console.error(chalk.gray('Available sessions:'));
            printSessionList(sessions);
            process.exit(1);
        }
    } else if (sessions.length === 1) {
        // Auto-select the only session
        session = sessions[0];
    } else {
        // Multiple sessions — ask user to specify
        console.log(chalk.bold('Multiple active sessions found:\n'));
        printSessionList(sessions);
        console.log(
            chalk.gray(
                '\nSpecify a session ID: happy attach <session-id>',
            ),
        );
        process.exit(1);
    }

    const claudeSessionId = session.claudeSessionId;
    const sessionPath = session.path;

    if (!sessionPath) {
        console.error(
            chalk.red(
                'Session has no path metadata. Cannot determine working directory.',
            ),
        );
        process.exit(1);
    }

    console.log(chalk.blue(`Attaching to session ${chalk.bold(session.happySessionId.slice(0, 8))}...`));
    console.log(chalk.gray(`  Path: ${sessionPath}`));
    if (claudeSessionId) {
        console.log(chalk.gray(`  Claude session: ${claudeSessionId.slice(0, 8)}...`));
    }
    console.log(chalk.gray(`  Agent: ${session.flavor || 'claude'}`));

    // Stop the daemon's child process for this session
    logger.debug(`[attach] Stopping daemon process for session ${session.happySessionId}`);
    const stopped = await stopDaemonSession(session.happySessionId);
    if (!stopped) {
        console.error(chalk.yellow('Warning: Could not stop daemon process. It may have already exited.'));
    }

    // Give a moment for the process to clean up
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Change to the session's working directory
    try {
        process.chdir(sessionPath);
    } catch {
        console.error(chalk.red(`Cannot access directory: ${sessionPath}`));
        process.exit(1);
    }

    // Build options for runClaude
    const options: StartOptions = {
        startingMode: 'local',
    };

    // Resume Claude Code session if we have the ID
    if (claudeSessionId) {
        options.claudeArgs = ['--resume', claudeSessionId];
    }

    console.log(chalk.green('✓ Attached. You now have local control.\n'));

    // Start the claude loop — this takes over the terminal
    await runClaude(credentials, options);
}

function printSessionList(sessions: DaemonSession[]): void {
    for (const s of sessions) {
        const id = s.happySessionId.slice(0, 8);
        const path = s.path || 'unknown';
        const agent = s.flavor || 'claude';
        const startedBy = s.startedBy === 'daemon' ? chalk.cyan('remote') : chalk.gray('local');
        console.log(
            `  ${chalk.bold(id)}  ${path}  ${agent}  ${startedBy}`,
        );
    }
}

function printHelp(): void {
    console.log(`
${chalk.bold('happy attach')} - Take local control of a remote session

${chalk.bold('Usage:')}
  happy attach                     Attach to the only active session
  happy attach <session-id>        Attach to a specific session (prefix match)
  happy attach -h, --help          Show this help

${chalk.bold('How it works:')}
  1. Stops the daemon's remote process for the session
  2. Starts a local Claude session that resumes the conversation
  3. You get full terminal control with the existing context

${chalk.bold('Examples:')}
  happy attach                     Auto-attach if only one session
  happy attach abc123de            Attach by session ID prefix
`);
}
