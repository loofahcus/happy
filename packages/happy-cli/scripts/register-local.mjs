import tweetnacl from 'tweetnacl';
import { randomBytes } from 'crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SERVER = process.env.HAPPY_SERVER_URL || 'http://localhost:3005';
const HAPPY_HOME = process.env.HAPPY_HOME_DIR || join(homedir(), '.happy');
const ACCESS_KEY_PATH = join(HAPPY_HOME, 'access.key');
const BACKUP_PATH = join(HAPPY_HOME, 'access.key.bak');

// Backup existing credentials before overwriting
if (existsSync(ACCESS_KEY_PATH)) {
    copyFileSync(ACCESS_KEY_PATH, BACKUP_PATH);
    console.log(`Backed up existing credentials to ${BACKUP_PATH}`);
    console.log('  To restore: cp ~/.happy/access.key.bak ~/.happy/access.key');
}

const secret = new Uint8Array(randomBytes(32));
const keypair = tweetnacl.sign.keyPair.fromSeed(secret);
const challenge = new Uint8Array(randomBytes(32));
const signature = tweetnacl.sign.detached(challenge, keypair.secretKey);

const resp = await fetch(SERVER + '/v1/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
        challenge: Buffer.from(challenge).toString('base64'),
        publicKey: Buffer.from(keypair.publicKey).toString('base64'),
        signature: Buffer.from(signature).toString('base64'),
    }),
});
const data = await resp.json();
if (!data.success || !data.token) { console.error('Auth failed:', data); process.exit(1); }
console.log('Auth OK');

// Use legacy encryption (tweetnacl secretbox) to avoid PGlite dataEncryptionKey issues
const cred = {
    token: data.token,
    secret: Buffer.from(secret).toString('base64'),
};
mkdirSync(HAPPY_HOME, { recursive: true });
writeFileSync(ACCESS_KEY_PATH, JSON.stringify(cred, null, 2));
console.log('Test credentials written');
