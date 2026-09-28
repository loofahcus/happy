/**
 * Terminal protocol — shared types for integrated terminal streaming.
 *
 * Lifecycle operations (create, attach, resize, destroy, list) use the
 * existing RPC request/response pattern.  Terminal I/O (input, output,
 * closed) uses encrypted Socket.IO events for low-latency streaming.
 */

import * as z from "zod";

// ═══════════════════════════════════════════════════════════════════════════════
// RPC request / response schemas
// ═══════════════════════════════════════════════════════════════════════════════

export const terminalCreateRequestSchema = z.object({
  terminalId: z.string(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  shell: z.string().optional(),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type TerminalCreateRequest = z.infer<typeof terminalCreateRequestSchema>;

export const terminalCreateResponseSchema = z.object({
  success: z.boolean(),
  shell: z.string(),
  error: z.string().optional(),
});
export type TerminalCreateResponse = z.infer<
  typeof terminalCreateResponseSchema
>;

export const terminalAttachRequestSchema = z.object({
  terminalId: z.string(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
});
export type TerminalAttachRequest = z.infer<typeof terminalAttachRequestSchema>;

export const terminalAttachResponseSchema = z.object({
  success: z.boolean(),
  bufferedChunks: z.number().int(),
});
export type TerminalAttachResponse = z.infer<
  typeof terminalAttachResponseSchema
>;

export const terminalResizeRequestSchema = z.object({
  terminalId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export type TerminalResizeRequest = z.infer<typeof terminalResizeRequestSchema>;

export const terminalDestroyRequestSchema = z.object({
  terminalId: z.string(),
});
export type TerminalDestroyRequest = z.infer<
  typeof terminalDestroyRequestSchema
>;

export const terminalInfoSchema = z.object({
  terminalId: z.string(),
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
});
export type TerminalInfo = z.infer<typeof terminalInfoSchema>;

export const terminalListResponseSchema = z.object({
  terminals: z.array(terminalInfoSchema),
});
export type TerminalListResponse = z.infer<typeof terminalListResponseSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// Streaming event schemas (encrypted Socket.IO events)
// ═══════════════════════════════════════════════════════════════════════════════

export const terminalOutputEventSchema = z.object({
  t: z.literal("output"),
  terminalId: z.string(),
  data: z.string(),
});

export const terminalInputEventSchema = z.object({
  t: z.literal("input"),
  terminalId: z.string(),
  data: z.string(),
});

export const terminalClosedReasonSchema = z.enum([
  "process_exit",
  "server_close",
]);
export type TerminalClosedReason = z.infer<typeof terminalClosedReasonSchema>;

export const terminalClosedEventSchema = z.object({
  t: z.literal("closed"),
  terminalId: z.string(),
  reason: terminalClosedReasonSchema,
});

export const terminalEventSchema = z.discriminatedUnion("t", [
  terminalOutputEventSchema,
  terminalInputEventSchema,
  terminalClosedEventSchema,
]);
export type TerminalEvent = z.infer<typeof terminalEventSchema>;

export const terminalOutputPayloadSchema = z.object({
  terminalId: z.string(),
  data: z.string(),
});
export type TerminalOutputPayload = z.infer<typeof terminalOutputPayloadSchema>;

export const terminalInputPayloadSchema = z.object({
  terminalId: z.string(),
  data: z.string(),
});
export type TerminalInputPayload = z.infer<typeof terminalInputPayloadSchema>;

export const terminalClosedPayloadSchema = z.object({
  terminalId: z.string(),
  reason: terminalClosedReasonSchema,
});
export type TerminalClosedPayload = z.infer<typeof terminalClosedPayloadSchema>;

// ═══════════════════════════════════════════════════════════════════════════════
// Encrypted event envelope (wire format for Socket.IO transport)
// ═══════════════════════════════════════════════════════════════════════════════

export const terminalEncryptedEnvelopeSchema = z.object({
  scope: z.string(),
  data: z.string(),
});
export type TerminalEncryptedEnvelope = z.infer<
  typeof terminalEncryptedEnvelopeSchema
>;

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

export const TERMINAL_RPC_METHODS = {
  create: "terminal:create",
  attach: "terminal:attach",
  resize: "terminal:resize",
  destroy: "terminal:destroy",
  list: "terminal:list",
} as const;

export const TERMINAL_EVENTS = {
  output: "terminal:output",
  input: "terminal:input",
  closed: "terminal:closed",
} as const;

export const TERMINAL_DEFAULTS = {
  cols: 80,
  rows: 24,
  segmentBytes: 32 * 1024,
  bufferCapacity: 20_000,
} as const;

export const ATTACH_MODE_RESET =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";
