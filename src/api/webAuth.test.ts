import { describe, expect, it } from 'vitest';

import { generateWebAuthUrl } from './webAuth';

describe('generateWebAuthUrl', () => {
    it('keeps terminal key and server URL in the hash fragment', () => {
        const url = new URL(generateWebAuthUrl(new Uint8Array([1, 2, 3])));
        const hashParams = new URLSearchParams(url.hash.slice(1));

        expect(url.pathname).toMatch(/\/terminal\/connect$/);
        expect(hashParams.get('key')).toBeTruthy();
        expect(hashParams.get('serverUrl')).toBeTruthy();
    });

    it('includes next path and machine id in the hash when provided', () => {
        const url = new URL(generateWebAuthUrl(new Uint8Array([1, 2, 3]), {
            nextPath: '/teams/new',
            machineId: 'machine-123'
        }));
        const hashParams = new URLSearchParams(url.hash.slice(1));

        expect(hashParams.get('next')).toBe('/teams/new');
        expect(hashParams.get('machineId')).toBe('machine-123');
    });
});
