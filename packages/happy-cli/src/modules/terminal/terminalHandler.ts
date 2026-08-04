import { logger } from "@/ui/logger";
import { RpcHandlerManager } from "@/api/rpc/RpcHandlerManager";
import { PtyProvider } from "./ptyProvider";
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
const FLUSH_BATCH = 8;

interface OutputState {
  pending: string[];
  flushing: boolean;
}

const outputStates = new Map<string, OutputState>();

function getOutputState(terminalId: string): OutputState {
  let state = outputStates.get(terminalId);
  if (!state) {
    state = { pending: [], flushing: false };
    outputStates.set(terminalId, state);
  }
  return state;
}

async function flushOutput(
  terminalId: string,
  rpc: RpcHandlerManager,
): Promise<void> {
  const state = outputStates.get(terminalId);
  if (!state || state.flushing) return;
  state.flushing = true;

  try {
    while (state.pending.length > 0) {
      let emitted = 0;
      while (emitted < FLUSH_BATCH && state.pending.length > 0) {
        const next = state.pending.shift()!;
        if (next.length <= SEGMENT_BYTES) {
          rpc.emitEncryptedEvent(TERMINAL_EVENTS.output, {
            terminalId,
            data: next,
          });
        } else {
          // Rare: a single chunk larger than the segment limit — split it.
          for (let i = 0; i < next.length; i += SEGMENT_BYTES) {
            rpc.emitEncryptedEvent(TERMINAL_EVENTS.output, {
              terminalId,
              data: next.slice(i, i + SEGMENT_BYTES),
            });
          }
        }
        emitted++;
      }
      if (state.pending.length > 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    state.flushing = false;
    if (state.pending.length > 0) {
      void flushOutput(terminalId, rpc);
    }
  }
}

function enqueueOutput(
  terminalId: string,
  data: string,
  rpc: RpcHandlerManager,
): void {
  const state = getOutputState(terminalId);
  state.pending.push(data);
  if (!state.flushing) {
    void flushOutput(terminalId, rpc);
  }
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
            void flushOutput(data.terminalId, rpc).then(() => {
              outputStates.delete(data.terminalId);
              rpc.emitEncryptedEvent(TERMINAL_EVENTS.closed, {
                terminalId: data.terminalId,
                reason: "process_exit",
              });
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
    outputStates.delete(data.terminalId);
    return { success: true };
  });

  rpc.registerHandler(TERMINAL_RPC_METHODS.list, () => ({
    terminals: pty.listAll(),
  }));

  rpc.onEncryptedEvent(TERMINAL_EVENTS.input, (raw) => {
    const data = terminalInputPayloadSchema.parse(raw);
    pty.write(data.terminalId, data.data);
  });
}

export function destroyAllTerminals(): void {
  getTerminalProvider().destroyAll();
  outputStates.clear();
}
