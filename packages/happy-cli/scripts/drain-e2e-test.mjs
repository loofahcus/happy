#!/usr/bin/env node
/**
 * Drain E2E Test - spawns a session through the daemon's local API,
 * then connects as a webapp client to verify PONG/DRAIN messages never leak.
 *
 * Usage:  node scripts/drain-e2e-test.mjs
 * Prereq: daemon must be running (happy daemon start)
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { io } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

const HAPPY_HOME = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const TEST_TIMEOUT_MS = 180_000;

// -- Encryption (mirrors src/api/encryption.ts) --
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

// -- Daemon local API --
async function daemonPost(port, path, body) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json();
}

// -- Spawn session and derive key --
async function spawnSession(daemon, cred) {
    const serverUrl = process.env.HAPPY_SERVER_URL || 'https://api.cluster-fluster.com';
    const sp = await daemonPost(daemon.httpPort, '/spawn-session', { directory: process.cwd() });
    if (!sp.success) throw new Error(`Spawn failed: ${JSON.stringify(sp)}`);
    console.log(`  Session spawned: ${sp.sessionId}`);

    const r = await fetch(`${serverUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${cred.token}` }
    });
    if (!r.ok) throw new Error(`Fetch sessions list failed: ${r.status}`);
    const allSessions = (await r.json()).sessions || [];
    const sess = allSessions.find(s => s.id === sp.sessionId);
    if (!sess) throw new Error(`Session ${sp.sessionId} not found in sessions list`);

    let key, variant;
    if (sess.dataEncryptionKey && cred.type === 'dataKey') {
        const bundle = dec64(sess.dataEncryptionKey);
        const raw = bundle.slice(1); // skip version byte
        key = tweetnacl.box.open(raw.slice(56), raw.slice(32, 56), raw.slice(0, 32), cred.machineKey);
        if (!key) throw new Error('Failed to decrypt session key');
        variant = 'dataKey';
    } else {
        key = cred.secret; variant = 'legacy';
    }
    return { id: sp.sessionId, key, variant, seq: sess.seq, serverUrl };
}

// -- Socket --
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

// -- Send --
async function send(cred, session, text) {
    const content = { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web', permissionMode: 'default' } };
    const r = await fetch(`${session.serverUrl}/v3/sessions/${encodeURIComponent(session.id)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cred.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ localId: randomUUID(), content: enc64(enc(session.key, session.variant, content)) }] }),
    });
    if (!r.ok) throw new Error(`Send failed: ${r.status}`);
    console.log(`  -> "${text}"`);
}

// -- Poll for messages (server doesn't push new-message to user-scoped sockets) --
function createPoller(cred, session) {
    const msgs = [], violations = [];
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
                msgs.push(body);
                const ev = body?.content?.ev;
                if (ev?.t === 'text' && typeof ev.text === 'string') {
                    if (ev.text.trim() === 'PONG') {
                        violations.push({ type: 'PONG', text: ev.text });
                        console.error(`  ** PONG LEAK: "${ev.text}"`);
                    }
                    if (/\[SYSTEM: Internal keepalive ping/.test(ev.text)) {
                        violations.push({ type: 'DRAIN', text: ev.text });
                        console.error(`  ** DRAIN LEAK`);
                    }
                    if (body.content?.role === 'agent') console.log(`  <- "${ev.text.slice(0, 90)}${ev.text.length > 90 ? '...' : ''}"`);
                }
                if (ev?.t === 'tool-call-start') console.log(`  <- [tool] ${ev.name}`);
                if (ev?.t === 'turn-end') console.log(`  <- [turn-end: ${ev.status}]`);
            } catch {}
        }
    }

    // Start polling every 2 seconds
    const iv = setInterval(poll, 2000);
    const stop = () => clearInterval(iv);
    return { msgs, violations, stop, poll };
}

function waitFor(fn, ms, label) {
    return new Promise((resolve, reject) => {
        const t0 = Date.now();
        const iv = setInterval(() => {
            if (fn()) { clearInterval(iv); resolve(); }
            else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`Timeout: ${label}`)); }
        }, 500);
    });
}
const turns = (msgs) => msgs.filter(m => m?.content?.ev?.t === 'turn-end' && m.content.ev.status === 'completed').length;

// -- Main --
async function main() {
    const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, TEST_TIMEOUT_MS);
    console.log('\n=== Drain E2E Test ===\n');

    const daemon = loadDaemon();
    const cred = loadCred();
    console.log(`Daemon port: ${daemon.httpPort}, cred: ${cred.type}`);

    const session = await spawnSession(daemon, cred);
    console.log(`Session: ${session.id}, variant: ${session.variant}`);

    const { msgs, violations, stop: stopPoller, poll } = createPoller(cred, session);
    // Do an initial poll
    await poll();

    // Give daemon time to wire up the Claude session
    console.log('Waiting for Claude session to initialize...');
    await new Promise(r => setTimeout(r, 5_000));

    // Test 1: single background task
    console.log('--- Test 1: single bg task (sleep 5) ---');
    await send(cred, session, 'create a single background task: sleep 5');
    // Wait for at least 2 turn-ends: initial response + task notification
    await waitFor(() => turns(msgs) >= 2, 60_000, 'test1');
    console.log('Test 1 done\n');

    // Test 2: three background tasks
    console.log('--- Test 2: three bg tasks (sleep 5, 10, 15) ---');
    const t2 = turns(msgs);
    await send(cred, session, 'create 3 background tasks: sleep 5, sleep 10, sleep 15');
    // Expect: initial response + 3 notification turns = 4 more
    await waitFor(() => turns(msgs) >= t2 + 4, 90_000, 'test2');
    console.log('Test 2 done\n');

    // Cleanup
    stopPoller();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: session.id });

    // Results
    console.log(`=== Results: ${msgs.length} msgs, ${turns(msgs)} turns, ${violations.length} violations ===`);
    if (violations.length > 0) {
        console.error('FAIL - leaks found:');
        violations.forEach(v => console.error(`  ${v.type}: "${v.text.slice(0, 80)}"`));
        clearTimeout(timer); process.exit(1);
    }
    console.log('PASS - no PONG/DRAIN leaks\n');
    clearTimeout(timer); process.exit(0);
}

main().catch(e => { console.error(`ERROR: ${e.message}`); process.exit(1); });
