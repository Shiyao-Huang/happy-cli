import { describe, expect, it } from 'vitest';

import {
  canonicalContentSecretBoxPrivateKey,
  canonicalContentSecretBoxPublicKey,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
  libsodiumSecretKeyFromSeed,
} from './encryption';

describe('content secret box key compatibility', () => {
  it('uses the canonical Kanban-derived box key for new contentSecretKey wrappers', () => {
    const contentSecretKey = new Uint8Array(Array.from({ length: 32 }, (_value, index) => index + 1));
    const payload = new Uint8Array([9, 8, 7, 6]);

    const canonicalPublicKey = canonicalContentSecretBoxPublicKey(contentSecretKey);
    const canonicalPrivateKey = canonicalContentSecretBoxPrivateKey(contentSecretKey);
    const legacyPrivateKey = libsodiumSecretKeyFromSeed(contentSecretKey);

    const encrypted = libsodiumEncryptForPublicKey(payload, canonicalPublicKey);

    expect(libsodiumDecryptWithSecretKey(encrypted, canonicalPrivateKey)).toEqual(payload);
    expect(libsodiumDecryptWithSecretKey(encrypted, legacyPrivateKey)).toBeNull();
  });

  it('keeps a legacy fallback for contentSecretKey wrappers produced by older CLI builds', () => {
    const contentSecretKey = new Uint8Array(Array.from({ length: 32 }, (_value, index) => 32 - index));
    const payload = new Uint8Array([1, 3, 3, 7]);

    const legacyPublicKey = libsodiumPublicKeyFromSecretKey(contentSecretKey);
    const legacyPrivateKey = libsodiumSecretKeyFromSeed(contentSecretKey);
    const canonicalPrivateKey = canonicalContentSecretBoxPrivateKey(contentSecretKey);

    const encrypted = libsodiumEncryptForPublicKey(payload, legacyPublicKey);

    expect(libsodiumDecryptWithSecretKey(encrypted, legacyPrivateKey)).toEqual(payload);
    expect(libsodiumDecryptWithSecretKey(encrypted, canonicalPrivateKey)).toBeNull();
  });
});
