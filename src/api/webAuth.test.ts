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

    it('includes mode only when it is explicitly set', () => {
        const createUrl = new URL(generateWebAuthUrl(new Uint8Array([1, 2, 3]), {
            mode: 'create'
        }));
        const reconnectUrl = new URL(generateWebAuthUrl(new Uint8Array([1, 2, 3]), {
            mode: 'reconnect'
        }));
        const autoUrl = new URL(generateWebAuthUrl(new Uint8Array([1, 2, 3]), {
            mode: 'auto'
        }));

        expect(new URLSearchParams(createUrl.hash.slice(1)).get('mode')).toBe('create');
        expect(new URLSearchParams(reconnectUrl.hash.slice(1)).get('mode')).toBe('reconnect');
        expect(new URLSearchParams(autoUrl.hash.slice(1)).get('mode')).toBeNull();
    });
});
