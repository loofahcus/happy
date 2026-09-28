import { describe, it, expect } from "vitest";
import { CircularBuffer } from "./circularBuffer";

describe("CircularBuffer", () => {
  it("stores and retrieves items within capacity", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    expect(buf.length).toBe(3);
    expect(buf.slice()).toEqual([1, 2, 3]);
  });

  it("overwrites oldest items when at capacity", () => {
    const buf = new CircularBuffer<string>(3);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.length).toBe(3);
    expect(buf.slice()).toEqual(["b", "c", "d"]);
  });

  it("handles wrapping around multiple times", () => {
    const buf = new CircularBuffer<number>(2);
    for (let i = 0; i < 10; i++) {
      buf.push(i);
    }
    expect(buf.length).toBe(2);
    expect(buf.slice()).toEqual([8, 9]);
  });

  it("supports slice with offset", () => {
    const buf = new CircularBuffer<string>(5);
    buf.push("a");
    buf.push("b");
    buf.push("c");
    buf.push("d");
    expect(buf.slice(2)).toEqual(["c", "d"]);
  });

  it("returns empty array when slicing past size", () => {
    const buf = new CircularBuffer<number>(5);
    buf.push(1);
    expect(buf.slice(5)).toEqual([]);
  });

  it("returns empty array for empty buffer", () => {
    const buf = new CircularBuffer<string>(10);
    expect(buf.length).toBe(0);
    expect(buf.slice()).toEqual([]);
  });

  it("handles capacity of 1", () => {
    const buf = new CircularBuffer<string>(1);
    buf.push("a");
    expect(buf.slice()).toEqual(["a"]);
    buf.push("b");
    expect(buf.slice()).toEqual(["b"]);
    expect(buf.length).toBe(1);
  });
});
