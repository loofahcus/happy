/**
 * Tests for OutgoingMessageQueue + turn lifecycle integration.
 *
 * Part 1: Turn lifecycle pattern (using sessionProtocolMapper directly)
 *   Documents the bug and verifies the correct send-before-close pattern.
 *
 * Part 2: OutgoingMessageQueue.flush() behavior (using the real queue class)
 *   Verifies that flush() synchronously sends all pending messages before returning,
 *   which is critical for the fix: `await queue.flush()` then `closeClaudeSessionTurn()`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
    closeClaudeTurnWithStatus,
    mapClaudeLogMessageToSessionEnvelopes,
} from './sessionProtocolMapper'
import type { ClaudeSessionProtocolState } from './sessionProtocolMapper'

// ── Helpers ──────────────────────────────────────────────────────────────────

function createSessionClient() {
    const sent: Array<{ role: string; ev: any; turn?: string }> = []
    const state: ClaudeSessionProtocolState = { currentTurnId: null }

    return {
        state,
        sent,
        sendClaudeSessionMessage(body: any) {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(body, state)
            state.currentTurnId = mapped.currentTurnId
            for (const envelope of mapped.envelopes) {
                sent.push(envelope)
            }
        },
        closeClaudeSessionTurn(status: 'completed' | 'cancelled' | 'failed' = 'completed') {
            const mapped = closeClaudeTurnWithStatus(state, status)
            state.currentTurnId = mapped.currentTurnId
            for (const envelope of mapped.envelopes) {
                sent.push(envelope)
            }
        },
    }
}

function assistantLogMessage(text: string) {
    return {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        message: {
            role: 'assistant',
            content: [{ type: 'text', text }],
        },
        timestamp: new Date().toISOString(),
    }
}

function toolCallLogMessage(toolId: string) {
    return {
        type: 'assistant',
        uuid: crypto.randomUUID(),
        message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'ls' } }],
        },
        timestamp: new Date().toISOString(),
    }
}

// ── Part 1: Turn lifecycle pattern ───────────────────────────────────────────

describe('turn lifecycle pattern (sessionProtocolMapper)', () => {

    it('turn-end is lost when closeClaudeSessionTurn runs before message is sent', () => {
        const client = createSessionClient()

        // closeClaudeSessionTurn before any message → no-op (no active turn)
        client.closeClaudeSessionTurn('completed')
        expect(client.sent).toHaveLength(0)

        // Deferred message arrives too late
        client.sendClaudeSessionMessage(assistantLogMessage('Hello'))

        const turnEnds = client.sent.filter(e => e.ev.t === 'turn-end')
        expect(turnEnds).toHaveLength(0) // BUG: turn-end missing
    })

    it('turn-end is correctly sent when message is sent before close', () => {
        const client = createSessionClient()

        client.sendClaudeSessionMessage(assistantLogMessage('Hello'))
        client.closeClaudeSessionTurn('completed')

        const events = client.sent.map(e => e.ev.t)
        expect(events).toEqual(['turn-start', 'text', 'turn-end'])
    })

    it('handles two consecutive turns correctly', () => {
        const client = createSessionClient()

        client.sendClaudeSessionMessage(assistantLogMessage('Task completed'))
        client.closeClaudeSessionTurn('completed')
        client.sendClaudeSessionMessage(assistantLogMessage('Answer'))
        client.closeClaudeSessionTurn('completed')

        const events = client.sent.map(e => e.ev.t)
        expect(events).toEqual([
            'turn-start', 'text', 'turn-end',
            'turn-start', 'text', 'turn-end',
        ])
    })

    it('second turn-end is lost when second message is deferred', () => {
        const client = createSessionClient()

        // Turn 1: works
        client.sendClaudeSessionMessage(assistantLogMessage('Task completed'))
        client.closeClaudeSessionTurn('completed')

        // Turn 2: close before send → turn-end lost
        client.closeClaudeSessionTurn('completed')
        client.sendClaudeSessionMessage(assistantLogMessage('Answer'))

        const turnEnds = client.sent.filter(e => e.ev.t === 'turn-end')
        expect(turnEnds).toHaveLength(1) // Only turn 1
    })

    it('closeClaudeSessionTurn is safe with no active turn', () => {
        const client = createSessionClient()
        client.closeClaudeSessionTurn('completed')
        expect(client.sent).toHaveLength(0)
    })
})

// ── Part 2: OutgoingMessageQueue.flush() ─────────────────────────────────────

// Mock @/utils/lock before importing OutgoingMessageQueue
vi.mock('@/utils/lock', () => ({
    AsyncLock: class {
        async inLock<T>(func: () => Promise<T> | T): Promise<T> {
            return await func()
        }
    }
}))

// Must import AFTER vi.mock
const { OutgoingMessageQueue } = await import('./OutgoingMessageQueue')

describe('OutgoingMessageQueue flush guarantees', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('enqueue does NOT send synchronously (uses setTimeout(0))', () => {
        const sent: any[] = []
        const queue = new OutgoingMessageQueue((msg) => sent.push(msg))

        queue.enqueue(assistantLogMessage('Hello'))

        // Message NOT sent yet (deferred via setTimeout(0))
        expect(sent).toHaveLength(0)

        queue.destroy()
    })

    it('enqueue sends after setTimeout(0) fires', async () => {
        const sent: any[] = []
        const queue = new OutgoingMessageQueue((msg) => sent.push(msg))

        queue.enqueue(assistantLogMessage('Hello'))
        await vi.advanceTimersByTimeAsync(1)

        expect(sent).toHaveLength(1)
        expect(sent[0].message.content[0].text).toBe('Hello')

        queue.destroy()
    })

    it('flush() sends all pending messages immediately', async () => {
        const sent: any[] = []
        const queue = new OutgoingMessageQueue((msg) => sent.push(msg))

        queue.enqueue(assistantLogMessage('Msg 1'))
        queue.enqueue(assistantLogMessage('Msg 2'))
        queue.enqueue(assistantLogMessage('Msg 3'))

        // Nothing sent yet
        expect(sent).toHaveLength(0)

        // flush() sends everything
        await queue.flush()

        expect(sent).toHaveLength(3)
        expect(sent.map(m => m.message.content[0].text)).toEqual(['Msg 1', 'Msg 2', 'Msg 3'])

        queue.destroy()
    })

    it('flush() releases delayed messages', async () => {
        const sent: any[] = []
        const queue = new OutgoingMessageQueue((msg) => sent.push(msg))

        queue.enqueue(toolCallLogMessage('tool-1'), { delay: 250, toolCallIds: ['tool-1'] })

        expect(sent).toHaveLength(0)

        await queue.flush()

        expect(sent).toHaveLength(1)
        expect(sent[0].message.content[0].id).toBe('tool-1')

        queue.destroy()
    })

    it('flush() + closeClaudeSessionTurn produces correct turn lifecycle', async () => {
        // This is the EXACT pattern used in claudeRemoteLauncher onReady:
        //   await messageQueue.flush()
        //   session.client.closeClaudeSessionTurn('completed')
        const client = createSessionClient()
        const queue = new OutgoingMessageQueue(
            (msg) => client.sendClaudeSessionMessage(msg)
        )

        // Enqueue message (deferred via setTimeout(0))
        queue.enqueue(assistantLogMessage('Task done'))

        // Before flush: currentTurnId is still null
        expect(client.state.currentTurnId).toBeNull()

        // flush() sends the message → starts the turn
        await queue.flush()

        // After flush: turn is now active
        expect(client.state.currentTurnId).not.toBeNull()

        // Now close turn → turn-end is emitted
        client.closeClaudeSessionTurn('completed')

        const events = client.sent.map(e => e.ev.t)
        expect(events).toEqual(['turn-start', 'text', 'turn-end'])

        queue.destroy()
    })

    it('without flush, closeClaudeSessionTurn is a no-op (bug scenario)', async () => {
        const client = createSessionClient()
        const queue = new OutgoingMessageQueue(
            (msg) => client.sendClaudeSessionMessage(msg)
        )

        queue.enqueue(assistantLogMessage('Task done'))

        // Close turn WITHOUT flushing → no-op
        client.closeClaudeSessionTurn('completed')
        expect(client.sent).toHaveLength(0)

        // Message arrives later
        await vi.advanceTimersByTimeAsync(1)

        // Turn started but turn-end was lost
        const turnStarts = client.sent.filter(e => e.ev.t === 'turn-start')
        const turnEnds = client.sent.filter(e => e.ev.t === 'turn-end')
        expect(turnStarts).toHaveLength(1)
        expect(turnEnds).toHaveLength(0) // BUG confirmed

        queue.destroy()
    })

    it('rapid enqueue + flush + close across two turns', async () => {
        // Simulates the real scenario: notification turn then user message turn
        const client = createSessionClient()
        const queue = new OutgoingMessageQueue(
            (msg) => client.sendClaudeSessionMessage(msg)
        )

        // Turn 1: notification response
        queue.enqueue(assistantLogMessage('Task completed'))
        await queue.flush()
        client.closeClaudeSessionTurn('completed')

        // Turn 2: user message response (arrives on same tick)
        queue.enqueue(assistantLogMessage('Here is your answer'))
        await queue.flush()
        client.closeClaudeSessionTurn('completed')

        const events = client.sent.map(e => e.ev.t)
        expect(events).toEqual([
            'turn-start', 'text', 'turn-end',
            'turn-start', 'text', 'turn-end',
        ])

        const texts = client.sent.filter(e => e.ev.t === 'text').map(e => e.ev.text)
        expect(texts).toEqual(['Task completed', 'Here is your answer'])

        queue.destroy()
    })

    it('system messages are skipped by the queue', async () => {
        const sent: any[] = []
        const queue = new OutgoingMessageQueue((msg) => sent.push(msg))

        queue.enqueue({ type: 'system', subtype: 'init' })
        await queue.flush()

        // System messages are filtered out (line 124 in OutgoingMessageQueue)
        expect(sent).toHaveLength(0)

        queue.destroy()
    })
})

describe('end-to-end: OutgoingMessageQueue -> sessionProtocolMapper -> pendingOutbox -> server', () => {
    // Simulates the FULL chain that was never integration-tested before.
    // OutgoingMessageQueue.flush() -> sendClaudeSessionMessage -> mapClaudeLogMessageToSessionEnvelopes
    // -> enqueueMessage (pendingOutbox.push) -> flushOutbox (splice(0,n) FIFO) -> HTTP POST

    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    /** Simulates apiSession.sendClaudeSessionMessage + pendingOutbox + FIFO flushOutbox. */
    function createE2EClient() {
        const pendingOutbox: any[] = []
        const serverReceived: any[] = []
        const state: ClaudeSessionProtocolState = { currentTurnId: null }

        function sendClaudeSessionMessage(body: any) {
            const mapped = mapClaudeLogMessageToSessionEnvelopes(body, state)
            state.currentTurnId = mapped.currentTurnId
            for (const envelope of mapped.envelopes) {
                // Simulates enqueueMessage -> pendingOutbox.push
                pendingOutbox.push({ role: 'session', content: envelope })
            }
        }

        function closeClaudeSessionTurn(status: 'completed' = 'completed') {
            const mapped = closeClaudeTurnWithStatus(state, status)
            state.currentTurnId = mapped.currentTurnId
            for (const envelope of mapped.envelopes) {
                pendingOutbox.push({ role: 'session', content: envelope })
            }
        }

        function flushOutboxFIFO() {
            // The FIXED version: splice(0, batchSize) = FIFO
            while (pendingOutbox.length > 0) {
                const batch = pendingOutbox.splice(0, 2) // small batch to stress-test ordering
                serverReceived.push(...batch)
            }
        }

        function flushOutboxLIFO() {
            // The BUGGY version: splice(-batchSize) = LIFO
            while (pendingOutbox.length > 0) {
                const batchSize = Math.min(pendingOutbox.length, 2)
                const batch = pendingOutbox.splice(-batchSize, batchSize)
                serverReceived.push(...batch)
            }
        }

        return {
            state, pendingOutbox, serverReceived,
            sendClaudeSessionMessage, closeClaudeSessionTurn,
            flushOutboxFIFO, flushOutboxLIFO,
        }
    }

    it('FIFO flushOutbox: server receives turn-start -> content -> turn-end in order', async () => {
        const e2e = createE2EClient()
        const queue = new OutgoingMessageQueue(
            (msg) => e2e.sendClaudeSessionMessage(msg)
        )

        // Step 1: enqueue via OutgoingMessageQueue (deferred)
        queue.enqueue(assistantLogMessage('Task completed'))

        // Step 2: flush queue -> sendClaudeSessionMessage -> pendingOutbox
        await queue.flush()

        // Step 3: closeClaudeSessionTurn -> pendingOutbox
        e2e.closeClaudeSessionTurn('completed')

        // Step 4: flushOutbox FIFO -> server
        e2e.flushOutboxFIFO()

        const events = e2e.serverReceived
            .filter((m: any) => m.content?.ev)
            .map((m: any) => m.content.ev.t)

        expect(events).toEqual(['turn-start', 'text', 'turn-end'])

        queue.destroy()
    })

    it('LIFO flushOutbox (bug): server receives turn-end BEFORE content', async () => {
        const e2e = createE2EClient()
        const queue = new OutgoingMessageQueue(
            (msg) => e2e.sendClaudeSessionMessage(msg)
        )

        queue.enqueue(assistantLogMessage('Task completed'))
        await queue.flush()
        e2e.closeClaudeSessionTurn('completed')

        // LIFO flushOutbox (the bug)
        e2e.flushOutboxLIFO()

        const events = e2e.serverReceived
            .filter((m: any) => m.content?.ev)
            .map((m: any) => m.content.ev.t)

        // BUG: with batch=2 and 3 items, LIFO sends [text, turn-end] first, then [turn-start]
        const endIdx = events.indexOf('turn-end')
        const startIdx = events.indexOf('turn-start')
        expect(endIdx).toBeLessThan(startIdx) // turn-end arrives before turn-start!

        queue.destroy()
    })

    it('FIFO: two consecutive turns both arrive correctly at server', async () => {
        const e2e = createE2EClient()
        const queue = new OutgoingMessageQueue(
            (msg) => e2e.sendClaudeSessionMessage(msg)
        )

        // Turn 1: notification
        queue.enqueue(assistantLogMessage('Task done'))
        await queue.flush()
        e2e.closeClaudeSessionTurn('completed')

        // Turn 2: user message response
        queue.enqueue(assistantLogMessage('Here is your answer'))
        await queue.flush()
        e2e.closeClaudeSessionTurn('completed')

        // FIFO flush to server
        e2e.flushOutboxFIFO()

        const events = e2e.serverReceived
            .filter((m: any) => m.content?.ev)
            .map((m: any) => m.content.ev.t)

        expect(events).toEqual([
            'turn-start', 'text', 'turn-end',
            'turn-start', 'text', 'turn-end',
        ])

        queue.destroy()
    })
})

describe('pendingOutbox FIFO ordering (flushOutbox splice direction)', () => {
    // These tests verify that the outbox sends messages in FIFO order.
    // The bug was: flushOutbox used splice(-batchSize) (LIFO), sending
    // turn-end before turn-start+content when batched separately.

    it('splice(0, n) preserves FIFO order (correct)', () => {
        const outbox = ['turn-start', 'text-content', 'turn-end']
        const batch = outbox.splice(0, 3)
        expect(batch).toEqual(['turn-start', 'text-content', 'turn-end'])
    })

    it('splice(-n) reverses order when batch < total (the bug)', () => {
        const outbox = ['turn-start', 'text-content', 'turn-end']
        // When batch size is 1 (e.g., rate limiting), splice(-1) takes from end
        const batch1 = outbox.splice(-1, 1)
        expect(batch1).toEqual(['turn-end']) // BUG: turn-end sent first!

        const batch2 = outbox.splice(-1, 1)
        expect(batch2).toEqual(['text-content'])

        const batch3 = outbox.splice(-1, 1)
        expect(batch3).toEqual(['turn-start']) // turn-start sent last!
    })

    it('splice(0, n) sends in correct order even with batch size 1', () => {
        const outbox = ['turn-start', 'text-content', 'turn-end']

        const batch1 = outbox.splice(0, 1)
        expect(batch1).toEqual(['turn-start']) // correct: sent first

        const batch2 = outbox.splice(0, 1)
        expect(batch2).toEqual(['text-content'])

        const batch3 = outbox.splice(0, 1)
        expect(batch3).toEqual(['turn-end']) // correct: sent last
    })

    it('two consecutive turns maintain FIFO across batches', () => {
        const outbox = [
            'turn-start-1', 'text-1', 'turn-end-1',
            'turn-start-2', 'text-2', 'turn-end-2',
        ]
        const allSent: string[] = []

        // Simulate batched sending with batch size 2
        while (outbox.length > 0) {
            const batch = outbox.splice(0, 2) // FIFO
            allSent.push(...batch)
        }

        expect(allSent).toEqual([
            'turn-start-1', 'text-1',    // batch 1
            'turn-end-1', 'turn-start-2', // batch 2
            'text-2', 'turn-end-2',       // batch 3
        ])

        // turn-end-1 before turn-start-2: correct ordering
        expect(allSent.indexOf('turn-end-1')).toBeLessThan(allSent.indexOf('turn-start-2'))
    })
})
