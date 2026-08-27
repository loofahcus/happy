import { logger } from "@/ui/logger";
import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { PtyProvider } from "./ptyProvider";
import { coalesceSegments } from "./outputCoalescer";
import {
  TERMINAL_DEFAULTS,
  TERMINAL_EVENTS,
  TERMINAL_RPC_METHODS,
  ATTACH_MODE_RESET,
  terminalCreateRequestSchema,
  terminalAttachRequestSchema,
  terminalResizeRequestSchema,
  terminalDestroyRequestSchema,
  terminalInputPayloadSchema,
  type TerminalCreateResponse,
  type TerminalAttachResponse,
  type TerminalListResponse,
} from "@slopus/happy-wire";

const SEGMENT_BYTES = TERMINAL_DEFAULTS.segmentBytes;

// A shell redrawing its prompt line emits many tiny writes in quick
// succession, and every event costs a separate encrypt, socket frame, relay
// hop, and ordered decrypt on the client. Chunks that arrive while an emit is
// already in flight are concatenated into one payload instead.
//
// The window is trailing only: the first chunk after an idle period goes out
// immediately, so a single keystroke's echo is never delayed. Only the
// followers — which by definition already lost the race — get batched.
const COALESCE_MS = 8;

interface OutputState {
  pending: string[];
  timer: ReturnType<typeof setTimeout> | null;
  /** Set once the leading chunk has gone out, so followers wait for the window. */
  emitted: boolean;
}

const outputStates = new Map<string, OutputState>();

function getOutputState(terminalId: string): OutputState {
  let state = outputStates.get(terminalId);
  if (!state) {
    state = { pending: [], timer: null, emitted: false };
    outputStates.set(terminalId, state);
  }
  return state;
}

function flushOutput(terminalId: string, rpc: RpcHandlerManager): void {
  const state = outputStates.get(terminalId);
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (state.pending.length === 0) {
    // Idle: the next chunk is a leading edge again and goes out immediately.
    state.emitted = false;
    return;
  }
  const payloads = coalesceSegments(state.pending, SEGMENT_BYTES);
  state.pending = [];
  for (const data of payloads) {
    rpc.emitEncryptedEvent(TERMINAL_EVENTS.output, { terminalId, data });
  }
  state.emitted = true;
  // Re-arm so a burst that keeps arriving keeps draining, and so `emitted`
  // resets once the shell goes quiet.
  state.timer = setTimeout(() => {
    state.timer = null;
    flushOutput(terminalId, rpc);
  }, COALESCE_MS);
}

function enqueueOutput(
  terminalId: string,
  data: string,
  rpc: RpcHandlerManager,
): void {
  const state = getOutputState(terminalId);
  state.pending.push(data);
  if (!state.emitted) {
    // Leading edge — no delay.
    flushOutput(terminalId, rpc);
    return;
  }
  if (!state.timer) {
    state.timer = setTimeout(() => {
      state.timer = null;
      flushOutput(terminalId, rpc);
    }, COALESCE_MS);
  }
}

function disposeOutputState(terminalId: string): void {
  const state = outputStates.get(terminalId);
  if (state?.timer) clearTimeout(state.timer);
  outputStates.delete(terminalId);
}

let sharedProvider: PtyProvider | null = null;

export function getTerminalProvider(): PtyProvider {
  if (!sharedProvider) {
    sharedProvider = new PtyProvider();
  }
  return sharedProvider;
}

export function registerTerminalHandlers(
  rpc: RpcHandlerManager,
  workingDirectory: string,
): void {
  const pty = getTerminalProvider();

  rpc.registerHandler(TERMINAL_RPC_METHODS.create, async (raw) => {
    const data = terminalCreateRequestSchema.parse(raw);
    if (pty.has(data.terminalId)) {
      const info = pty.getInfo(data.terminalId)!;
      return { success: true, shell: info.shell };
    }

    try {
      await pty.createTerminal(
        {
          terminalId: data.terminalId,
          cwd: data.cwd ?? workingDirectory,
          cols: data.cols,
          rows: data.rows,
          shell: data.shell,
          env: data.env,
        },
        {
          onData(output) {
            enqueueOutput(data.terminalId, output, rpc);
          },
          onExit() {
            // Synchronous, so whatever the process wrote on its way out is
            // emitted before the closed event rather than racing it.
            flushOutput(data.terminalId, rpc);
            disposeOutputState(data.terminalId);
            rpc.emitEncryptedEvent(TERMINAL_EVENTS.closed, {
              terminalId: data.terminalId,
              reason: "process_exit",
            });
          },
        },
      );

      const info = pty.getInfo(data.terminalId)!;
      logger.debug(`[terminal] created ${data.terminalId} with ${info.shell}`);
      return {
        success: true,
        shell: info.shell,
      } satisfies TerminalCreateResponse;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "spawn failed";
      logger.debug(`[terminal] create failed: ${msg}`);
      return {
        success: false,
        shell: "",
        error: msg,
      } satisfies TerminalCreateResponse;
    }
  });

  rpc.registerHandler(TERMINAL_RPC_METHODS.attach, (raw) => {
    const data = terminalAttachRequestSchema.parse(raw);
    const info = pty.getInfo(data.terminalId);
    if (!info)
      return {
        success: false,
        bufferedChunks: 0,
      } satisfies TerminalAttachResponse;

    if (data.cols != null && data.rows != null) {
      pty.resize(data.terminalId, data.cols, data.rows);
    }

    const chunks = pty.getBufferedOutput(data.terminalId);
    if (chunks.length > 0) {
      const buffered = chunks.join("");
      for (let offset = 0; offset < buffered.length; offset += SEGMENT_BYTES) {
        rpc.emitEncryptedEvent(TERMINAL_EVENTS.output, {
          terminalId: data.terminalId,
          data: buffered.slice(offset, offset + SEGMENT_BYTES),
        });
      }
    }

    rpc.emitEncryptedEvent(TERMINAL_EVENTS.output, {
      terminalId: data.terminalId,
      data: ATTACH_MODE_RESET,
    });

    return {
      success: true,
      bufferedChunks: chunks.length,
    } satisfies TerminalAttachResponse;
  });

  rpc.registerHandler(TERMINAL_RPC_METHODS.resize, (raw) => {
    const data = terminalResizeRequestSchema.parse(raw);
    return { success: pty.resize(data.terminalId, data.cols, data.rows) };
  });

  rpc.registerHandler(TERMINAL_RPC_METHODS.destroy, (raw) => {
    const data = terminalDestroyRequestSchema.parse(raw);
    pty.destroy(data.terminalId);
    disposeOutputState(data.terminalId);
    return { success: true };
  });

  rpc.registerHandler(TERMINAL_RPC_METHODS.list, () => ({
    terminals: pty.listAll(),
  }));

  rpc.onEncryptedEvent(TERMINAL_EVENTS.input, (raw) => {
    // A malformed payload used to throw out of this listener, leaving no
    // trace of a dropped keystroke. Log and drop instead. Deliberately no
    // per-keystroke success log: it would put file I/O on the echo path.
    const parsed = terminalInputPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      logger.debug(
        `[terminal] input payload rejected: ${parsed.error.message}`,
      );
      return;
    }
    pty.write(parsed.data.terminalId, parsed.data.data);
  });
}

export function destroyAllTerminals(): void {
  getTerminalProvider().destroyAll();
  for (const terminalId of [...outputStates.keys()]) {
    disposeOutputState(terminalId);
  }
}
