import { describe, expect, it } from 'vitest';
import {
  terminalCreateRequestSchema,
  terminalCreateResponseSchema,
  terminalAttachRequestSchema,
  terminalAttachResponseSchema,
  terminalResizeRequestSchema,
  terminalDestroyRequestSchema,
  terminalInfoSchema,
  terminalListResponseSchema,
  terminalEventSchema,
  terminalEncryptedEnvelopeSchema,
  type TerminalEvent,
} from './terminalProtocol';

describe('terminal protocol schemas', () => {
  describe('RPC request/response schemas', () => {
    it('accepts valid terminal:create requests', () => {
      expect(
        terminalCreateRequestSchema.safeParse({
          terminalId: 'term-1',
        }).success,
      ).toBe(true);

      expect(
        terminalCreateRequestSchema.safeParse({
          terminalId: 'term-2',
          cols: 120,
          rows: 40,
          shell: '/bin/zsh',
          cwd: '/home/user',
          env: { TERM_PROGRAM: 'happy' },
        }).success,
      ).toBe(true);
    });

    it('rejects invalid terminal:create requests', () => {
      expect(terminalCreateRequestSchema.safeParse({}).success).toBe(false);
      expect(
        terminalCreateRequestSchema.safeParse({
          terminalId: 'x',
          cols: -1,
        }).success,
      ).toBe(false);
      expect(
        terminalCreateRequestSchema.safeParse({
          terminalId: 'x',
          rows: 0,
        }).success,
      ).toBe(false);
    });

    it('accepts valid terminal:create responses', () => {
      expect(
        terminalCreateResponseSchema.safeParse({
          success: true,
          shell: '/bin/zsh',
        }).success,
      ).toBe(true);

      expect(
        terminalCreateResponseSchema.safeParse({
          success: false,
          shell: 'bash',
          error: 'spawn failed',
        }).success,
      ).toBe(true);
    });

    it('accepts valid terminal:attach requests and responses', () => {
      expect(
        terminalAttachRequestSchema.safeParse({
          terminalId: 'term-1',
          cols: 80,
          rows: 24,
        }).success,
      ).toBe(true);

      expect(
        terminalAttachResponseSchema.safeParse({
          success: true,
          bufferedChunks: 42,
        }).success,
      ).toBe(true);
    });

    it('accepts valid terminal:resize requests', () => {
      expect(
        terminalResizeRequestSchema.safeParse({
          terminalId: 'term-1',
          cols: 120,
          rows: 40,
        }).success,
      ).toBe(true);
    });

    it('rejects terminal:resize with missing dimensions', () => {
      expect(
        terminalResizeRequestSchema.safeParse({
          terminalId: 'term-1',
          cols: 120,
        }).success,
      ).toBe(false);
    });

    it('accepts valid terminal:destroy requests', () => {
      expect(
        terminalDestroyRequestSchema.safeParse({
          terminalId: 'term-1',
        }).success,
      ).toBe(true);
    });

    it('accepts valid terminal:list responses', () => {
      expect(
        terminalListResponseSchema.safeParse({
          terminals: [
            { terminalId: 'term-1', shell: '/bin/zsh', cols: 80, rows: 24 },
            { terminalId: 'term-2', shell: '/bin/bash', cols: 120, rows: 40 },
          ],
        }).success,
      ).toBe(true);

      expect(
        terminalListResponseSchema.safeParse({ terminals: [] }).success,
      ).toBe(true);
    });

    it('rejects terminal:list with incomplete terminal info', () => {
      expect(
        terminalListResponseSchema.safeParse({
          terminals: [{ terminalId: 'term-1', shell: '/bin/zsh' }],
        }).success,
      ).toBe(false);
    });
  });

  describe('streaming event schemas', () => {
    it('accepts all terminal event types', () => {
      const events: TerminalEvent[] = [
        { t: 'output', terminalId: 'term-1', data: 'hello world\r\n' },
        { t: 'input', terminalId: 'term-1', data: 'ls\r' },
        { t: 'closed', terminalId: 'term-1', reason: 'process_exit' },
        { t: 'closed', terminalId: 'term-1', reason: 'server_close' },
      ];

      for (const event of events) {
        expect(terminalEventSchema.safeParse(event).success).toBe(true);
      }
    });

    it('rejects malformed events', () => {
      expect(terminalEventSchema.safeParse({ t: 'output' }).success).toBe(false);
      expect(
        terminalEventSchema.safeParse({ t: 'output', terminalId: 'x' }).success,
      ).toBe(false);
      expect(
        terminalEventSchema.safeParse({
          t: 'closed',
          terminalId: 'x',
          reason: 'unknown',
        }).success,
      ).toBe(false);
      expect(terminalEventSchema.safeParse({ t: 'resize' }).success).toBe(false);
    });
  });

  describe('encrypted envelope schema', () => {
    it('accepts valid envelopes', () => {
      expect(
        terminalEncryptedEnvelopeSchema.safeParse({
          scope: 'session-abc-123',
          data: 'base64encodeddata==',
        }).success,
      ).toBe(true);
    });

    it('rejects envelopes with missing fields', () => {
      expect(
        terminalEncryptedEnvelopeSchema.safeParse({ scope: 'x' }).success,
      ).toBe(false);
      expect(
        terminalEncryptedEnvelopeSchema.safeParse({ data: 'x' }).success,
      ).toBe(false);
    });
  });
});
