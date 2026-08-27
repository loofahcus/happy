import { describe, it, expect } from 'vitest'
import { coalesceSegments } from './outputCoalescer'

describe('coalesceSegments', () => {
    it('merges a burst of small chunks into one payload', () => {
        expect(coalesceSegments(['a', 'b', 'c', 'd'], 100)).toEqual(['abcd'])
    })

    it('preserves byte order exactly', () => {
        const chunks = ['\x1b[2K', '\r', '$ ', 'l', 's']
        expect(coalesceSegments(chunks, 100).join('')).toBe(chunks.join(''))
    })

    it('never exceeds the segment limit', () => {
        const payloads = coalesceSegments(['aaaa', 'bbbb', 'cccc'], 5)
        expect(payloads).toEqual(['aaaa', 'bbbb', 'cccc'])
        for (const p of payloads) {
            expect(p.length).toBeLessThanOrEqual(5)
        }
    })

    it('fills up to the limit before starting a new payload', () => {
        expect(coalesceSegments(['ab', 'cd', 'ef'], 4)).toEqual(['abcd', 'ef'])
    })

    it('splits a single oversized chunk', () => {
        expect(coalesceSegments(['abcdefg'], 3)).toEqual(['abc', 'def', 'g'])
    })

    it('flushes the buffer before splitting an oversized chunk, keeping order', () => {
        expect(coalesceSegments(['xy', 'abcdef'], 3)).toEqual(['xy', 'abc', 'def'])
    })

    it('drops empty chunks rather than paying a round trip for nothing', () => {
        expect(coalesceSegments(['', 'a', '', 'b'], 100)).toEqual(['ab'])
        expect(coalesceSegments(['', ''], 100)).toEqual([])
    })

    it('returns nothing for an empty queue', () => {
        expect(coalesceSegments([], 100)).toEqual([])
    })
})
