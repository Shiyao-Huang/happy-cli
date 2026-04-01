import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://aha-agi.test',
  },
}));

import axios from 'axios';
import { bootstrapRecoveryMaterial, getRecoveryMaterialSecret } from './recoveryBootstrap';

describe('getRecoveryMaterialSecret', () => {
  it('returns the canonical seed for legacy credentials', () => {
    const secret = new Uint8Array([1, 2, 3]);
    expect(getRecoveryMaterialSecret({
      token: 'token-1',
      encryption: { type: 'legacy', secret },
    })).toBe(secret);
  });

  it('returns the canonical seed for contentSecretKey credentials', () => {
    const contentSecretKey = new Uint8Array([4, 5, 6]);
    expect(getRecoveryMaterialSecret({
      token: 'token-2',
      encryption: { type: 'contentSecretKey', contentSecretKey },
    })).toBe(contentSecretKey);
  });

  it('returns null for dataKey credentials', () => {
    expect(getRecoveryMaterialSecret({
      token: 'token-3',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array([7, 8, 9]),
        machineKey: new Uint8Array([10, 11, 12]),
      },
    })).toBeNull();
  });
});

describe('bootstrapRecoveryMaterial', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('posts the canonical seed to the authenticated recovery endpoint', async () => {
    const secret = new Uint8Array([1, 2, 3]);

    await bootstrapRecoveryMaterial('token-123', secret);

    expect(vi.mocked(axios.post)).toHaveBeenCalledWith(
      'https://aha-agi.test/v1/account/recovery-material',
      {
        contentSecretKey: 'AQID',
      },
      {
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        },
      }
    );
  });
});
