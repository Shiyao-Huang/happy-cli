import { describe, expect, it } from 'vitest';
import {
    isCodexFakeIpAddress,
    shouldEnableCodexNetworkShim,
} from '../codexNetworkProxy';

describe('codexNetworkProxy', () => {
    it('detects fake-ip addresses used by TUN proxy mode', () => {
        expect(isCodexFakeIpAddress('198.18.0.10')).toBe(true);
        expect(isCodexFakeIpAddress('198.19.255.254')).toBe(true);
        expect(isCodexFakeIpAddress('104.18.32.47')).toBe(false);
        expect(isCodexFakeIpAddress('172.64.155.209')).toBe(false);
        expect(isCodexFakeIpAddress('not-an-ip')).toBe(false);
    });

    it('enables the shim only when fake-ip DNS is detected and no explicit proxy is configured', () => {
        expect(shouldEnableCodexNetworkShim({
            env: {},
            resolvedAddresses: ['198.18.0.10'],
        })).toBe(true);

        expect(shouldEnableCodexNetworkShim({
            env: { HTTPS_PROXY: 'http://127.0.0.1:7897' },
            resolvedAddresses: ['198.18.0.10'],
        })).toBe(false);

        expect(shouldEnableCodexNetworkShim({
            env: {},
            resolvedAddresses: ['104.18.32.47'],
        })).toBe(false);
    });

    it('supports force and disable overrides', () => {
        expect(shouldEnableCodexNetworkShim({
            env: { AHA_CODEX_FORCE_NETWORK_SHIM: '1' },
            resolvedAddresses: ['104.18.32.47'],
        })).toBe(true);

        expect(shouldEnableCodexNetworkShim({
            env: {
                AHA_CODEX_DISABLE_NETWORK_SHIM: '1',
                AHA_CODEX_FORCE_NETWORK_SHIM: '1',
            },
            resolvedAddresses: ['198.18.0.10'],
        })).toBe(false);
    });
});
