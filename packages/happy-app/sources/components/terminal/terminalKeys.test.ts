import { describe, it, expect } from 'vitest';
import {
    stripTerminalResponses,
    toControlCode,
    describeBytes,
    TERMINAL_KEYS,
} from './terminalKeys';

describe('toControlCode', () => {
    it('folds letters into 0x01..0x1a regardless of case', () => {
        expect(toControlCode('a')).toBe('\x01');
        expect(toControlCode('A')).toBe('\x01');
        expect(toControlCode('c')).toBe('\x03');
        expect(toControlCode('C')).toBe('\x03');
        expect(toControlCode('d')).toBe('\x04');
        expect(toControlCode('z')).toBe('\x1a');
    });

    it('keeps the traditional punctuation control codes', () => {
        expect(toControlCode('@')).toBe('\x00');
        expect(toControlCode(' ')).toBe('\x00');
        expect(toControlCode('[')).toBe('\x1b');
        expect(toControlCode('\\')).toBe('\x1c');
        expect(toControlCode(']')).toBe('\x1d');
        expect(toControlCode('^')).toBe('\x1e');
        expect(toControlCode('_')).toBe('\x1f');
        expect(toControlCode('?')).toBe('\x7f');
    });

    // Null means "send it unchanged", which is what disarms sticky Ctrl on a
    // key it cannot modify instead of swallowing the keystroke.
    it('returns null for characters with no control code', () => {
        expect(toControlCode('1')).toBeNull();
        expect(toControlCode('中')).toBeNull();
        expect(toControlCode('')).toBeNull();
        expect(toControlCode('ab')).toBeNull();
    });
});

describe('stripTerminalResponses', () => {
    it('removes device replies that would otherwise echo forever', () => {
        expect(stripTerminalResponses('\x1b[?62;c')).toBe('');
        expect(stripTerminalResponses('\x1b[24;80R')).toBe('');
        expect(stripTerminalResponses('\x1b[?2026$y')).toBe('');
        expect(stripTerminalResponses('\x1b]11;rgb:1a/1b/26\x07')).toBe('');
    });

    it('leaves the arrow keys alone', () => {
        // The DA1 pattern ends in a lowercase `c`; right-arrow is `ESC [ C`.
        // A case-insensitive regex here would silently eat every right-arrow.
        for (const key of [TERMINAL_KEYS.up, TERMINAL_KEYS.down, TERMINAL_KEYS.left, TERMINAL_KEYS.right]) {
            expect(stripTerminalResponses(key)).toBe(key);
        }
    });

    it('leaves the other key-bar bytes and plain text alone', () => {
        expect(stripTerminalResponses(TERMINAL_KEYS.escape)).toBe('\x1b');
        expect(stripTerminalResponses(TERMINAL_KEYS.tab)).toBe('\t');
        expect(stripTerminalResponses(TERMINAL_KEYS.interrupt)).toBe('\x03');
        expect(stripTerminalResponses('echo hi\r')).toBe('echo hi\r');
        expect(stripTerminalResponses('你好')).toBe('你好');
    });

    it('strips a reply embedded in real input without taking the input', () => {
        expect(stripTerminalResponses('ec\x1b[24;80Rho')).toBe('echo');
    });
});

describe('describeBytes', () => {
    it('renders control bytes readable and leaves printables as-is', () => {
        expect(describeBytes('a\rb')).toBe('a<0d>b');
        expect(describeBytes('\x1b[A')).toBe('<1b>[A');
        expect(describeBytes('\x7f')).toBe('<7f>');
        expect(describeBytes('hi')).toBe('hi');
    });
});
