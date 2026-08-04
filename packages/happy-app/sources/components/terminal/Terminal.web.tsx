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

const TERM_RESPONSE_RE = new RegExp(
  [
    "\\x1b\\[[?>]?[\\d;]*c",
    "\\x1b\\[[\\d;]*R",
    "\\x1b\\[\\?[\\d;]*\\$y",
    "\\x1b\\][\\d]+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)",
  ].join("|"),
  "g",
);

function stripTerminalResponses(data: string): string {
  return data.replace(TERM_RESPONSE_RE, "");
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

interface TerminalProps {
  sessionId: string;
  isDark: boolean;
  isActive: boolean;
  onDestroyReady?: (destroy: () => void) => void;
  onStatusChange?: (status: TerminalStatus) => void;
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
          if (isActiveRef.current) {
            terminal.write(data.data);
          } else {
            pendingOutputRef.current.push(data.data);
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

      const onDataDisposable = terminal.onData((data) => {
        if (!attachedRef.current) return;
        const filtered = stripTerminalResponses(data);
        if (filtered) {
          apiSocket.sendEncryptedSessionEvent(sid, TERMINAL_EVENTS.input, {
            terminalId,
            data: filtered,
          });
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
