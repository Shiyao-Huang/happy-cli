import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/auth', () => ({
  authGetToken: vi.fn()
}));

vi.mock('@/persistence', () => ({
  writeCredentialsLegacy: vi.fn(),
  writeCredentialsContentSecretKey: vi.fn()
}));

import { authGetToken } from '@/api/auth';
import { writeCredentialsContentSecretKey, writeCredentialsLegacy } from '@/persistence';
import { getReconnectSeed, reconnectWithStoredCredentials } from './reconnect';

describe('getReconnectSeed', () => {
  it('returns the legacy secret for legacy credentials', () => {
    const secret = new Uint8Array([1, 2, 3]);
    expect(getReconnectSeed({
      token: 'token-1',
      encryption: { type: 'legacy', secret }
    })).toBe(secret);
  });

  it('returns the content secret key for V2 credentials', () => {
    const contentSecretKey = new Uint8Array([4, 5, 6]);
    expect(getReconnectSeed({
      token: 'token-2',
      encryption: { type: 'contentSecretKey', contentSecretKey }
    })).toBe(contentSecretKey);
  });

  it('returns null for unsupported dataKey credentials', () => {
    expect(getReconnectSeed({
      token: 'token-3',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array([7, 8, 9]),
        machineKey: new Uint8Array([10, 11, 12])
      }
    })).toBeNull();
  });
});

describe('reconnectWithStoredCredentials', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes and persists legacy credentials', async () => {
    const secret = new Uint8Array([1, 2, 3]);
    vi.mocked(authGetToken).mockResolvedValue('fresh-token');

    const result = await reconnectWithStoredCredentials({
      token: 'stale-token',
      encryption: { type: 'legacy', secret }
    });

    expect(authGetToken).toHaveBeenCalledWith(secret, 'reconnect');
    expect(writeCredentialsLegacy).toHaveBeenCalledWith({
      secret,
      token: 'fresh-token'
    });
    expect(result).toEqual({
      token: 'fresh-token',
      encryption: { type: 'legacy', secret }
    });
  });

  it('refreshes and persists contentSecretKey credentials', async () => {
    const contentSecretKey = new Uint8Array([4, 5, 6]);
    vi.mocked(authGetToken).mockResolvedValue('fresh-token');

    const result = await reconnectWithStoredCredentials({
      token: 'stale-token',
      encryption: { type: 'contentSecretKey', contentSecretKey }
    });

    expect(authGetToken).toHaveBeenCalledWith(contentSecretKey, 'reconnect');
    expect(writeCredentialsContentSecretKey).toHaveBeenCalledWith({
      contentSecretKey,
      token: 'fresh-token'
    });
    expect(result).toEqual({
      token: 'fresh-token',
      encryption: { type: 'contentSecretKey', contentSecretKey }
    });
  });

  it('throws for unsupported credential formats', async () => {
    await expect(reconnectWithStoredCredentials({
      token: 'token-3',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array([7, 8, 9]),
        machineKey: new Uint8Array([10, 11, 12])
      }
    })).rejects.toThrow('Current credentials do not support direct reconnect');
  });
});
