import { execFileSync } from "child_process";
import { access } from "node:fs/promises";
import pty from "node-pty";
import { logger } from "@/ui/logger";
import { CircularBuffer } from "./circularBuffer";
import { TERMINAL_DEFAULTS } from "@slopus/happy-wire";

const SHELL_CANDIDATES = ["zsh", "bash", "fish"] as const;
const MAX_TERMINALS = 20;

export interface PtyCallbacks {
  onData: (data: string) => void;
  onExit: () => void;
}

export interface CreatePtyOpts {
  terminalId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  shell?: string;
  env?: Record<string, string>;
}

export interface PtyInfo {
  terminalId: string;
  shell: string;
  cols: number;
  rows: number;
}

interface PtyEntry {
  process: pty.IPty;
  callbacks: PtyCallbacks;
  buffer: CircularBuffer<string>;
  cols: number;
  rows: number;
  shell: string;
}

function resolveShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  for (const candidate of SHELL_CANDIDATES) {
    try {
      return execFileSync("/bin/sh", ["-c", `command -v ${candidate}`], {
        encoding: "utf8",
      }).trim();
    } catch {
      // not found
    }
  }
  return process.env["SHELL"] ?? "bash";
}

function shellArgs(shell: string): string[] {
  if (process.platform === "win32") return [];
  if (shell.endsWith("/fish") || shell === "fish")
    return ["--login", "--interactive"];
  return ["-l", "-i"];
}

export class PtyProvider {
  private readonly entries = new Map<string, PtyEntry>();
  private readonly defaultShell = resolveShell();

  async createTerminal(
    opts: CreatePtyOpts,
    callbacks: PtyCallbacks,
  ): Promise<void> {
    if (this.entries.size >= MAX_TERMINALS) {
      throw new Error(
        `Terminal limit reached (${MAX_TERMINALS}). Close an existing terminal first.`,
      );
    }

    const shell = opts.shell ?? this.defaultShell;
    const cols = opts.cols ?? TERMINAL_DEFAULTS.cols;
    const rows = opts.rows ?? TERMINAL_DEFAULTS.rows;

    await access(opts.cwd).catch(() => {
      throw new Error(`Working directory does not exist: ${opts.cwd}`);
    });

    const ptyProcess = pty.spawn(shell, shellArgs(shell), {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
    });

    const entry: PtyEntry = {
      process: ptyProcess,
      callbacks,
      buffer: new CircularBuffer<string>(TERMINAL_DEFAULTS.bufferCapacity),
      cols,
      rows,
      shell,
    };

    this.entries.set(opts.terminalId, entry);

    ptyProcess.onData((data) => {
      entry.buffer.push(data);
      callbacks.onData(data);
    });

    ptyProcess.onExit(() => {
      this.entries.delete(opts.terminalId);
      callbacks.onExit();
    });
  }

  write(terminalId: string, data: string): void {
    this.entries.get(terminalId)?.process.write(data);
  }

  resize(terminalId: string, cols: number, rows: number): boolean {
    const entry = this.entries.get(terminalId);
    if (!entry) return false;
    if (entry.cols === cols && entry.rows === rows) return true;
    entry.process.resize(cols, rows);
    entry.cols = cols;
    entry.rows = rows;
    return true;
  }

  destroy(terminalId: string): void {
    const entry = this.entries.get(terminalId);
    if (!entry) return;
    try {
      entry.process.kill();
    } catch {
      // already exited
    }
    this.entries.delete(terminalId);
  }

  getInfo(terminalId: string): PtyInfo | null {
    const entry = this.entries.get(terminalId);
    if (!entry) return null;
    return {
      terminalId,
      shell: entry.shell,
      cols: entry.cols,
      rows: entry.rows,
    };
  }

  getBufferedOutput(terminalId: string): string[] {
    return this.entries.get(terminalId)?.buffer.slice() ?? [];
  }

  listAll(): PtyInfo[] {
    return [...this.entries.entries()].map(([id, e]) => ({
      terminalId: id,
      shell: e.shell,
      cols: e.cols,
      rows: e.rows,
    }));
  }

  has(terminalId: string): boolean {
    return this.entries.has(terminalId);
  }

  destroyAll(): void {
    for (const [, entry] of this.entries) {
      try {
        entry.process.kill();
      } catch {
        // already exited
      }
    }
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
