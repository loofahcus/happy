/**
 * Terminal streaming PoC benchmark
 *
 * Tests the full pipeline: PTY spawn → output capture → encrypt → base64 →
 * (simulated network) → base64 decode → decrypt → deliver.
 *
 * Measures:
 *   1. Encryption throughput (MB/s)
 *   2. Per-segment latency (ms)
 *   3. End-to-end PTY command latency (ms)
 *   4. Burst throughput under load (cat large data)
 *
 * Run: npx tsx packages/happy-cli/tests/terminal-benchmark.ts
 */

import pty from 'node-pty';
import { encrypt, decrypt, encodeBase64, decodeBase64 } from '../src/api/encryption';
import { CircularBuffer } from '../src/modules/terminal/circularBuffer';
import { randomBytes } from 'node:crypto';

const SEGMENT_BYTES = 32 * 1024;
const BUFFER_CAPACITY = 20_000;

// Generate a session-like encryption key
const encryptionKey = new Uint8Array(randomBytes(32));
const encryptionVariant = 'dataKey' as const;

// ─── Benchmark 1: Raw encrypt/decrypt throughput ────────────────────────────

function benchEncryption(): void {
  console.log('\n═══ Benchmark 1: Encryption Throughput ═══');

  const sizes = [1024, 4096, 16384, 32768, 65536];

  for (const size of sizes) {
    const data = { terminalId: 'test', data: 'x'.repeat(size) };
    const iterations = 1000;

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, data));
      const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encrypted));
    }
    const elapsed = performance.now() - start;

    const totalBytes = size * iterations;
    const mbPerSec = (totalBytes / (1024 * 1024)) / (elapsed / 1000);
    const perOpMs = elapsed / iterations;

    console.log(
      `  ${(size / 1024).toFixed(0).padStart(3)}KB payload: ` +
      `${mbPerSec.toFixed(1).padStart(7)} MB/s  ` +
      `${perOpMs.toFixed(3).padStart(7)} ms/op  ` +
      `(${iterations} iterations in ${elapsed.toFixed(0)}ms)`
    );
  }
}

// ─── Benchmark 2: Simulated segment streaming ──────────────────────────────

function benchSegmentedStreaming(): void {
  console.log('\n═══ Benchmark 2: Segmented Streaming (32KB segments) ═══');

  // Simulate streaming 1MB of terminal output
  const totalSize = 1024 * 1024;
  const sourceData = 'A'.repeat(totalSize);
  const segments: string[] = [];

  const encryptStart = performance.now();
  for (let offset = 0; offset < sourceData.length; offset += SEGMENT_BYTES) {
    const segment = sourceData.slice(offset, offset + SEGMENT_BYTES);
    const payload = { terminalId: 'test-stream', data: segment };
    const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, payload));
    segments.push(encrypted);
  }
  const encryptElapsed = performance.now() - encryptStart;

  const decryptStart = performance.now();
  let decryptedTotal = 0;
  for (const seg of segments) {
    const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(seg));
    decryptedTotal += decrypted.data.length;
  }
  const decryptElapsed = performance.now() - decryptStart;

  const encryptMbps = (totalSize / (1024 * 1024)) / (encryptElapsed / 1000);
  const decryptMbps = (totalSize / (1024 * 1024)) / (decryptElapsed / 1000);

  console.log(`  Source:    ${(totalSize / 1024).toFixed(0)} KB → ${segments.length} segments`);
  console.log(`  Encrypt:   ${encryptElapsed.toFixed(1)}ms (${encryptMbps.toFixed(1)} MB/s)`);
  console.log(`  Decrypt:   ${decryptElapsed.toFixed(1)}ms (${decryptMbps.toFixed(1)} MB/s)`);
  console.log(`  Per-seg:   ${(encryptElapsed / segments.length).toFixed(2)}ms encrypt, ${(decryptElapsed / segments.length).toFixed(2)}ms decrypt`);
  console.log(`  Overhead:  ${((segments.reduce((a, s) => a + s.length, 0) / totalSize - 1) * 100).toFixed(1)}% base64+envelope expansion`);
  console.log(`  Verified:  ${decryptedTotal === totalSize ? 'OK' : 'MISMATCH!'} (${decryptedTotal} bytes)`);
}

// ─── Benchmark 3: CircularBuffer performance ───────────────────────────────

function benchCircularBuffer(): void {
  console.log('\n═══ Benchmark 3: CircularBuffer (replay simulation) ═══');

  const buffer = new CircularBuffer<string>(BUFFER_CAPACITY);
  const chunkSize = 4096;
  const totalChunks = 1000;

  const writeStart = performance.now();
  for (let i = 0; i < totalChunks; i++) {
    buffer.push('X'.repeat(chunkSize));
  }
  const writeElapsed = performance.now() - writeStart;

  const readStart = performance.now();
  const chunks = buffer.slice();
  const readElapsed = performance.now() - readStart;

  const replayData = chunks.join('');
  const replaySegments: string[] = [];
  const replayStart = performance.now();
  for (let offset = 0; offset < replayData.length; offset += SEGMENT_BYTES) {
    const segment = replayData.slice(offset, offset + SEGMENT_BYTES);
    const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, { terminalId: 'replay', data: segment }));
    replaySegments.push(encrypted);
  }
  const replayElapsed = performance.now() - replayStart;

  console.log(`  Write:     ${totalChunks} chunks × ${chunkSize}B in ${writeElapsed.toFixed(2)}ms`);
  console.log(`  Read:      ${chunks.length} chunks (${(replayData.length / 1024).toFixed(1)}KB) in ${readElapsed.toFixed(2)}ms`);
  console.log(`  Replay:    ${replaySegments.length} encrypted segments in ${replayElapsed.toFixed(1)}ms`);
}

// ─── Benchmark 4: Live PTY latency ─────────────────────────────────────────

async function benchPtyLatency(): Promise<void> {
  console.log('\n═══ Benchmark 4: Live PTY End-to-End Latency ═══');

  return new Promise<void>((resolve) => {
    const shell = process.env.SHELL ?? 'bash';
    const ptyProcess = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      env: process.env as Record<string, string>,
    });

    let outputBuffer = '';
    const sentinel = `__BENCH_${Date.now()}__`;
    let sentAt = 0;
    let firstByteLatency = -1;
    let fullResponseLatency = -1;
    let totalEncryptedBytes = 0;
    let segmentCount = 0;

    ptyProcess.onData((data) => {
      // Simulate the full pipeline
      const payload = { terminalId: 'bench-pty', data };
      const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, payload));
      totalEncryptedBytes += encrypted.length;
      segmentCount++;

      const decrypted = decrypt(encryptionKey, encryptionVariant, decodeBase64(encrypted));
      const now = performance.now();

      if (sentAt > 0 && firstByteLatency < 0) {
        firstByteLatency = now - sentAt;
      }

      outputBuffer += decrypted.data;

      if (outputBuffer.includes(sentinel) && fullResponseLatency < 0) {
        fullResponseLatency = now - sentAt;

        console.log(`  Command:   echo "${sentinel}"`);
        console.log(`  First byte: ${firstByteLatency.toFixed(2)}ms`);
        console.log(`  Full echo:  ${fullResponseLatency.toFixed(2)}ms`);
        console.log(`  Segments:   ${segmentCount}`);
        console.log(`  Wire bytes: ${totalEncryptedBytes} (${(totalEncryptedBytes / outputBuffer.length).toFixed(1)}x expansion)`);

        ptyProcess.kill();
        resolve();
      }
    });

    // Wait for shell prompt, then send the echo command
    setTimeout(() => {
      outputBuffer = '';
      totalEncryptedBytes = 0;
      segmentCount = 0;
      firstByteLatency = -1;
      fullResponseLatency = -1;
      sentAt = performance.now();
      ptyProcess.write(`echo "${sentinel}"\r`);
    }, 500);

    // Safety timeout
    setTimeout(() => {
      if (fullResponseLatency < 0) {
        console.log('  TIMEOUT: PTY did not respond in 5s');
        ptyProcess.kill();
        resolve();
      }
    }, 5000);
  });
}

// ─── Benchmark 5: Burst throughput (simulated `cat` of large data) ──────────

async function benchBurstThroughput(): Promise<void> {
  console.log('\n═══ Benchmark 5: Burst Throughput (cat /dev/urandom 1MB) ═══');

  return new Promise<void>((resolve) => {
    const ptyProcess = pty.spawn('sh', ['-c', 'head -c 1048576 /dev/urandom | base64; echo __DONE__'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd: '/tmp',
      env: process.env as Record<string, string>,
    });

    let totalRawBytes = 0;
    let totalEncryptedBytes = 0;
    let segmentCount = 0;
    let pendingData = '';
    const startTime = performance.now();

    ptyProcess.onData((data) => {
      totalRawBytes += data.length;
      pendingData += data;

      // Process in segments like the real handler
      while (pendingData.length >= SEGMENT_BYTES) {
        const segment = pendingData.slice(0, SEGMENT_BYTES);
        pendingData = pendingData.slice(SEGMENT_BYTES);

        const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, {
          terminalId: 'burst',
          data: segment,
        }));
        totalEncryptedBytes += encrypted.length;
        segmentCount++;

        // Simulate client-side decrypt
        decrypt(encryptionKey, encryptionVariant, decodeBase64(encrypted));
      }

      if (data.includes('__DONE__')) {
        // Flush remaining
        if (pendingData.length > 0) {
          const encrypted = encodeBase64(encrypt(encryptionKey, encryptionVariant, {
            terminalId: 'burst',
            data: pendingData,
          }));
          totalEncryptedBytes += encrypted.length;
          segmentCount++;
          decrypt(encryptionKey, encryptionVariant, decodeBase64(encrypted));
          pendingData = '';
        }

        const elapsed = performance.now() - startTime;
        const rawMbps = (totalRawBytes / (1024 * 1024)) / (elapsed / 1000);
        const encMbps = (totalEncryptedBytes / (1024 * 1024)) / (elapsed / 1000);

        console.log(`  Duration:  ${elapsed.toFixed(0)}ms`);
        console.log(`  Raw data:  ${(totalRawBytes / 1024).toFixed(0)}KB`);
        console.log(`  Encrypted: ${(totalEncryptedBytes / 1024).toFixed(0)}KB (${(totalEncryptedBytes / totalRawBytes).toFixed(1)}x)`);
        console.log(`  Segments:  ${segmentCount}`);
        console.log(`  Throughput: ${rawMbps.toFixed(1)} MB/s raw → ${encMbps.toFixed(1)} MB/s encrypted`);
        console.log(`  Per-seg:   ${(elapsed / segmentCount).toFixed(2)}ms`);

        ptyProcess.kill();
        resolve();
      }
    });

    setTimeout(() => {
      console.log('  TIMEOUT');
      ptyProcess.kill();
      resolve();
    }, 15000);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Terminal Streaming PoC — Performance Benchmark');
  console.log('══════════════════════════════════════════════');
  console.log(`Encryption: AES-256-GCM (dataKey variant)`);
  console.log(`Segment size: ${SEGMENT_BYTES / 1024}KB`);
  console.log(`Buffer capacity: ${BUFFER_CAPACITY} entries`);

  benchEncryption();
  benchSegmentedStreaming();
  benchCircularBuffer();
  await benchPtyLatency();
  await benchBurstThroughput();

  console.log('\n══════════════════════════════════════════════');
  console.log('Benchmark complete.');
}

main().catch(console.error);
