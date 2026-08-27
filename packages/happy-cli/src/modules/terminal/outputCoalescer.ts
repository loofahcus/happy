/**
 * Concatenating terminal output before it goes on the wire.
 *
 * A shell redrawing its prompt line emits many tiny writes in quick
 * succession, and every socket event costs a separate encrypt, frame, relay
 * hop, and ordered decrypt on the client. Merging the queue into as few
 * payloads as the segment limit allows turns a burst of small events into one.
 *
 * Kept separate from terminalHandler so it is testable without node-pty or a
 * socket.
 */

/**
 * Merge queued chunks into payloads no larger than `segmentBytes`, preserving
 * order. A single chunk at or above the limit is split across payloads.
 *
 * Empty chunks are dropped: they carry nothing and an empty payload would
 * still cost a full round trip.
 */
export function coalesceSegments(
  pending: readonly string[],
  segmentBytes: number,
): string[] {
  const payloads: string[] = [];
  let buffer = "";

  for (const chunk of pending) {
    if (chunk.length === 0) continue;

    if (chunk.length >= segmentBytes) {
      if (buffer) {
        payloads.push(buffer);
        buffer = "";
      }
      for (let i = 0; i < chunk.length; i += segmentBytes) {
        payloads.push(chunk.slice(i, i + segmentBytes));
      }
      continue;
    }

    if (buffer.length + chunk.length > segmentBytes) {
      payloads.push(buffer);
      buffer = chunk;
    } else {
      buffer += chunk;
    }
  }

  if (buffer) payloads.push(buffer);
  return payloads;
}
