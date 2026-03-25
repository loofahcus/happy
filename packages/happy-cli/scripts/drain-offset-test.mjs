#!/usr/bin/env node
/**
 * Targeted test: bg task completes, then user sends message.
 * Reproduces the message offset bug where the user's message response
 * is delayed to the next turn.
 */
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID, randomBytes } from 'crypto';
import tweetnacl from 'tweetnacl';

const HAPPY_HOME = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const serverUrl = process.env.HAPPY_SERVER_URL;
const daemon = JSON.parse(readFileSync(join(HAPPY_HOME, 'daemon.state.json'), 'utf8'));
const cred = JSON.parse(readFileSync(join(HAPPY_HOME, 'access.key'), 'utf8'));
const secret = new Uint8Array(Buffer.from(cred.secret, 'base64'));
const token = cred.token;

const enc64 = (b) => Buffer.from(b).toString('base64');
const rnd = (n) => new Uint8Array(randomBytes(n));
function encryptLeg(data, s) {
    const n = rnd(tweetnacl.secretbox.nonceLength);
    const e = tweetnacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), n, s);
    const r = new Uint8Array(n.length + e.length); r.set(n); r.set(e, n.length); return r;
}
function decryptLeg(d, s) {
    const r = tweetnacl.secretbox.open(d.slice(tweetnacl.secretbox.nonceLength), d.slice(0, tweetnacl.secretbox.nonceLength), s);
    return r ? JSON.parse(new TextDecoder().decode(r)) : null;
}

async function daemonPost(port, path, body) {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    return r.json();
}

async function sendMsg(sessionId, text) {
    const content = { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'web', permissionMode: 'default' } };
    await fetch(serverUrl + '/v3/sessions/' + encodeURIComponent(sessionId) + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ localId: randomUUID(), content: enc64(encryptLeg(content, secret)) }] }),
    });
    console.log(`  --> USER: "${text}"`);
}

function createPoller(sessionId) {
    const allMsgs = [];
    let afterSeq = 0;
    async function poll() {
        const r = await fetch(serverUrl + '/v3/sessions/' + encodeURIComponent(sessionId) + '/messages?after_seq=' + afterSeq + '&limit=100',
            { headers: { Authorization: 'Bearer ' + token } });
        if (!r.ok) return;
        const data = await r.json();
        for (const msg of (data.messages || [])) {
            if (msg.seq > afterSeq) afterSeq = msg.seq;
            if (msg.content?.t !== 'encrypted') continue;
            try {
                const body = decryptLeg(new Uint8Array(Buffer.from(msg.content.c, 'base64')), secret);
                if (!body) continue;
                allMsgs.push(body);
                const ev = body?.content?.ev;
                if (ev?.t === 'text' && body.content?.role === 'agent') {
                    const preview = ev.text.slice(0, 120);
                    console.log(`      <-- AGENT: "${preview}${ev.text.length > 120 ? '...' : ''}"`);
                }
                if (ev?.t === 'tool-call-start') console.log(`      <-- [tool-call] ${ev.name}`);
                if (ev?.t === 'turn-end') console.log(`      <-- [turn-end: ${ev.status}]`);
                if (ev?.t === 'text' && typeof ev.text === 'string') {
                    if (ev.text.trim() === 'PONG') console.error(`      !! PONG LEAK`);
                    if (/Internal keepalive ping/.test(ev.text)) console.error(`      !! DRAIN LEAK`);
                }
            } catch {}
        }
    }
    const iv = setInterval(poll, 2000);
    return { allMsgs, stop: () => clearInterval(iv), poll };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const turnEnds = (msgs) => msgs.filter(m => m?.content?.ev?.t === 'turn-end').length;
const completedTurns = (msgs) => msgs.filter(m => m?.content?.ev?.t === 'turn-end' && m.content.ev.status === 'completed').length;

async function waitFor(fn, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(1000); }
    return false;
}

async function main() {
    const timer = setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 180_000);

    console.log('\n=== Message Offset Bug Reproduction ===\n');

    const sp = await daemonPost(daemon.httpPort, '/spawn-session', {
        directory: process.cwd(),
        environmentVariables: { APPLE_CLAUDE_CODE_PORT: '0' }
    });
    if (!sp.success) { console.error('Spawn failed:', sp); process.exit(1); }
    console.log('Session:', sp.sessionId);

    const { allMsgs, stop, poll } = createPoller(sp.sessionId);
    await sleep(10000);
    console.log('Session initialized.\n');

    // Step 1: Create background task
    await sendMsg(sp.sessionId, 'Create a background task: sleep 10 (use Bash with run_in_background=true). Just confirm it started.');
    console.log('  [Waiting for turn-end...]');
    await waitFor(() => completedTurns(allMsgs) >= 1, 60000);
    console.log(`  Turn 1 done (turns=${completedTurns(allMsgs)})\n`);

    // Step 2: Wait for the task to complete (sleep 10 + buffer)
    console.log('  [Waiting 15s for bg task to complete...]');
    await sleep(15000);

    // Step 3: Send follow-up message AFTER task completed
    const turnsBefore = completedTurns(allMsgs);
    await sendMsg(sp.sessionId, 'thanks! the task should be done now right?');

    console.log('  [Waiting for response to follow-up...]');
    await waitFor(() => completedTurns(allMsgs) > turnsBefore, 60000);
    await poll();

    const turnsAfter = completedTurns(allMsgs);
    console.log(`\n  Turns after follow-up: ${turnsAfter} (was ${turnsBefore})`);

    // Check: did the follow-up get a proper response in the SAME turn?
    // Look for agent text containing "welcome" or "yes" or "done" or "right"
    // (response to "thanks! the task should be done now right?")
    const agentTexts = allMsgs
        .filter(m => m?.content?.role === 'agent' && m?.content?.ev?.t === 'text')
        .map(m => m.content.ev.text);

    const hasNotification = agentTexts.some(t => /complet|exit.*0|finished/i.test(t));
    const hasFollowUpResponse = agentTexts.some(t => /welcome|yes|right|done|sure|happy|help/i.test(t));

    console.log(`  Has notification content: ${hasNotification}`);
    console.log(`  Has follow-up response: ${hasFollowUpResponse}`);

    if (turnsAfter - turnsBefore === 1 && hasFollowUpResponse) {
        console.log('\n  PASS: Follow-up response in same turn as notification');
    } else if (turnsAfter - turnsBefore >= 2) {
        console.log('\n  INFO: Notification and follow-up in separate turns (acceptable)');
    } else {
        console.log('\n  FAIL: Follow-up response missing or delayed');
    }

    // Step 4: Send one more message to check if we're in sync
    const turnsBeforeSync = completedTurns(allMsgs);
    await sendMsg(sp.sessionId, 'just say "sync check OK"');
    console.log('  [Waiting for sync check response...]');
    await waitFor(() => completedTurns(allMsgs) > turnsBeforeSync, 60000);
    await poll();

    const syncTexts = allMsgs
        .filter(m => m?.content?.role === 'agent' && m?.content?.ev?.t === 'text')
        .map(m => m.content.ev.text);
    const hasSyncResponse = syncTexts.some(t => /sync check OK/i.test(t));
    console.log(`  Sync check response found: ${hasSyncResponse}`);

    if (hasSyncResponse) {
        console.log('\n  PASS: Messages are in sync');
    } else {
        console.log('\n  FAIL: Messages still offset');
    }

    stop();
    await daemonPost(daemon.httpPort, '/stop-session', { sessionId: sp.sessionId });
    clearTimeout(timer);
    process.exit(0);
}

main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
