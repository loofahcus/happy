#!/usr/bin/env node
/**
 * Drain Background Task E2E Test
 *
 * Tests whether background task completions are correctly delivered to the
 * webapp via the drain mechanism.
 *
 * Test 1: Single background task (sleep 10s)
 *   - Send message, wait for turn-end, then wait 15s more to see if task result arrives
 *   - If not, send follow-up to trigger drain
 *
 * Test 2: Three background tasks (sleep 20, sleep 40, sleep 60)
 *   - Send message, wait for initial turn-end
 *   - Wait and send follow-ups at intervals to see results arrive
 *
 * Usage:  HAPPY_SERVER_URL=http://localhost:3005 node scripts/drain-bg-task-e2e.mjs
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';

const HAPPY_HOME = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const TEST_TIMEOUT_MS = 360_000; // 6 minutes

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

// -- Load state --
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
                        violations.push({ type: 'PONG', text: ev.text });
                        console.error(`  !! PONG LEAK: "${ev.text}"`);
                    }
                    if (/\[SYSTEM: Internal keepalive ping/.test(ev.text)) {
                        violations.push({ type: 'DRAIN', text: ev.text });
                        console.error(`  !! DRAIN LEAK`);
                    }
                    if (body.content?.role === 'agent') {
                        const preview = ev.text.slice(0, 140) + (ev.text.length > 140 ? '...' : '');
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
const turnEnds = (msgs) => msgs.filter(m => m?.content?.ev?.t === 'turn-end' && m.content.ev.status === 'completed').length;
const agentTexts = (msgs) => msgs
    .filter(m => m?.content?.role === 'agent' && m?.content?.ev?.t === 'text')
    .map(m => m.content.ev.text);

async function waitForCondition(fn, timeoutMs, label) {
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
    console.log('  Drain Background Task E2E Test');
    console.log('========================================\n');

    const daemon = loadDaemon();
    const cred = loadCred();
    console.log(`Daemon port: ${daemon.httpPort}, cred type: ${cred.type}`);

    const session = await spawnSession(daemon, cred);
    console.log(`Session: ${session.id}, variant: ${session.variant}`);

    const { allMsgs, violations, stop: stopPoller, poll } = createPoller(cred, session);
    await poll();

    console.log('\nWaiting for Claude session to initialize (10s)...');
    await sleep(10000);

    // =========================================================
    // TEST 1: Single background task (sleep 10s)
    // =========================================================
    console.log('\n--- TEST 1: Single background task (sleep 10s) ---');

    await send(cred, session, 'Please create a single background task using the Bash tool: run `sleep 10` with run_in_background=true. After creating it, briefly confirm it was started.');

    // Wait for at least 1 turn-end (the initial response)
    const ok1 = await waitForCondition(() => turnEnds(allMsgs) >= 1, 90_000, 'test1 first turn-end');
    if (!ok1) { console.error('FAIL: No turn-end received for test 1'); stopPoller(); clearTimeout(timer); process.exit(1); }

    const t1FirstTurnEnd = turnEnds(allMsgs);
    const t1AgentTexts = agentTexts(allMsgs);
    const t1TaskMentioned = t1AgentTexts.some(t => /complet|finish|done|success|exit/i.test(t));

    console.log(`\n  After first turn-end (turns=${t1FirstTurnEnd}):`);
    console.log(`    Task completion mentioned in initial response: ${t1TaskMentioned}`);

    if (t1TaskMentioned) {
        console.log('    -> Drain delivered task result WITHIN the same turn (proactive drain)');
    } else {
        // Wait 15s for the background task to complete, check for proactive notification
        console.log('\n  [Waiting 15s for background task to finish...]');
        await sleep(15000);
        await poll();

        const t1ProactiveTurns = turnEnds(allMsgs) - t1FirstTurnEnd;
        if (t1ProactiveTurns > 0) {
            console.log(`    -> Proactive drain delivered task result as separate turn (${t1ProactiveTurns} new turn-ends)`);
        } else {
            console.log('    -> No proactive notification. Sending follow-up to trigger drain...');
            await send(cred, session, 'Has the background task completed? What was the result?');
            const ok1b = await waitForCondition(() => turnEnds(allMsgs) > t1FirstTurnEnd, 60_000, 'test1 follow-up');
            if (ok1b) {
                console.log('    -> Follow-up triggered drain, task result delivered');
            } else {
                console.log('    -> WARNING: Follow-up did not produce a new turn. Possible message loss.');
            }
        }
    }

    console.log('\n  TEST 1 COMPLETE');

    // Cleanup test 1 session
    stopPoller();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: session.id });
    await sleep(2000);

    // =========================================================
    // TEST 2: Three background tasks (sleep 20, 40, 60)
    // Fresh session to avoid state carryover
    // =========================================================
    console.log('\n\n--- TEST 2: Three background tasks (sleep 20, 40, 60) ---');

    const session2 = await spawnSession(daemon, cred);
    console.log(`  Session 2: ${session2.id}`);
    const { allMsgs: allMsgs2, violations: violations2, stop: stopPoller2, poll: poll2 } = createPoller(cred, session2);
    await poll2();

    console.log('  Waiting for Claude session 2 to initialize (10s)...');
    await sleep(10000);

    // Alias for test 2
    const allMsgs_t2 = allMsgs2;
    const t2InitTurns = turnEnds(allMsgs_t2);

    await send(cred, session2, 'Please create 3 background tasks using the Bash tool with run_in_background=true: (1) sleep 20, (2) sleep 40, (3) sleep 60. After creating all three, briefly confirm they were started.');

    // Wait for initial response
    const ok2 = await waitForCondition(() => turnEnds(allMsgs_t2) > t2InitTurns, 90_000, 'test2 initial');
    if (!ok2) { console.error('FAIL: No turn-end for test 2 initial'); stopPoller2(); clearTimeout(timer); process.exit(1); }

    const t2AfterInit = turnEnds(allMsgs_t2);
    console.log(`\n  Initial response received (turns=${t2AfterInit})`);

    // Check-in 1: at ~25s (sleep 20 should be done)
    console.log('\n  [Waiting 25s for first task (sleep 20) to complete...]');
    await sleep(25000);
    await poll2();
    const turnsAt25 = turnEnds(allMsgs_t2);
    const proactive25 = turnsAt25 > t2AfterInit;
    console.log(`  @ 25s: turns=${turnsAt25}, new_turns=${turnsAt25 - t2AfterInit}, proactive=${proactive25}`);

    if (!proactive25) {
        console.log('  Sending check-in message...');
        await send(cred, session2, 'Any tasks completed yet? What are their results?');
        await waitForCondition(() => turnEnds(allMsgs_t2) > turnsAt25, 60_000, 'test2 check-in 25s');
    }
    const turnsAfterCheckin1 = turnEnds(allMsgs_t2);
    console.log(`  After check-in 1: turns=${turnsAfterCheckin1}`);

    // Check-in 2: at ~45s from task start (sleep 40 should be done)
    console.log('\n  [Waiting 20s more for second task (sleep 40) to complete...]');
    await sleep(20000);
    await poll2();
    const turnsAt45 = turnEnds(allMsgs_t2);
    const proactive45 = turnsAt45 > turnsAfterCheckin1;
    console.log(`  @ 45s: turns=${turnsAt45}, new_turns=${turnsAt45 - turnsAfterCheckin1}, proactive=${proactive45}`);

    if (!proactive45) {
        console.log('  Sending check-in message...');
        await send(cred, session2, 'How about the second task? Any more completions?');
        await waitForCondition(() => turnEnds(allMsgs_t2) > turnsAt45, 60_000, 'test2 check-in 45s');
    }
    const turnsAfterCheckin2 = turnEnds(allMsgs_t2);
    console.log(`  After check-in 2: turns=${turnsAfterCheckin2}`);

    // Check-in 3: at ~65s from task start (sleep 60 should be done)
    console.log('\n  [Waiting 20s more for third task (sleep 60) to complete...]');
    await sleep(20000);
    await poll2();
    const turnsAt65 = turnEnds(allMsgs_t2);
    const proactive65 = turnsAt65 > turnsAfterCheckin2;
    console.log(`  @ 65s: turns=${turnsAt65}, new_turns=${turnsAt65 - turnsAfterCheckin2}, proactive=${proactive65}`);

    if (!proactive65) {
        console.log('  Sending final check-in message...');
        await send(cred, session2, 'All tasks should be done now. What are the final results?');
        await waitForCondition(() => turnEnds(allMsgs_t2) > turnsAt65, 60_000, 'test2 check-in 65s');
    }
    const turnsAfterCheckin3 = turnEnds(allMsgs_t2);
    console.log(`  After check-in 3: turns=${turnsAfterCheckin3}`);

    // =========================================================
    // RESULTS
    // =========================================================
    const allViolations = [...violations, ...violations2];
    console.log('\n\n========================================');
    console.log('  RESULTS');
    console.log('========================================');
    console.log(`  Test 1 messages: ${allMsgs.length}, turn-ends: ${turnEnds(allMsgs)}`);
    console.log(`  Test 2 messages: ${allMsgs_t2.length}, turn-ends: ${turnEnds(allMsgs_t2)}`);
    console.log(`  PONG/DRAIN violations: ${allViolations.length}`);
    console.log();

    console.log('  Test 1 (single sleep 10):');
    if (t1TaskMentioned) {
        console.log('    Drain behavior: Task result delivered IN SAME TURN (post-ready drain)');
    } else {
        console.log('    Drain behavior: Task result required follow-up message or proactive notification');
    }
    console.log();

    console.log('  Test 2 (sleep 20/40/60):');
    console.log(`    After sleep 20 done:  proactive=${proactive25}`);
    console.log(`    After sleep 40 done:  proactive=${proactive45}`);
    console.log(`    After sleep 60 done:  proactive=${proactive65}`);
    console.log();

    // Cleanup
    stopPoller2();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: session2.id });

    if (allViolations.length > 0) {
        console.log('  FAIL - PONG/DRAIN leaks detected:');
        allViolations.forEach(v => console.error(`    ${v.type}: "${v.text.slice(0, 80)}"`));
        clearTimeout(timer); process.exit(1);
    }

    console.log('  PASS - No PONG/DRAIN leaks');
    console.log('========================================\n');
    clearTimeout(timer); process.exit(0);
}

main().catch(e => { console.error(`\nERROR: ${e.message}`); process.exit(1); });
