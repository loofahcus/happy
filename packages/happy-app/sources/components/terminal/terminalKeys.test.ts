import { describe, it, expect } from 'vitest';
import { stripTerminalResponses, describeBytes } from './terminalKeys';

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
        for (const key of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D']) {
            expect(stripTerminalResponses(key)).toBe(key);
        }
    });

    it('leaves plain text alone', () => {
        expect(stripTerminalResponses('echo hi\r')).toBe('echo hi\r');
        expect(stripTerminalResponses('\u4f60\u597d')).toBe('\u4f60\u597d');
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
