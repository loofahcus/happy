import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PtyProvider } from "./ptyProvider";

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

  it("writes to terminal and receives echo", async () => {
    const output: string[] = [];
    const sentinel = `__TEST_${Date.now()}__`;

    await provider.createTerminal(
      { terminalId: "test-echo", cwd: "/tmp" },
      {
        onData: (data) => output.push(data),
        onExit: () => {},
      },
    );

    // Wait for shell to be ready
    await new Promise((r) => setTimeout(r, 500));
    output.length = 0;

    provider.write("test-echo", `echo "${sentinel}"\r`);

    await new Promise((r) => setTimeout(r, 500));
    const allOutput = output.join("");
    expect(allOutput).toContain(sentinel);
  });

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

  it("buffers output for replay", async () => {
    const output: string[] = [];
    const sentinel = `__BUF_${Date.now()}__`;

    await provider.createTerminal(
      { terminalId: "test-buffer", cwd: "/tmp" },
      {
        onData: (data) => output.push(data),
        onExit: () => {},
      },
    );

    await new Promise((r) => setTimeout(r, 300));
    provider.write("test-buffer", `echo "${sentinel}"\n`);
    await new Promise((r) => setTimeout(r, 500));

    const buffered = provider.getBufferedOutput("test-buffer");
    expect(buffered.length).toBeGreaterThan(0);
    expect(buffered.join("")).toContain(sentinel);
  });

  it("rejects invalid CWD", async () => {
    await expect(
      provider.createTerminal(
        { terminalId: "bad-cwd", cwd: "/nonexistent/path/xyz" },
        { onData: () => {}, onExit: () => {} },
      ),
    ).rejects.toThrow("Working directory does not exist");
  });

  it("fires onExit when process exits", async () => {
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

    await new Promise((r) => setTimeout(r, 300));
    provider.write("test-exit", "exit\n");
    // Give exit more time in CI
    await new Promise((r) => setTimeout(r, 2000));
    expect(exited).toBe(true);
    expect(provider.has("test-exit")).toBe(false);
  });

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
