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
