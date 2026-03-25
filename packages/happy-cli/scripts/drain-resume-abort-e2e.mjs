#!/usr/bin/env node
/**
 * Drain Resume & Abort E2E Test
 *
 * Tests drain mechanism behavior during:
 * - Test 1: Abort mid-task → recover with new message
 * - Test 2: Abort during drain cycle → recover
 * - Test 3: Resume after abort with pending background task notification
 *
 * Usage:  HAPPY_SERVER_URL=http://localhost:3005 node scripts/drain-resume-abort-e2e.mjs
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { io } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

const HAPPY_HOME = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const TEST_TIMEOUT_MS = 300_000;

// -- Encryption --
const enc64 = (b) => Buffer.from(b).toString('base64');
const dec64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rnd = (n) => new Uint8Array(randomBytes(n));
function encryptDK(data, key) {
    const n = rnd(12), c = createCipheriv('aes-256-gcm', key, n);
    const e = Buffer.concat([c.update(new TextEncoder().encode(JSON.stringify(data))), c.final()]);
    const t = c.getAuthTag(), b = new Uint8Array(1 + 12 + e.length + 16);
    b.set([0]); b.set(n, 1); b.set(new Uint8Array(e), 13); b.set(new Uint8Array(t), 13 + e.length);
    return b;
}
function decryptDK(b, key) {
    if (b.length < 29 || b[0] !== 0) return null;
    try {
        const d = createDecipheriv('aes-256-gcm', key, b.slice(1, 13));
        d.setAuthTag(b.slice(b.length - 16));
        return JSON.parse(new TextDecoder().decode(Buffer.concat([d.update(b.slice(13, b.length - 16)), d.final()])));
    } catch { return null; }
}
function encryptLeg(data, s) {
    const n = rnd(tweetnacl.secretbox.nonceLength);
    const e = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), n, s);
    const r = new Uint8Array(n.length + e.length); r.set(n); r.set(e, n.length); return r;
}
function decryptLeg(d, s) {
    const r = tweetnacl.secretbox.open(d.slice(tweetnacl.secretbox.nonceLength), d.slice(0, tweetnacl.secretbox.nonceLength), s);
    return r ? JSON.parse(new TextDecoder().decode(r)) : null;
}
const enc = (k, v, d) => v === 'legacy' ? encryptLeg(d, k) : encryptDK(d, k);
const dec = (k, v, d) => v === 'legacy' ? decryptLeg(d, k) : decryptDK(d, k);

// -- State --
function loadDaemon() {
    const s = JSON.parse(readFileSync(join(HAPPY_HOME, 'daemon.state.json'), 'utf8'));
    if (!s.httpPort) throw new Error('Daemon not running');
    return s;
}
function loadCred() {
    const r = JSON.parse(readFileSync(join(HAPPY_HOME, 'access.key'), 'utf8'));
    if (r.secret) return { token: r.token, type: 'legacy', secret: dec64(r.secret) };
    if (r.encryption) return { token: r.token, type: 'dataKey', publicKey: dec64(r.encryption.publicKey), machineKey: dec64(r.encryption.machineKey) };
    throw new Error('Unknown cred format');
}

async function daemonPost(port, path, body) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json();
}

// -- Session --
async function spawnSession(daemon, cred) {
    const serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
    const sp = await daemonPost(daemon.httpPort, '/spawn-session', {
        directory: process.cwd(),
        environmentVariables: { APPLE_CLAUDE_CODE_PORT: '0' }
    });
    if (!sp.success) throw new Error(`Spawn failed: ${JSON.stringify(sp)}`);
    console.log(`  Session spawned: ${sp.sessionId}`);

    const r = await fetch(`${serverUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${cred.token}` }
    });
    if (!r.ok) throw new Error(`Fetch sessions list failed: ${r.status}`);
    const allSessions = (await r.json()).sessions || [];
    const sess = allSessions.find(s => s.id === sp.sessionId);
    if (!sess) throw new Error(`Session ${sp.sessionId} not found`);

    let key, variant;
    if (sess.dataEncryptionKey && cred.type === 'dataKey') {
        const bundle = dec64(sess.dataEncryptionKey);
        const raw = bundle.slice(1);
        key = tweetnacl.box.open(raw.slice(56), raw.slice(32, 56), raw.slice(0, 32), cred.machineKey);
        if (!key) throw new Error('Failed to decrypt session key');
        variant = 'dataKey';
    } else {
        key = cred.secret; variant = 'legacy';
    }
    return { id: sp.sessionId, key, variant, seq: sess.seq, serverUrl };
}

// -- Socket.IO for RPC --
function connectSocket(serverUrl, token) {
    return new Promise((resolve, reject) => {
        const s = io(serverUrl, {
            auth: { token, clientType: 'user-scoped' },
            path: '/v1/updates', transports: ['websocket'], reconnection: false, timeout: 15_000,
        });
        s.on('connect', () => resolve(s));
        s.on('connect_error', e => reject(new Error(`Socket: ${e.message}`)));
        setTimeout(() => reject(new Error('Socket timeout')), 15_000);
    });
}

// -- Send abort RPC --
async function sendAbort(socket, session) {
    return new Promise((resolve, reject) => {
        const params = enc64(enc(session.key, session.variant, {}));
        const method = `${session.id}:abort`;
        console.log(`  --> ABORT RPC: ${method}`);
        socket.emit('rpc-request', { method, params }, (response) => {
            try {
                const result = dec(session.key, session.variant, dec64(response));
                console.log(`  <-- ABORT response:`, result);
                resolve(result);
            } catch (e) {
                console.log(`  <-- ABORT response (raw): ${typeof response === 'string' ? response.slice(0, 50) : response}`);
                resolve(null);
            }
        });
        setTimeout(() => resolve(null), 10_000);
    });
}

// -- Send message --
async function send(cred, session, text) {
    const content = { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web', permissionMode: 'default' } };
    const r = await fetch(`${session.serverUrl}/v3/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ localId: randomUUID(), content: enc64(enc(session.key, session.variant, content)) }] }),
    });
    if (!r.ok) throw new Error(`Send failed: ${r.status}`);
    console.log(`\n  --> USER: "${text}"`);
}

// -- Poller --
function createPoller(cred, session) {
    const allMsgs = [];
    const violations = [];
    let afterSeq = 0;

    async function poll() {
        const r = await fetch(
            `${session.serverUrl}/v3/sessions/${encodeURIComponent(session.id)}/messages?after_seq=${afterSeq}&limit=100`,
            { headers: { Authorization: `Bearer ${cred.token}` } }
        );
        if (!r.ok) return;
        const data = await r.json();
        for (const msg of (data.messages || [])) {
            if (msg.seq > afterSeq) afterSeq = msg.seq;
            if (msg.content?.t !== 'encrypted') continue;
            try {
                const body = dec(session.key, session.variant, dec64(msg.content.c));
                if (!body) continue;
                allMsgs.push(body);
                const ev = body?.content?.ev;
                if (ev?.t === 'text' && typeof ev.text === 'string') {
                    if (ev.text.trim() === 'PONG') {
                        violations.push({ type: 'PONG', text: ev.text, seq: msg.seq });
                        console.error(`  !! PONG LEAK (seq=${msg.seq}): "${ev.text}"`);
                    }
                    if (/\[SYSTEM: Internal keepalive ping/.test(ev.text)) {
                        violations.push({ type: 'DRAIN', text: ev.text, seq: msg.seq });
                        console.error(`  !! DRAIN LEAK (seq=${msg.seq})`);
                    }
                    if (body.content?.role === 'agent') {
                        const preview = ev.text.slice(0, 120) + (ev.text.length > 120 ? '...' : '');
                        console.log(`      <-- AGENT: "${preview}"`);
                    }
                }
                if (ev?.t === 'tool-call-start') console.log(`      <-- [tool-call] ${ev.name}`);
                if (ev?.t === 'turn-end') console.log(`      <-- [turn-end: ${ev.status}]`);
            } catch {}
        }
    }

    const iv = setInterval(poll, 2000);
    const stop = () => clearInterval(iv);
    return { allMsgs, violations, stop, poll };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const turnEnds = (msgs) => msgs.filter(m => m?.content?.ev?.t === 'turn-end').length;
const turnEndsByStatus = (msgs, status) => msgs.filter(m => m?.content?.ev?.t === 'turn-end' && m.content.ev.status === status).length;

async function waitForCondition(fn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (fn()) return true;
        await sleep(1000);
    }
    return false;
}

// -- Main --
async function main() {
    const timer = setTimeout(() => { console.error('\nTEST TIMEOUT'); process.exit(1); }, TEST_TIMEOUT_MS);
    console.log('\n========================================');
    console.log('  Drain Resume & Abort E2E Test');
    console.log('========================================\n');

    const daemon = loadDaemon();
    const cred = loadCred();
    const serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
    console.log(`Daemon port: ${daemon.httpPort}, cred type: ${cred.type}`);

    // Connect a socket for RPC calls
    const socket = await connectSocket(serverUrl, cred.token);
    console.log('Socket connected for RPC\n');

    // =========================================================
    // TEST 1: Abort mid-task, then send follow-up
    // =========================================================
    console.log('--- TEST 1: Abort mid-task → recover ---');
    console.log('  Goal: Abort a running task, then send a new message.');
    console.log('  Verify the follow-up gets a response, no PONG/DRAIN leaks.\n');

    const s1 = await spawnSession(daemon, cred);
    const p1 = createPoller(cred, s1);
    await p1.poll();
    await sleep(10000);

    // Send a message that will take a while (background task + response)
    await send(cred, s1, 'Please create a background task using Bash with run_in_background=true: sleep 30. After creating it, write a detailed essay about the history of computing in 500 words.');

    // Wait for Claude to start responding (at least a tool call or text)
    console.log('\n  [Waiting for Claude to start responding...]');
    await waitForCondition(() => p1.allMsgs.length > 0 && p1.allMsgs.some(m => m?.content?.ev?.t === 'tool-call-start' || (m?.content?.ev?.t === 'text' && m?.content?.role === 'agent')), 30_000);

    // Send abort
    console.log('\n  [Sending abort...]');
    await sendAbort(socket, s1);
    await sleep(3000);
    await p1.poll();

    const t1CancelledTurns = turnEndsByStatus(p1.allMsgs, 'cancelled');
    const t1CompletedTurns = turnEndsByStatus(p1.allMsgs, 'completed');
    console.log(`  After abort: cancelled=${t1CancelledTurns}, completed=${t1CompletedTurns}`);

    // Send follow-up message
    await send(cred, s1, 'Hello, are you still there? Just say hi briefly.');
    console.log('\n  [Waiting for follow-up response...]');
    const t1TotalBefore = turnEnds(p1.allMsgs);
    const t1Ok = await waitForCondition(() => turnEnds(p1.allMsgs) > t1TotalBefore, 60_000);
    await p1.poll();

    if (t1Ok) {
        console.log(`  Follow-up received! turns=${turnEnds(p1.allMsgs)}`);
    } else {
        console.log(`  WARNING: Follow-up did not produce a turn-end`);
    }

    console.log(`  Violations: ${p1.violations.length}`);
    console.log('\n  TEST 1 COMPLETE');

    p1.stop();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: s1.id });
    await sleep(2000);

    // =========================================================
    // TEST 2: Start bg task, wait for drain to begin, abort mid-drain
    // =========================================================
    console.log('\n\n--- TEST 2: Abort during post-ready drain ---');
    console.log('  Goal: Start a bg task (sleep 5), let drain begin after');
    console.log('  task creation, abort during drain, then recover.\n');

    const s2 = await spawnSession(daemon, cred);
    const p2 = createPoller(cred, s2);
    await p2.poll();
    await sleep(10000);

    await send(cred, s2, 'Create a background task using Bash with run_in_background=true: sleep 5. Just confirm it was started, nothing else.');

    // Wait for the task to be created (tool call should appear)
    console.log('\n  [Waiting for task creation...]');
    await waitForCondition(() => p2.allMsgs.some(m => m?.content?.ev?.t === 'tool-call-start'), 30_000);

    // Wait a few seconds for the drain mechanism to start (post-ready drain starts after result)
    console.log('  [Waiting 8s for post-ready drain to engage...]');
    await sleep(8000);

    // Send abort during the drain
    console.log('  [Sending abort during drain...]');
    await sendAbort(socket, s2);
    await sleep(3000);
    await p2.poll();

    const t2AfterAbort = turnEnds(p2.allMsgs);
    console.log(`  After abort: total turn-ends=${t2AfterAbort}`);

    // Send follow-up
    await send(cred, s2, 'Are you there? Say hi.');
    console.log('\n  [Waiting for follow-up response...]');
    const t2Ok = await waitForCondition(() => turnEnds(p2.allMsgs) > t2AfterAbort, 60_000);
    await p2.poll();

    if (t2Ok) {
        console.log(`  Follow-up received! turns=${turnEnds(p2.allMsgs)}`);
    } else {
        console.log(`  WARNING: Follow-up did not produce a turn-end`);
    }

    console.log(`  Violations: ${p2.violations.length}`);
    console.log('\n  TEST 2 COMPLETE');

    p2.stop();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: s2.id });
    await sleep(2000);

    // =========================================================
    // TEST 3: Abort, then bg task completes, then resume
    // =========================================================
    console.log('\n\n--- TEST 3: Abort → bg task completes → resume with drain ---');
    console.log('  Goal: Start a bg task (sleep 10), abort immediately,');
    console.log('  wait for task to complete, send new message, verify');
    console.log('  the notification is properly drained.\n');

    const s3 = await spawnSession(daemon, cred);
    const p3 = createPoller(cred, s3);
    await p3.poll();
    await sleep(10000);

    await send(cred, s3, 'Create a background task using Bash with run_in_background=true: sleep 10. Just confirm it started.');

    // Wait for tool call
    console.log('\n  [Waiting for task to be created...]');
    await waitForCondition(() => p3.allMsgs.some(m => m?.content?.ev?.t === 'tool-call-start'), 30_000);
    await sleep(2000);

    // Abort immediately
    console.log('  [Aborting turn while bg task runs...]');
    await sendAbort(socket, s3);
    await sleep(3000);
    await p3.poll();

    const t3AfterAbort = turnEnds(p3.allMsgs);
    console.log(`  After abort: turn-ends=${t3AfterAbort}`);

    // Wait for the background task to complete (sleep 10 → ~10-15s)
    console.log('  [Waiting 15s for background task to complete...]');
    await sleep(15000);

    // Send a new message — the drain mechanism should pick up the
    // completed task notification when the new turn starts
    await send(cred, s3, 'What happened with the background task? Did it complete?');
    console.log('\n  [Waiting for response with task notification...]');
    const t3Ok = await waitForCondition(() => turnEnds(p3.allMsgs) > t3AfterAbort, 60_000);
    await p3.poll();

    if (t3Ok) {
        const newTurns = turnEnds(p3.allMsgs) - t3AfterAbort;
        console.log(`  Response received! ${newTurns} new turn-end(s)`);
        // Check if the agent mentioned the task completion
        const agentTexts = p3.allMsgs
            .filter(m => m?.content?.role === 'agent' && m?.content?.ev?.t === 'text')
            .map(m => m.content.ev.text);
        const mentionsCompletion = agentTexts.some(t => /complet|finish|done|success|exit.*0/i.test(t));
        console.log(`  Task completion mentioned: ${mentionsCompletion}`);
    } else {
        console.log(`  WARNING: No response received`);
    }

    console.log(`  Violations: ${p3.violations.length}`);
    console.log('\n  TEST 3 COMPLETE');

    p3.stop();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: s3.id });

    // =========================================================
    // RESULTS
    // =========================================================
    const allViolations = [...p1.violations, ...p2.violations, ...p3.violations];
    console.log('\n\n========================================');
    console.log('  RESULTS');
    console.log('========================================');
    console.log(`  Test 1 (abort mid-task):     turns=${turnEnds(p1.allMsgs)}, violations=${p1.violations.length}`);
    console.log(`  Test 2 (abort during drain): turns=${turnEnds(p2.allMsgs)}, violations=${p2.violations.length}`);
    console.log(`  Test 3 (abort → resume):     turns=${turnEnds(p3.allMsgs)}, violations=${p3.violations.length}`);
    console.log(`  Total violations: ${allViolations.length}`);
    console.log();

    socket.close();

    if (allViolations.length > 0) {
        console.log('  FAIL - PONG/DRAIN leaks detected:');
        allViolations.forEach(v => console.error(`    ${v.type} (seq=${v.seq}): "${v.text.slice(0, 80)}"`));
        console.log();
        clearTimeout(timer); process.exit(1);
    }

    console.log('  PASS - No PONG/DRAIN leaks');
    console.log('========================================\n');
    clearTimeout(timer); process.exit(0);
}

main().catch(e => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
