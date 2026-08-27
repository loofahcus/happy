import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { apiSocket } from "@/sync/apiSocket";
import { randomUUID } from "expo-crypto";
import {
  TERMINAL_RPC_METHODS,
  TERMINAL_EVENTS,
  TERMINAL_DEFAULTS,
  type TerminalCreateResponse,
  type TerminalCreateRequest,
  type TerminalAttachRequest,
  type TerminalAttachResponse,
  type TerminalResizeRequest,
  type TerminalDestroyRequest,
} from "@slopus/happy-wire";
import {
  describeBytes,
  stripTerminalResponses,
  toControlCode,
} from "./terminalKeys";
import {
  initialLocalEchoState,
  onLocalInput,
  onLocalOutput,
  eraseSequence,
  type LocalEchoState,
} from "./localEcho";

// ── Input diagnostics ────────────────────────────────────────────────
//
// Opt in with ?termdebug=1. Markers are written into the xterm buffer itself
// rather than console.log, because the output path is known to work and a
// phone browser has no reachable devtools. Each layer of the input path
// announces itself, so one session on the device says which boundary drops
// the keystroke.
const TERM_DEBUG = (() => {
  try {
    return new URLSearchParams(window.location.search).has("termdebug");
  } catch {
    return false;
  }
})();

function diag(terminal: XTerm, label: string, detail: string): void {
  if (!TERM_DEBUG) return;
  terminal.write(`\r\n\x1b[35m[diag] ${label}: ${detail}\x1b[0m\r\n`);
}

const STORAGE_KEY_PREFIX = "happy:terminal:";

function loadTerminalId(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY_PREFIX + sessionId);
  } catch {
    return null;
  }
}

function saveTerminalId(sessionId: string, terminalId: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY_PREFIX + sessionId, terminalId);
  } catch {}
}

function clearTerminalId(sessionId: string): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY_PREFIX + sessionId);
  } catch {}
}

/** Raw byte writer for the on-screen key bar. */
export type TerminalKeySender = (data: string) => void;

interface TerminalProps {
  sessionId: string;
  isDark: boolean;
  isActive: boolean;
  onDestroyReady?: (destroy: () => void) => void;
  onStatusChange?: (status: TerminalStatus) => void;
  /**
   * Sticky Ctrl from the key bar: while armed, the next printable character
   * typed on the soft keyboard is folded into its control code. Translation
   * has to happen here because the soft keyboard's characters only surface in
   * xterm's `onData`, well past any key event a button could intercept.
   */
  ctrlArmed?: boolean;
  onCtrlConsumed?: () => void;
  onKeySenderReady?: (send: TerminalKeySender) => void;
}

export type TerminalStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "closed";

export function Terminal({
  sessionId,
  isDark,
  isActive,
  onDestroyReady,
  onStatusChange,
  ctrlArmed = false,
  onCtrlConsumed,
  onKeySenderReady,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<{ term: XTerm; fit: FitAddon } | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const attachedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  const lastDimsRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingOutputRef = useRef<string[]>([]);
  const eventCleanupRef = useRef<(() => void) | null>(null);
  const connectAttemptRef = useRef(0);
  const sessionIdRef = useRef(sessionId);
  const localEchoRef = useRef<LocalEchoState>(initialLocalEchoState);
  // Stamped when a keystroke leaves, read by the first output that follows, to
  // measure the real echo round trip (app → server → daemon → shell → back).
  const lastInputAtRef = useRef<number | null>(null);
  const ctrlArmedRef = useRef(ctrlArmed);
  ctrlArmedRef.current = ctrlArmed;
  const onCtrlConsumedRef = useRef(onCtrlConsumed);
  onCtrlConsumedRef.current = onCtrlConsumed;
  isActiveRef.current = isActive;
  sessionIdRef.current = sessionId;

  const [status, setStatusRaw] = useState<TerminalStatus>("disconnected");
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;

  const setStatus = useCallback((s: TerminalStatus) => {
    setStatusRaw(s);
    onStatusChangeRef.current?.(s);
  }, []);

  // ── xterm.js lifecycle (mount once) ──────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new XTerm({
      fontFamily:
        '"SF Mono", Menlo, Monaco, "Cascadia Code", Consolas, monospace',
      fontSize: 13,
      theme: buildTheme(isDark),
      cursorBlink: true,
      scrollback: 5000,
      allowTransparency: true,
      scrollOnUserInput: true,
      smoothScrollDuration: 0,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon((_event, uri) => {
      window.open(uri, "_blank", "noopener,noreferrer");
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(containerRef.current);

    if (terminal.textarea) {
      terminal.textarea.setAttribute("autocomplete", "off");
      terminal.textarea.setAttribute("autocorrect", "off");
      terminal.textarea.setAttribute("autocapitalize", "off");
      terminal.textarea.setAttribute("spellcheck", "false");
    }

    // TEMPORARY: report what the helper textarea itself sees.
    if (TERM_DEBUG && terminal.textarea) {
      const ta = terminal.textarea;
      ta.addEventListener("keydown", (e) =>
        diag(terminal, "textarea keydown", `key=${e.key} keyCode=${e.keyCode}`),
      );
      ta.addEventListener("input", () =>
        diag(terminal, "textarea input", `value=${JSON.stringify(ta.value)}`),
      );
      for (const name of ["compositionstart", "compositionupdate", "compositionend"] as const) {
        ta.addEventListener(name, (e) =>
          diag(terminal, name, JSON.stringify((e as CompositionEvent).data ?? "")),
        );
      }
      ta.addEventListener("focus", () => diag(terminal, "textarea", "focused"));
      ta.addEventListener("blur", () => diag(terminal, "textarea", "blurred"));
    }

    xtermRef.current = { term: terminal, fit: fitAddon };

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
      } catch {}
    });

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resizeObserver = new ResizeObserver(() => {
      if (!containerRef.current?.offsetWidth) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        try {
          fitAddon.fit();
        } catch {}
        sendResizeIfNeeded();
      }, 80);
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeObserver.disconnect();
      terminal.dispose();
      xtermRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (xtermRef.current) {
      xtermRef.current.term.options.theme = buildTheme(isDark);
    }
  }, [isDark]);

  // ── Flush pending output when becoming active ────────────────────────

  useEffect(() => {
    if (!isActive || !xtermRef.current) return;
    if (pendingOutputRef.current.length > 0) {
      const buffered = pendingOutputRef.current.join("");
      pendingOutputRef.current = [];
      xtermRef.current.term.write(buffered);
    }
    requestAnimationFrame(() => {
      try {
        xtermRef.current?.fit.fit();
      } catch {}
      xtermRef.current?.term.focus();
    });
  }, [isActive]);

  // ── Helpers ──────────────────────────────────────────────────────────

  const sendResizeIfNeeded = useCallback(() => {
    const tid = terminalIdRef.current;
    const sid = sessionIdRef.current;
    if (!tid || !attachedRef.current || !xtermRef.current) return;
    const c = xtermRef.current.term.cols;
    const r = xtermRef.current.term.rows;
    const last = lastDimsRef.current;
    if (last && last.cols === c && last.rows === r) return;
    lastDimsRef.current = { cols: c, rows: r };
    apiSocket
      .sessionRPC<
        { success: boolean },
        TerminalResizeRequest
      >(sid, TERMINAL_RPC_METHODS.resize, { terminalId: tid, cols: c, rows: r })
      .catch(() => {});
  }, []);

  const subscribeToEvents = useCallback(
    (terminalId: string, terminal: XTerm) => {
      const sid = sessionIdRef.current;

      const unsubOutput = apiSocket.onEncryptedSessionEvent(
        sid,
        TERMINAL_EVENTS.output,
        (data: { terminalId: string; data: string }) => {
          if (data.terminalId !== terminalId) return;
          // Reconcile before writing: the shell's output is authoritative, so
          // anything drawn locally is taken back first.
          const reconciled = onLocalOutput(localEchoRef.current);
          localEchoRef.current = reconciled.next;
          const erase = eraseSequence(reconciled.eraseCount);
          const sentAt = lastInputAtRef.current;
          if (sentAt !== null) {
            lastInputAtRef.current = null;
            diag(
              terminal,
              "echo rtt",
              `${Math.round(performance.now() - sentAt)}ms`,
            );
          }
          if (isActiveRef.current) {
            terminal.write(erase + data.data);
          } else {
            pendingOutputRef.current.push(erase + data.data);
            while (pendingOutputRef.current.length > 500) {
              pendingOutputRef.current.shift();
            }
          }
        },
      );

      const unsubClosed = apiSocket.onEncryptedSessionEvent(
        sid,
        TERMINAL_EVENTS.closed,
        (data: { terminalId: string }) => {
          if (data.terminalId !== terminalId) return;
          terminal.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
          attachedRef.current = false;
          clearTerminalId(sid);
          setStatus("closed");
        },
      );

      const onDataDisposable = terminal.onData((rawData) => {
        diag(terminal, "onData", describeBytes(rawData));
        if (!attachedRef.current) {
          diag(terminal, "onData", "DROPPED — not attached");
          return;
        }
        let data = rawData;
        if (ctrlArmedRef.current) {
          // Consume the modifier whatever the next character is, so a key with
          // no control code disarms it instead of latching on.
          onCtrlConsumedRef.current?.();
          data = toControlCode(rawData) ?? rawData;
        }
        const filtered = stripTerminalResponses(data);
        if (filtered) {
          // Draw the character before it leaves, so typing does not wait on the
          // round trip. onLocalInput decides when that is safe.
          const buffer = terminal.buffer.active;
          const echo = onLocalInput(localEchoRef.current, filtered, {
            alternateBuffer: buffer.type === "alternate",
            // Leave the last two columns to the real echo: a prediction that
            // wrapped could not be taken back with a cursor-left.
            nearLineEnd: buffer.cursorX >= terminal.cols - 2,
          });
          localEchoRef.current = echo.next;
          if (echo.predict) {
            terminal.write(echo.predict);
          }
          lastInputAtRef.current = performance.now();
          void apiSocket
            .sendEncryptedSessionEvent(sid, TERMINAL_EVENTS.input, {
              terminalId,
              data: filtered,
            })
            .then(() => diag(terminal, "send", `ok ${describeBytes(filtered)}`))
            .catch((err: unknown) =>
              diag(terminal, "send", `FAILED ${String(err)}`),
            );
        } else {
          diag(terminal, "filter", `DROPPED all of ${describeBytes(data)}`);
        }
      });

      return () => {
        unsubOutput();
        unsubClosed();
        onDataDisposable.dispose();
      };
    },
    [],
  );

  // ── Core connect: list → attach or create ───────────────────────────

  const connectOrAttach = useCallback(async () => {
    if (!xtermRef.current) return;
    const myAttempt = ++connectAttemptRef.current;
    const isStale = () => myAttempt !== connectAttemptRef.current;
    const terminal = xtermRef.current.term;
    const sid = sessionIdRef.current;
    setStatus("connecting");

    // Clean up previous event subscriptions
    eventCleanupRef.current?.();
    eventCleanupRef.current = null;

    try {
      xtermRef.current.fit.fit();
      const cols = terminal.cols > 0 ? terminal.cols : TERMINAL_DEFAULTS.cols;
      const rows = terminal.rows > 0 ? terminal.rows : TERMINAL_DEFAULTS.rows;

      // Check if we have an existing terminal to reattach
      const savedId = loadTerminalId(sid);

      if (savedId) {
        // Subscribe BEFORE the RPC so buffered output emitted by the server
        // during the attach handler is captured immediately.
        const localCleanup = subscribeToEvents(savedId, terminal);
        if (isStale()) {
          localCleanup();
          return;
        }
        eventCleanupRef.current = localCleanup;

        const attachResult = await apiSocket.sessionRPC<
          TerminalAttachResponse,
          TerminalAttachRequest
        >(sid, TERMINAL_RPC_METHODS.attach, {
          terminalId: savedId,
          cols,
          rows,
        });

        if (isStale()) {
          localCleanup();
          if (eventCleanupRef.current === localCleanup) {
            eventCleanupRef.current = null;
          }
          return;
        }

        if (attachResult.success) {
          terminalIdRef.current = savedId;
          attachedRef.current = true;
          lastDimsRef.current = { cols, rows };
          setStatus("connected");
          terminal.focus();
          return;
        }

        // Attach failed — clean up early subscription and create new
        eventCleanupRef.current?.();
        eventCleanupRef.current = null;
        clearTerminalId(sid);
      }

      // Create new terminal
      const terminalId = randomUUID();

      // Subscribe BEFORE create RPC so initial shell output is captured.
      const localCleanup = subscribeToEvents(terminalId, terminal);
      if (isStale()) {
        localCleanup();
        return;
      }
      eventCleanupRef.current = localCleanup;

      const result = await apiSocket.sessionRPC<
        TerminalCreateResponse,
        TerminalCreateRequest
      >(sid, TERMINAL_RPC_METHODS.create, { terminalId, cols, rows });

      if (isStale()) {
        localCleanup();
        if (eventCleanupRef.current === localCleanup) {
          eventCleanupRef.current = null;
        }
        return;
      }

      if (!result.success) {
        eventCleanupRef.current?.();
        eventCleanupRef.current = null;
        terminal.write(`\r\n\x1b[31mFailed: ${result.error}\x1b[0m\r\n`);
        setStatus("disconnected");
        return;
      }

      terminalIdRef.current = terminalId;
      saveTerminalId(sid, terminalId);
      attachedRef.current = true;
      lastDimsRef.current = { cols, rows };
      setStatus("connected");
      terminal.focus();
    } catch (err) {
      if (isStale()) return;
      const msg = err instanceof Error ? err.message : "Connection failed";
      terminal.write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`);
      setStatus("disconnected");
    }
  }, [subscribeToEvents]);

  // ── Session connect + reconnect ─────────────────────────────────────

  useEffect(() => {
    connectOrAttach();

    const unsubReconnect = apiSocket.onReconnected(() => {
      if (terminalIdRef.current && !attachedRef.current) {
        connectOrAttach();
      }
    });

    return () => {
      unsubReconnect();
      // Invalidate any in-flight connectOrAttach so its subscription is
      // disposed locally instead of leaking into eventCleanupRef.
      connectAttemptRef.current++;
      eventCleanupRef.current?.();
      eventCleanupRef.current = null;
      attachedRef.current = false;
      // Don't destroy — keep PTY alive for reattach
    };
  }, [sessionId, connectOrAttach]);

  // ── Expose destroy function to parent ─────────────────────────────────

  useEffect(() => {
    onKeySenderReady?.((data: string) => {
      const tid = terminalIdRef.current;
      const sid = sessionIdRef.current;
      if (!tid || !attachedRef.current) return;
      // Run the bar's keys through the same gate. None of them are printable,
      // so this predicts nothing and drops the echo confirmation — without it,
      // an arrow tap would leave a stale prediction to be erased later against
      // output it never drew.
      localEchoRef.current = onLocalInput(localEchoRef.current, data, {
        alternateBuffer:
          xtermRef.current?.term.buffer.active.type === "alternate",
      }).next;
      void apiSocket.sendEncryptedSessionEvent(sid, TERMINAL_EVENTS.input, {
        terminalId: tid,
        data,
      });
      // The bar sits outside the terminal, so a tap moves focus off the helper
      // textarea and closes the soft keyboard. Put it back.
      xtermRef.current?.term.focus();
    });
  }, [onKeySenderReady]);

  useEffect(() => {
    onDestroyReady?.(() => {
      const tid = terminalIdRef.current;
      const sid = sessionIdRef.current;
      if (tid) {
        apiSocket
          .sessionRPC<
            { success: boolean },
            TerminalDestroyRequest
          >(sid, TERMINAL_RPC_METHODS.destroy, { terminalId: tid })
          .catch(() => {});
        clearTerminalId(sid);
        terminalIdRef.current = null;
      }
    });
  }, [onDestroyReady]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden" }}
    />
  );
}

function buildTheme(isDark: boolean) {
  if (isDark) {
    return {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "rgba(255, 255, 255, 0.18)",
      black: "#15161e",
      brightBlack: "#414868",
      red: "#f7768e",
      brightRed: "#f7768e",
      green: "#9ece6a",
      brightGreen: "#9ece6a",
      yellow: "#e0af68",
      brightYellow: "#e0af68",
      blue: "#7aa2f7",
      brightBlue: "#7aa2f7",
      magenta: "#bb9af7",
      brightMagenta: "#bb9af7",
      cyan: "#7dcfff",
      brightCyan: "#7dcfff",
      white: "#a9b1d6",
      brightWhite: "#c0caf5",
    };
  }
  return {
    background: "#fdf6e3",
    foreground: "#657b83",
    cursor: "#657b83",
    cursorAccent: "#fdf6e3",
    selectionBackground: "rgba(0, 0, 0, 0.12)",
    black: "#073642",
    brightBlack: "#002b36",
    red: "#dc322f",
    brightRed: "#cb4b16",
    green: "#859900",
    brightGreen: "#586e75",
    yellow: "#b58900",
    brightYellow: "#657b83",
    blue: "#268bd2",
    brightBlue: "#839496",
    magenta: "#d33682",
    brightMagenta: "#6c71c4",
    cyan: "#2aa198",
    brightCyan: "#93a1a1",
    white: "#eee8d5",
    brightWhite: "#fdf6e3",
  };
}
