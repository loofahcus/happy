import { describe, it, expect } from 'vitest';
import {
    initialLocalEchoState,
    onLocalInput,
    onLocalOutput,
    eraseSequence,
    type LocalEchoState,
} from './localEcho';

const normal = { alternateBuffer: false };
const alternate = { alternateBuffer: true };

/** Type a character and let its echo come back, the way a live prompt would. */
function typeAndEcho(state: LocalEchoState, ch: string) {
    const input = onLocalInput(state, ch, normal);
    const output = onLocalOutput(input.next);
    return { predicted: input.predict, erased: output.eraseCount, state: output.next };
}

describe('localEcho', () => {
    it('does not predict the first character at a prompt', () => {
        const { predict } = onLocalInput(initialLocalEchoState, 'l', normal);
        expect(predict).toBeNull();
    });

    it('predicts once the shell has been seen echoing', () => {
        const first = typeAndEcho(initialLocalEchoState, 'l');
        expect(first.predicted).toBeNull();
        expect(first.state.echoConfirmed).toBe(true);

        const second = onLocalInput(first.state, 's', normal);
        expect(second.predict).toBe('s');
        expect(second.next.predicted).toBe('s');
    });

    it('erases exactly what it drew when real output arrives', () => {
        let state = typeAndEcho(initialLocalEchoState, 'l').state;
        state = onLocalInput(state, 's', normal).next;
        state = onLocalInput(state, ' ', normal).next;
        state = onLocalInput(state, '-', normal).next;
        expect(state.predicted).toBe('s -');

        const output = onLocalOutput(state);
        expect(output.eraseCount).toBe(3);
        expect(output.next.predicted).toBe('');
    });

    // The security property: with ECHO off nothing ever comes back, so the
    // confirmation is never granted and not one character is drawn locally.
    it('never predicts at a password prompt, however long the password', () => {
        let state = initialLocalEchoState;
        for (const ch of 'correct horse battery staple') {
            const decision = onLocalInput(state, ch, normal);
            expect(decision.predict).toBeNull();
            state = decision.next;
        }
        expect(state.echoConfirmed).toBe(false);
        expect(state.predicted).toBe('');
    });

    it('drops the confirmation on Enter so the next prompt re-earns it', () => {
        let state = typeAndEcho(initialLocalEchoState, 'l').state;
        expect(onLocalInput(state, 's', normal).predict).toBe('s');

        state = onLocalInput(state, '\r', normal).next;
        expect(state.echoConfirmed).toBe(false);
        expect(onLocalInput(state, 'x', normal).predict).toBeNull();
    });

    it('drops the confirmation on keys that rewrite the line', () => {
        const confirmed = typeAndEcho(initialLocalEchoState, 'l').state;
        for (const key of ['\t', '\x1b', '\x1b[A', '\x1b[D', '\x03', '\x7f', '\x12']) {
            const decision = onLocalInput(confirmed, key, normal);
            expect(decision.predict).toBeNull();
            expect(decision.next.echoConfirmed).toBe(false);
        }
    });

    it('does not predict a paste', () => {
        const confirmed = typeAndEcho(initialLocalEchoState, 'l').state;
        const decision = onLocalInput(confirmed, 'git status', normal);
        expect(decision.predict).toBeNull();
        expect(decision.next.echoConfirmed).toBe(false);
    });

    it('never predicts inside a full-screen app', () => {
        const confirmed = typeAndEcho(initialLocalEchoState, 'l').state;
        const decision = onLocalInput(confirmed, 'j', alternate);
        expect(decision.predict).toBeNull();
        expect(decision.next.echoConfirmed).toBe(false);
    });

    it('stops predicting at the right edge, where an undo cannot unwrap', () => {
        const confirmed = typeAndEcho(initialLocalEchoState, 'l').state;
        const decision = onLocalInput(confirmed, 'x', {
            alternateBuffer: false,
            nearLineEnd: true,
        });
        expect(decision.predict).toBeNull();
        // The shell is still echoing, so the confirmation survives.
        expect(decision.next.echoConfirmed).toBe(true);
        expect(decision.next.predicted).toBe('');
    });

    it('predicts multi-byte characters as one erase unit', () => {
        let state = typeAndEcho(initialLocalEchoState, 'l').state;
        state = onLocalInput(state, '中', normal).next;
        expect(state.predicted).toBe('中');
        expect(onLocalOutput(state).eraseCount).toBe(1);
    });

    // Output that is nobody's echo must not hand out a confirmation, or a
    // background process printing at a password prompt would unlock prediction.
    it('ignores unsolicited output when no keystroke is outstanding', () => {
        const output = onLocalOutput(initialLocalEchoState);
        expect(output.next.echoConfirmed).toBe(false);
    });

    it('builds an erase sequence only when something was drawn', () => {
        expect(eraseSequence(0)).toBe('');
        expect(eraseSequence(-1)).toBe('');
        expect(eraseSequence(1)).toBe('\x1b[1D\x1b[K');
        expect(eraseSequence(3)).toBe('\x1b[3D\x1b[K');
    });
});
