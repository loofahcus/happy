/**
 * Quota fetcher utility for the internal Floodgate API.
 *
 * Responsibilities:
 * - Fetch spend and budget data from the Floodgate usage API
 * - Choose the personal or project endpoint based on the machine-scoped
 *   Floodgate project token (FLOODGATE_PROJECT_TOKEN). When a token is set we
 *   query the project endpoint and report the project name; otherwise personal.
 * - Authenticate via mTLS using certs stored at ~/.person/
 * - Cache results for 60 seconds (busted when the active token changes)
 * - Return null silently on any error (missing certs, timeout, parse failure)
 */

import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logger } from '@/ui/logger';
import { readFloodgateProjectToken } from '@/utils/floodgateProject';

const FLOODGATE_BASE = 'https://floodgate.g.apple.com/api/usage/v1';
const PERSONAL_URL = `${FLOODGATE_BASE}/personal`;
const PROJECT_URL = `${FLOODGATE_BASE}/project`;
const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 1_000;

export interface QuotaData {
    spend: number;
    budget: number;
    fetchedAt: number;
    /** True when usage was read from a Floodgate project (vs. personal) quota. */
    isProject: boolean;
    /** Human-readable project name when on a project quota. */
    projectName?: string;
}

let cachedResult: QuotaData | null = null;
let cachedAt: number = 0;
let cachedToken: string | null = null;

export async function fetchQuota(): Promise<QuotaData | null> {
    const projectToken = await readFloodgateProjectToken();

    const now = Date.now();
    if (cachedResult !== null && cachedToken === projectToken && now - cachedAt < CACHE_TTL_MS) {
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

        const url = projectToken ? PROJECT_URL : PERSONAL_URL;
        const headers = projectToken ? { 'X-Floodgate-Project-Token': projectToken } : undefined;

        const raw = await new Promise<string>((resolve, reject) => {
            const agent = new https.Agent({ cert, key, ca });

            const req = https.get(url, { agent, timeout: TIMEOUT_MS, headers }, (res) => {
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
            project_name?: string;
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
            isProject: Boolean(projectToken),
            projectName: projectToken ? (parsed?.project_name ?? undefined) : undefined,
        };

        cachedResult = result;
        cachedAt = result.fetchedAt;
        cachedToken = projectToken;
        return result;
    } catch (err) {
        logger.debug('[quota] Fetch failed:', err);
        return null;
    }
}
