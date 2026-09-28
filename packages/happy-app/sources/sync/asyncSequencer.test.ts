import { describe, it, expect } from 'vitest';
import { createAsyncSequencer } from './asyncSequencer';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

describe('createAsyncSequencer', () => {
    it('preserves enqueue order even when the earlier task resolves later', async () => {
        const seq = createAsyncSequencer();
        const order: number[] = [];
        const gate0 = deferred();
        const gate1 = deferred();

        const p0 = seq.enqueue('k', async () => {
            await gate0.promise;
            order.push(0);
        });
        const p1 = seq.enqueue('k', async () => {
            await gate1.promise;
            order.push(1);
        });

        // Open the SECOND task's gate first. If the tasks ran concurrently
        // (the bug), task 1 would finish before task 0 -> [1, 0]. The sequencer
        // must hold task 1 until task 0 completes.
        gate1.resolve();
        await Promise.resolve();
        expect(order).toEqual([]);

        gate0.resolve();
        await Promise.all([p0, p1]);
        expect(order).toEqual([0, 1]);
    });

    it('runs independent keys without blocking each other', async () => {
        const seq = createAsyncSequencer();
        const order: string[] = [];
        const gateA = deferred();

        const pA = seq.enqueue('a', async () => {
            await gateA.promise;
            order.push('a');
        });
        const pB = seq.enqueue('b', async () => {
            order.push('b');
        });

        await pB;
        expect(order).toEqual(['b']); // 'b' not blocked by the gated 'a'

        gateA.resolve();
        await pA;
        expect(order).toEqual(['b', 'a']);
    });

    it('keeps the chain running after a task rejects', async () => {
        const seq = createAsyncSequencer();
        const order: number[] = [];

        const p0 = seq.enqueue('k', async () => {
            order.push(0);
            throw new Error('boom');
        });
        const p1 = seq.enqueue('k', async () => {
            order.push(1);
        });

        await expect(p0).rejects.toThrow('boom');
        await p1;
        expect(order).toEqual([0, 1]);
    });
});
