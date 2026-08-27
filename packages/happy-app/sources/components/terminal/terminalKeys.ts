/**
 * Byte-level helpers for terminal input. Kept apart from Terminal.web.tsx so
 * they are testable without pulling in xterm, its CSS, or the socket layer.
 */

/**
 * Device replies the terminal emits in answer to a query (DA1, CPR, DECRQM,
 * OSC). They arrive on the same `onData` channel as real keystrokes; echoing
 * them back to the PTY makes the terminal answer its own questions forever.
 *
 * Deliberately case-sensitive: the DA1 pattern ends in a lowercase `c`, so the
 * right-arrow key (`ESC [ C`) does not match it.
 */
const TERM_RESPONSE_RE = new RegExp(
  [
    "\\x1b\\[[?>]?[\\d;]*c",
    "\\x1b\\[[\\d;]*R",
    "\\x1b\\[\\?[\\d;]*\\$y",
    "\\x1b\\][\\d]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
  ].join("|"),
  "g",
);

export function stripTerminalResponses(data: string): string {
  return data.replace(TERM_RESPONSE_RE, "");
}

/** Bytes for the keys a soft keyboard cannot produce. */
export const TERMINAL_KEYS = {
  escape: "\x1b",
  tab: "\t",
  interrupt: "\x03",
  left: "\x1b[D",
  right: "\x1b[C",
  up: "\x1b[A",
  down: "\x1b[B",
} as const;

/**
 * Fold a printable character into its control code, the way a hardware Ctrl
 * would: Ctrl+A..Ctrl+Z are 0x01..0x1a, and the usual punctuation companions
 * keep their traditional codes.
 *
 * Returns null when the character has no control code, so the caller can send
 * the keystroke through unchanged rather than swallowing it.
 */
export function toControlCode(ch: string): string | null {
  if (ch.length !== 1) return null;
  const lower = ch.toLowerCase();
  if (lower >= "a" && lower <= "z") {
    return String.fromCharCode(lower.charCodeAt(0) - 96);
  }
  const punctuation: Record<string, string> = {
    "@": "\x00",
    " ": "\x00",
    "[": "\x1b",
    "\\": "\x1c",
    "]": "\x1d",
    "^": "\x1e",
    _: "\x1f",
    "?": "\x7f",
  };
  return punctuation[ch] ?? null;
}

/** Render control bytes readable for diagnostics: `a<0d>b`. */
export function describeBytes(data: string): string {
  return Array.from(data)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp < 0x20 || cp === 0x7f
        ? `<${cp.toString(16).padStart(2, "0")}>`
        : ch;
    })
    .join("");
}
