import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { restoreStdin } from "./restoreStdin";

function createStdinState(overrides: Record<string, any> = {}) {
  return {
    reading: true,
    flowing: true,
    encoding: "utf8",
    decoder: {} as any,
    ended: false,
    endEmitted: false,
    errored: null as any,
    constructed: true,
    readableListening: true,
    needReadable: true,
    ...overrides,
  };
}

function createHandleMock() {
  return {
    reading: true,
    readStop: vi.fn(),
    readStart: vi.fn(),
  };
}

function createStdinMock(
  state: ReturnType<typeof createStdinState>,
  handle: ReturnType<typeof createHandleMock>,
  overrides: Record<string, any> = {},
) {
  return {
    isTTY: true,
    setRawMode: vi.fn(),
    pause: vi.fn(),
    removeAllListeners: vi.fn(),
    read: vi.fn(() => null),
    listenerCount: vi.fn(() => 0),
    _readableState: state,
    _handle: handle,
    ...overrides,
  };
}

function installMock(mock: any) {
  Object.defineProperty(process, "stdin", {
    value: mock,
    writable: true,
    configurable: true,
  });
}

describe("restoreStdin", () => {
  let originalStdin: NodeJS.ReadableStream;

  beforeEach(() => {
    originalStdin = process.stdin;
  });

  afterEach(() => {
    Object.defineProperty(process, "stdin", {
      value: originalStdin,
      writable: true,
      configurable: true,
    });
  });

  it("should set _readableState.reading to false (critical fix for Bug 1)", () => {
    const state = createStdinState();
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.reading).toBe(false);
  });

  it("should set _handle.reading to false", () => {
    const handle = createHandleMock();
    installMock(createStdinMock(createStdinState(), handle));
    restoreStdin();
    expect(handle.reading).toBe(false);
  });

  it("should call handle.readStop() to stop libuv reading", () => {
    const handle = createHandleMock();
    installMock(createStdinMock(createStdinState(), handle));
    restoreStdin();
    expect(handle.readStop).toHaveBeenCalled();
  });

  it("should reset encoding and decoder", () => {
    const state = createStdinState({
      encoding: "utf8",
      decoder: { some: "decoder" },
    });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.encoding).toBeNull();
    expect(state.decoder).toBeNull();
  });

  it("should set flowing = false", () => {
    const state = createStdinState({ flowing: true });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.flowing).toBe(false);
  });

  it("should set ended = false and endEmitted = false", () => {
    const state = createStdinState({ ended: true, endEmitted: true });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.ended).toBe(false);
    expect(state.endEmitted).toBe(false);
  });

  it("should clear errored state", () => {
    const state = createStdinState({
      errored: new Error("previous error"),
    });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.errored).toBeNull();
  });

  it("should set constructed = true", () => {
    const state = createStdinState({ constructed: false });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.constructed).toBe(true);
  });

  it("should set readableListening = false and needReadable = false", () => {
    const state = createStdinState({
      readableListening: true,
      needReadable: true,
    });
    installMock(createStdinMock(state, createHandleMock()));
    restoreStdin();
    expect(state.readableListening).toBe(false);
    expect(state.needReadable).toBe(false);
  });

  it("should call removeAllListeners()", () => {
    const mock = createStdinMock(createStdinState(), createHandleMock());
    installMock(mock);
    restoreStdin();
    expect(mock.removeAllListeners).toHaveBeenCalled();
  });

  it("should drain buffered data by calling read() until null", () => {
    const readMock = vi
      .fn()
      .mockReturnValueOnce(Buffer.from("data1"))
      .mockReturnValueOnce(Buffer.from("data2"))
      .mockReturnValueOnce(Buffer.from("data3"))
      .mockReturnValueOnce(null);

    const mock = createStdinMock(createStdinState(), createHandleMock(), {
      read: readMock,
    });
    installMock(mock);
    restoreStdin();
    expect(readMock).toHaveBeenCalledTimes(4);
  });

  it("should re-enforce handle stop after drain", () => {
    const handle = createHandleMock();
    installMock(createStdinMock(createStdinState(), handle));
    restoreStdin();
    const callCount = handle.readStop.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("should be idempotent (safe to call multiple times)", () => {
    const state = createStdinState();
    const handle = createHandleMock();
    installMock(createStdinMock(state, handle));

    restoreStdin();
    const firstCallCount = handle.readStop.mock.calls.length;

    restoreStdin();
    const secondCallCount = handle.readStop.mock.calls.length;

    expect(secondCallCount).toBeGreaterThanOrEqual(firstCallCount);
    expect(state.reading).toBe(false);
    expect(handle.reading).toBe(false);
  });

  it("should disable raw mode", () => {
    const mock = createStdinMock(createStdinState(), createHandleMock());
    installMock(mock);
    restoreStdin();
    expect(mock.setRawMode).toHaveBeenCalledWith(false);
  });

  it("should call pause()", () => {
    const mock = createStdinMock(createStdinState(), createHandleMock());
    installMock(mock);
    restoreStdin();
    expect(mock.pause).toHaveBeenCalled();
  });

  it("should handle errors gracefully (non-TTY stdin)", () => {
    const mock = createStdinMock(
      createStdinState({ reading: false, flowing: false }),
      createHandleMock(),
      { isTTY: false, _handle: undefined },
    );
    installMock(mock);
    expect(() => restoreStdin()).not.toThrow();
  });

  it("should handle errors gracefully (no _readableState)", () => {
    installMock({
      isTTY: true,
      setRawMode: vi.fn(),
      pause: vi.fn(),
      removeAllListeners: vi.fn(),
      read: vi.fn(() => null),
      listenerCount: vi.fn(() => 0),
    });
    expect(() => restoreStdin()).not.toThrow();
  });
});
