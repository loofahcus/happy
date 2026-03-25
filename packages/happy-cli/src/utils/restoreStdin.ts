/**
 * Restores process.stdin to a clean state after raw mode / Ink usage.
 *
 * When switching from remote mode (Ink UI with raw mode) back to local mode
 * (Claude with inherited stdio), stdin must be fully reset:
 *   1. Raw mode disabled (so the terminal handles line editing again)
 *   2. Explicitly stop the libuv read handle (prevents parent from competing
 *      with child process for fd 0, even if pause() alone is insufficient)
 *   3. Paused (exits flowing mode so the child process can read stdin)
 *   4. Encoding reset from utf8 back to Buffer (setEncoding is sticky)
 *   5. ALL event listeners removed (safety net for Ink teardown races)
 *   6. Internal readable buffer drained (prevents phantom keystrokes from
 *      leaking into the next mode)
 *   7. Re-enforce clean handle state after drain
 *
 * Idempotent — safe to call multiple times or when stdin is already clean.
 */

import { logger } from "@/ui/logger";

function debugStdinState(label: string): void {
  try {
    const state = (process.stdin as any)._readableState;
    const handle = (process.stdin as any)._handle;
    logger.debug(
      `[restoreStdin] ${label}: ` +
        `state.reading=${state?.reading}, ` +
        `state.flowing=${state?.flowing}, ` +
        `state.ended=${state?.ended}, ` +
        `state.endEmitted=${state?.endEmitted}, ` +
        `state.encoding=${state?.encoding}, ` +
        `state.readableListening=${state?.readableListening}, ` +
        `state.resumeScheduled=${state?.resumeScheduled}, ` +
        `state.destroyed=${state?.destroyed}, ` +
        `state.errored=${state?.errored}, ` +
        `state.constructed=${state?.constructed}, ` +
        `state.needReadable=${state?.needReadable}, ` +
        `state.length=${state?.length}, ` +
        `handle.reading=${handle?.reading}, ` +
        `listenerCount.data=${process.stdin.listenerCount("data")}, ` +
        `listenerCount.readable=${process.stdin.listenerCount("readable")}`,
    );
  } catch {
    // Debug logging should never throw
  }
}

export function restoreStdin(): void {
  try {
    debugStdinState("BEFORE");

    // 1. Disable raw mode (only on TTY)
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch {
        // Already not in raw mode, or stdin is destroyed
      }
    }

    // 2. Explicitly stop the libuv read handle on the underlying TTY.
    //    process.stdin.pause() should call _handle.readStop(), but only
    //    when _handle.reading is true. If Ink left the handle in an
    //    inconsistent state, pause() silently skips the readStop() call
    //    and libuv continues reading from fd 0 — the parent then competes
    //    with the child process for input, causing split escape sequences
    //    (arrow keys need multiple presses) and garbled characters.
    //    Calling readStop() unconditionally ensures libuv truly stops.
    try {
      const handle = (process.stdin as any)._handle;
      if (handle && typeof handle.readStop === "function") {
        handle.reading = false;
        handle.readStop();
      }
    } catch {
      // Handle not accessible — non-critical
    }

    // 3. Pause stdin (exit flowing mode, set flowing = false)
    try {
      process.stdin.pause();
    } catch {
      // Already paused or destroyed
    }

    // 4. Reset encoding and internal readable state
    //    setEncoding("utf8") is a one-way operation on the public API —
    //    the only way to undo it is to null out the internal decoder state.
    //    CRITICAL: state.reading must be set to false. Without this,
    //    process.stdin.resume() → resume_() checks !state.reading and
    //    skips read(0) when state.reading is stale true, so
    //    handle.readStart() is never called and libuv never reads fd 0.
    try {
      const state = (process.stdin as any)._readableState;
      if (state) {
        state.encoding = null;
        state.decoder = null;
        state.flowing = false;
        state.reading = false;
        state.ended = false;
        state.endEmitted = false;
        state.readableListening = false;
        state.needReadable = false;
        // Clear any error state that could prevent _read() from being called.
        // In Node.js Readable.read(0), doRead is set to false when state.errored
        // is truthy, which prevents handle.readStart() from ever being invoked.
        state.errored = null;
        // Ensure constructed is true - when false, read(0) skips _read() entirely.
        state.constructed = true;
      }
    } catch {
      // Internal state not accessible — non-critical
    }

    // 5. Remove ALL event listeners from stdin.
    //    Ink's unmount() should clean its own listeners, but in practice
    //    it can leave orphans (e.g. 'data', 'readable', 'keypress', 'end')
    //    due to async teardown races. Any lingering listener that causes
    //    the stream to resume would make the parent consume data from fd 0,
    //    starving the child process of input.
    //    Callers must invoke inkInstance.unmount() BEFORE restoreStdin().
    try {
      process.stdin.removeAllListeners();
    } catch {
      // Listeners already gone or stdin destroyed
    }

    // 6. Drain any buffered data from the internal readable stream.
    //    Keystrokes received during the mode-switch teardown window
    //    (e.g., the second space from the double-space gesture) can sit
    //    in the Node.js buffer and leak as phantom input to the next consumer.
    try {
      while (process.stdin.read() !== null) {
        // Discard all buffered data
      }
    } catch {
      // Stream not readable or already destroyed
    }

    // 7. Re-enforce clean handle state after drain.
    //    The drain loop above calls process.stdin.read() which internally
    //    calls _read() → handle.readStart(), potentially restarting the
    //    libuv handle we stopped in step 2. We must stop it again and
    //    reset state.reading so the next resume() works correctly.
    try {
      const handle = (process.stdin as any)._handle;
      if (handle && typeof handle.readStop === "function") {
        handle.reading = false;
        handle.readStop();
      }
    } catch {
      // Handle not accessible — non-critical
    }
    try {
      const state = (process.stdin as any)._readableState;
      if (state) {
        state.reading = false;
        state.flowing = false;
      }
    } catch {
      // Internal state not accessible — non-critical
    }

    debugStdinState("AFTER");
  } catch {
    // Entire restoration failed — non-critical, best-effort cleanup
  }
}
