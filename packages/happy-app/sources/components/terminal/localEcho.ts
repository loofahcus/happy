/**
 * Speculative local echo for the remote terminal.
 *
 * A remote terminal shows you a character only after the shell's echo has made
 * a full round trip (app → server → daemon → pty → back), so on a phone every
 * keystroke visibly lags. This predicts the common case — a printable
 * character typed at a prompt — by drawing it locally at once and erasing the
 * prediction when the authoritative output arrives.
 *
 * The whole design is about NOT predicting when prediction would be wrong:
 *
 * - **Password prompts.** `sudo` and `ssh` turn the tty's ECHO off, so drawing
 *   the character locally would put the password on screen. We never predict
 *   until we have *seen* the shell echo a character at the current prompt, and
 *   with ECHO off that confirmation never arrives. Cost: the first character
 *   after every prompt is unpredicted. Benefit: a password can never leak.
 *
 * - **Full-screen apps.** In vim/less/htop keys are commands, not text. The
 *   alternate screen buffer is the reliable signal, and prediction is off
 *   there entirely.
 *
 * - **Anything that is not one printable character.** Control keys, arrows,
 *   Tab (completion rewrites the line), Enter, and pastes are sent through
 *   unpredicted. Keys that change what the line means also drop the
 *   confirmation, so the next character has to re-earn it.
 *
 * - **The end of a line.** Taking a prediction back is a cursor-left plus
 *   erase-to-end-of-line, and cursor-left clamps at column one instead of
 *   stepping up to the previous row. A prediction that wrapped could not be
 *   undone cleanly, so the last columns are left to the real echo.
 */

export interface LocalEchoState {
    /** The shell was observed echoing our input at the current prompt. */
    readonly echoConfirmed: boolean;
    /** A keystroke is in flight and its echo has not come back yet. */
    readonly awaitingEcho: boolean;
    /** Characters drawn locally and not yet reconciled with real output. */
    readonly predicted: string;
}

export const initialLocalEchoState: LocalEchoState = {
    echoConfirmed: false,
    awaitingEcho: false,
    predicted: '',
};

export interface InputDecision {
    /** Text to draw locally right now, or null to draw nothing. */
    readonly predict: string | null;
    readonly next: LocalEchoState;
}

export interface OutputDecision {
    /** How many locally drawn characters to take back before writing real output. */
    readonly eraseCount: number;
    readonly next: LocalEchoState;
}

function isSinglePrintable(data: string): boolean {
    if (Array.from(data).length !== 1) return false;
    const cp = data.codePointAt(0)!;
    // Printable ASCII plus anything above the C1 range, so CJK and emoji count.
    if (cp === 0x7f) return false;
    return cp >= 0x20 && (cp < 0x80 || cp > 0x9f);
}

/**
 * Decide what to draw for an outgoing keystroke.
 *
 * `alternateBuffer` is xterm's `buffer.active.type === 'alternate'`.
 */
export function onLocalInput(
    state: LocalEchoState,
    data: string,
    options: { alternateBuffer: boolean; nearLineEnd?: boolean },
): InputDecision {
    // Full-screen app: keys are commands. Never predict, and require the next
    // prompt to re-confirm once the app exits.
    if (options.alternateBuffer) {
        return {
            predict: null,
            next: { echoConfirmed: false, awaitingEcho: false, predicted: '' },
        };
    }

    if (!isSinglePrintable(data)) {
        // Enter, Ctrl-C, arrows, Tab, Esc, pastes. Each can change what the
        // line means or what is reading it, so the confirmation is dropped and
        // any outstanding prediction is abandoned — the real output that
        // follows is authoritative and will repaint.
        return {
            predict: null,
            next: { echoConfirmed: false, awaitingEcho: false, predicted: '' },
        };
    }

    if (!state.echoConfirmed) {
        // The probe keystroke. Send it, draw nothing, and wait to see whether
        // the shell echoes it. This is the branch that keeps passwords off the
        // screen.
        return {
            predict: null,
            next: { ...state, awaitingEcho: true },
        };
    }

    if (options.nearLineEnd) {
        // Too close to the right edge to undo a wrap. Keep the confirmation —
        // the shell is still echoing — but let this character come the long way.
        return {
            predict: null,
            next: { ...state, awaitingEcho: true },
        };
    }

    return {
        predict: data,
        next: {
            echoConfirmed: true,
            awaitingEcho: true,
            predicted: state.predicted + data,
        },
    };
}

/**
 * Decide how to reconcile arriving output with what was drawn locally.
 *
 * Output only earns the echo confirmation when a keystroke is actually
 * outstanding; otherwise a background process printing at a password prompt
 * could hand us a confirmation we never observed.
 */
export function onLocalOutput(state: LocalEchoState): OutputDecision {
    const eraseCount = Array.from(state.predicted).length;
    return {
        eraseCount,
        next: {
            echoConfirmed: state.echoConfirmed || state.awaitingEcho,
            awaitingEcho: false,
            predicted: '',
        },
    };
}

/**
 * Escape sequence that takes back `count` locally drawn characters: step the
 * cursor left and clear to end of line, so the real output repaints from there.
 */
export function eraseSequence(count: number): string {
    if (count <= 0) return '';
    return `\x1b[${count}D\x1b[K`;
}
