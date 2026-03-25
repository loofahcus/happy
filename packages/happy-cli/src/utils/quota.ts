/**
 * Quota fetcher utility for the internal Floodgate API.
 *
 * Responsibilities:
 * - Fetch spend and budget data from the Floodgate personal usage API
 * - Authenticate via mTLS using certs stored at ~/.person/
 * - Cache results for 60 seconds to avoid hammering the API
 * - Return null silently on any error (missing certs, timeout, parse failure)
 */

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '@/ui/logger';

const FLOODGATE_URL = 'https://floodgate.g.apple.com/api/usage/v1/personal';
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 1_000;

export interface QuotaData {
    spend: number;
    budget: number;
    fetchedAt: number;
}

let cachedResult: QuotaData | null = null;
let cachedAt: number = 0;

export async function fetchQuota(): Promise<QuotaData | null> {
    const now = Date.now();
    if (cachedResult !== null && now - cachedAt < CACHE_TTL_MS) {
        return cachedResult;
    }

    try {
        const personDir = path.join(os.homedir(), '.person');
        const certPath = path.join(personDir, 'cert.pem');
        const keyPath = path.join(personDir, 'private.pem');
        const caPath = path.join(personDir, 'ca-certificates.crt');

        if (!fs.existsSync(certPath) || !fs.existsSync(keyPath) || !fs.existsSync(caPath)) {
            logger.debug('[quota] mTLS cert files not found, skipping fetch');
            return null;
        }

        const cert = fs.readFileSync(certPath);
        const key = fs.readFileSync(keyPath);
        const ca = fs.readFileSync(caPath);

        const raw = await new Promise<string>((resolve, reject) => {
            const agent = new https.Agent({ cert, key, ca });

            const req = https.get(FLOODGATE_URL, { agent, timeout: TIMEOUT_MS }, (res) => {
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                res.on('end', () => { clearTimeout(connectTimer); resolve(body); });
                res.on('error', reject);
            });

            const connectTimer = setTimeout(() => {
                req.destroy(new Error('connect timeout'));
            }, CONNECT_TIMEOUT_MS);

            req.on('socket', (socket) => {
                socket.on('connect', () => clearTimeout(connectTimer));
            });

            req.on('timeout', () => {
                req.destroy(new Error('request timeout'));
            });

            req.on('error', (err) => {
                clearTimeout(connectTimer);
                reject(err);
            });
        });

        const parsed = JSON.parse(raw) as {
            usage?: { spend?: number };
            quota?: { budget?: { spend?: number } };
        };

        const spend = parsed?.usage?.spend;
        const budget = parsed?.quota?.budget?.spend;

        if (typeof spend !== 'number' || typeof budget !== 'number' || budget === 0) {
            logger.debug('[quota] Unexpected response shape, skipping');
            return null;
        }

        const result: QuotaData = {
            spend,
            budget,
            fetchedAt: Date.now(),
        };

        cachedResult = result;
        cachedAt = result.fetchedAt;
        return result;
    } catch (err) {
        logger.debug('[quota] Fetch failed:', err);
        return null;
    }
}
