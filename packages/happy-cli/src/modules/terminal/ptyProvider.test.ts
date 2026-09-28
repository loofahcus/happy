import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PtyProvider } from "./ptyProvider";

// These tests drive a real shell through a real pty, so every wait used to be
// a guess at how long that takes: 300ms for the shell to come up, 2000ms for
// it to exit. Those guesses held on an idle machine and failed under load —
// which is exactly when the suite runs, right after eight other tests that
// each spawn their own shell. Poll for the condition instead.
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 8_000;
// Comfortably above POLL_TIMEOUT_MS so the poll's own message is what fails,
// rather than vitest's generic 5s test timeout.
const PTY_TEST_TIMEOUT_MS = 15_000;

async function waitFor(
  description: string,
  condition: () => boolean,
  timeoutMs = POLL_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

describe("PtyProvider", () => {
  let provider: PtyProvider;

  beforeEach(() => {
    provider = new PtyProvider();
  });

  afterEach(() => {
    provider.destroyAll();
  });

  it("creates a terminal and receives output", async () => {
    const output: string[] = [];

    await provider.createTerminal(
      { terminalId: "test-1", cwd: "/tmp" },
      {
        onData: (data) => output.push(data),
        onExit: () => {},
      },
    );

    expect(provider.has("test-1")).toBe(true);
    expect(provider.size).toBe(1);

    const info = provider.getInfo("test-1");
    expect(info).not.toBeNull();
    expect(info!.cols).toBe(80);
    expect(info!.rows).toBe(24);
    expect(info!.shell).toBeTruthy();
  });

  it(
    "writes to terminal and receives echo",
    async () => {
      const output: string[] = [];
      const sentinel = `__TEST_${Date.now()}__`;

      await provider.createTerminal(
        { terminalId: "test-echo", cwd: "/tmp" },
        {
          onData: (data) => output.push(data),
          onExit: () => {},
        },
      );

      // No wait for the shell to come up: the tty buffers a write that arrives
      // before the shell reads, so the sentinel shows up either way and the
      // poll below is the only thing that has to be right.
      provider.write("test-echo", `echo "${sentinel}"\r`);

      await waitFor(
        `the shell to echo ${sentinel}`,
        () => output.join("").includes(sentinel),
      );
    },
    PTY_TEST_TIMEOUT_MS,
  );

  it("resizes terminal and deduplicates", () => {
    return new Promise<void>(async (resolve) => {
      await provider.createTerminal(
        { terminalId: "test-resize", cwd: "/tmp", cols: 80, rows: 24 },
        { onData: () => {}, onExit: () => {} },
      );

      expect(provider.resize("test-resize", 120, 40)).toBe(true);
      const info = provider.getInfo("test-resize");
      expect(info!.cols).toBe(120);
      expect(info!.rows).toBe(40);

      // Same dimensions should be a no-op (returns true)
      expect(provider.resize("test-resize", 120, 40)).toBe(true);

      // Non-existent terminal
      expect(provider.resize("nonexistent", 80, 24)).toBe(false);

      resolve();
    });
  });

  it("destroys terminal", async () => {
    await provider.createTerminal(
      { terminalId: "test-destroy", cwd: "/tmp" },
      { onData: () => {}, onExit: () => {} },
    );

    expect(provider.has("test-destroy")).toBe(true);
    provider.destroy("test-destroy");
    expect(provider.has("test-destroy")).toBe(false);
    expect(provider.size).toBe(0);
  });

  it("lists all terminals", async () => {
    await provider.createTerminal(
      { terminalId: "t1", cwd: "/tmp" },
      { onData: () => {}, onExit: () => {} },
    );
    await provider.createTerminal(
      { terminalId: "t2", cwd: "/tmp" },
      { onData: () => {}, onExit: () => {} },
    );

    const list = provider.listAll();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.terminalId).sort()).toEqual(["t1", "t2"]);
  });

  it(
    "buffers output for replay",
    async () => {
      const sentinel = `__BUF_${Date.now()}__`;

      await provider.createTerminal(
        { terminalId: "test-buffer", cwd: "/tmp" },
        { onData: () => {}, onExit: () => {} },
      );

      provider.write("test-buffer", `echo "${sentinel}"\n`);

      // Assert against the buffer itself rather than the onData callback: the
      // buffer is what a reattaching client replays, and it is what this test
      // is about.
      await waitFor(
        `the replay buffer to hold ${sentinel}`,
        () => provider.getBufferedOutput("test-buffer").join("").includes(sentinel),
      );
      expect(provider.getBufferedOutput("test-buffer").length).toBeGreaterThan(0);
    },
    PTY_TEST_TIMEOUT_MS,
  );

  it("rejects invalid CWD", async () => {
    await expect(
      provider.createTerminal(
        { terminalId: "bad-cwd", cwd: "/nonexistent/path/xyz" },
        { onData: () => {}, onExit: () => {} },
      ),
    ).rejects.toThrow("Working directory does not exist");
  });

  it(
    "fires onExit when process exits",
    async () => {
      let exited = false;

      await provider.createTerminal(
        { terminalId: "test-exit", cwd: "/tmp" },
        {
          onData: () => {},
          onExit: () => {
            exited = true;
          },
        },
      );

      provider.write("test-exit", "exit\n");

      await waitFor("the shell process to exit", () => exited);
      // The callback is what drops the entry, so this holds once it has fired.
      expect(provider.has("test-exit")).toBe(false);
    },
    PTY_TEST_TIMEOUT_MS,
  );

  it("destroyAll cleans up all terminals", async () => {
    await provider.createTerminal(
      { terminalId: "a", cwd: "/tmp" },
      { onData: () => {}, onExit: () => {} },
    );
    await provider.createTerminal(
      { terminalId: "b", cwd: "/tmp" },
      { onData: () => {}, onExit: () => {} },
    );

    expect(provider.size).toBe(2);
    provider.destroyAll();
    expect(provider.size).toBe(0);
  });
});
