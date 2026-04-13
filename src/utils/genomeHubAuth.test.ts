import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ensureGenomeHubWriteToken,
    readCachedGenomeHubTokenSync,
    resolveGenomeHubWriteTokenSync,
} from './genomeHubAuth';

function makeJwt(expSecondsFromNow: number): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        sub: 'user-1',
        exp: Math.floor(Date.now() / 1000) + expSecondsFromNow,
        scope: ['genome:write'],
    })).toString('base64url');
    return `${header}.${payload}.signature`;
}

describe('genomeHubAuth', () => {
    let tempDir: string;
    let cacheFile: string;
    const originalEnvAuthToken = process.env.GENOME_HUB_AUTH_TOKEN;
    const originalPublishKey = process.env.HUB_PUBLISH_KEY;

    beforeEach(() => {
        tempDir = mkdtempSync(join(tmpdir(), 'aha-genome-auth-'));
        cacheFile = join(tempDir, 'genome-hub-token.json');
        delete process.env.GENOME_HUB_AUTH_TOKEN;
        delete process.env.HUB_PUBLISH_KEY;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        rmSync(tempDir, { recursive: true, force: true });
        if (originalEnvAuthToken === undefined) {
            delete process.env.GENOME_HUB_AUTH_TOKEN;
        } else {
            process.env.GENOME_HUB_AUTH_TOKEN = originalEnvAuthToken;
        }
        if (originalPublishKey === undefined) {
            delete process.env.HUB_PUBLISH_KEY;
        } else {
            process.env.HUB_PUBLISH_KEY = originalPublishKey;
        }
    });

    it('prefers a fresh cached genome-token over HUB_PUBLISH_KEY fallback', async () => {
        const cachedToken = makeJwt(3600);
        vi.spyOn(axios, 'post').mockResolvedValue({
            data: {
                token: cachedToken,
            },
        });

        await ensureGenomeHubWriteToken({
            authToken: 'user-auth-token',
            serverUrl: 'https://happy.example.com/api',
            cacheFile,
            forceRefresh: true,
        });

        process.env.HUB_PUBLISH_KEY = 'legacy-static-key';

        expect(resolveGenomeHubWriteTokenSync(undefined, { cacheFile })).toBe(cachedToken);
        expect(readCachedGenomeHubTokenSync({ cacheFile })?.token).toBe(cachedToken);
    });

    it('fetches genome-token from happy-server and writes the cache file', async () => {
        const issuedToken = makeJwt(1800);
        const postSpy = vi.spyOn(axios, 'post').mockResolvedValue({
            data: {
                genomeToken: issuedToken,
            },
        });

        const result = await ensureGenomeHubWriteToken({
            authToken: 'user-auth-token',
            serverUrl: 'https://happy.example.com/api',
            cacheFile,
            forceRefresh: true,
        });

        expect(result).toMatchObject({
            token: issuedToken,
            source: 'server-issued',
        });
        expect(postSpy).toHaveBeenCalledWith(
            'https://happy.example.com/api/v1/genome-token',
            {},
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer user-auth-token',
                }),
            }),
        );
        expect(readCachedGenomeHubTokenSync({ cacheFile })?.token).toBe(issuedToken);
    });

    it('falls back to HUB_PUBLISH_KEY when genome-token fetch fails', async () => {
        process.env.HUB_PUBLISH_KEY = 'legacy-static-key';
        vi.spyOn(axios, 'post').mockRejectedValue(new Error('boom'));

        const result = await ensureGenomeHubWriteToken({
            authToken: 'user-auth-token',
            serverUrl: 'https://happy.example.com/api',
            cacheFile,
            forceRefresh: true,
        });

        expect(result).toEqual({
            token: 'legacy-static-key',
            source: 'env-publish-key',
        });
    });
});
