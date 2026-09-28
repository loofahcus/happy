/**
 * Serializes async tasks by key so they run — and complete — in the exact order
 * they were enqueued, even when the async work inside a task resolves out of
 * order.
 *
 * Why this exists: terminal I/O is end-to-end encrypted with AES-GCM, whose
 * native encrypt/decrypt calls are genuinely asynchronous. socket.io delivers
 * packets in order, but awaiting decryption per packet lets two decrypts that
 * started in order finish out of order. For a byte stream (pasted input or
 * command output) that scrambles the text on screen. Chaining each task onto
 * the tail of the previous one for the same key restores strict FIFO ordering.
 *
 * It uses microtasks only (no setTimeout/macrotask hop), so it adds no latency
 * to high-throughput streams — the next task starts as soon as the previous
 * one settles.
 */
export function createAsyncSequencer() {
    // Per-key tail of the chain. Each tail never rejects (failures are
    // swallowed below) so a throwing task cannot break ordering for the rest.
    const tails = new Map<string, Promise<unknown>>();

    function enqueue<T>(key: string, task: () => Promise<T> | T): Promise<T> {
        const previous = tails.get(key) ?? Promise.resolve();
        const result = previous.then(() => task());

        // The chain continues regardless of whether this task resolves or
        // rejects; callers still observe rejection through `result`.
        const tail = result.then(
            () => undefined,
            () => undefined,
        );
        tails.set(key, tail);

        // Drop the entry once this task is the last one queued, so the map does
        // not grow without bound for long-lived keys.
        void tail.then(() => {
            if (tails.get(key) === tail) {
                tails.delete(key);
            }
        });

        return result;
    }

    return { enqueue };
}
