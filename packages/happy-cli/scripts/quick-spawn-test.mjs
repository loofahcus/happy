#!/usr/bin/env node
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

async function sendMsg(sessionId, text) {
    const content = { role:'user', content:{type:'text',text}, meta:{sentFrom:'web',permissionMode:'default'} };
    await fetch(serverUrl+'/v3/sessions/'+encodeURIComponent(sessionId)+'/messages', {
        method:'POST', headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
        body:JSON.stringify({messages:[{localId:randomUUID(),content:enc64(encryptLeg(content,secret))}]})
    });
    console.log(`  -> sent: "${text}"`);
}

const sp = await (await fetch('http://127.0.0.1:'+daemon.httpPort+'/spawn-session', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        directory:process.cwd(),
        environmentVariables: { APPLE_CLAUDE_CODE_PORT: '0' }
    })
})).json();
console.log('Spawned:', sp.sessionId);
if (!sp.success) process.exit(1);

await new Promise(r=>setTimeout(r, 10000));

// Message 1
await sendMsg(sp.sessionId, 'say hello briefly');
console.log('  Waiting 20s for response...');
await new Promise(r=>setTimeout(r, 20000));

// Message 2 (rapid follow-up)
await sendMsg(sp.sessionId, 'say goodbye briefly');
console.log('  Waiting 20s for response...');
await new Promise(r=>setTimeout(r, 20000));

console.log('Done. Check logs.');
process.exit(0);
