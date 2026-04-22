/**
 * Recovery material contract.
 *
 * Both Kanban and CLI must use the same encryption scheme.
 * Platform adapters choose the concrete crypto library
 * (libsodium on React Native, tweetnacl on Node.js).
 */

export interface RecoveryKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface EncryptedSecretPayload {
  encryptedContentSecretKey: string;
  nonce: string;
  ephemeralPublicKey: string;
}

export interface PlainSecretPayload {
  contentSecretKey: string;
}

export function buildRecoveryMaterialPayload(
  contentSecretKey: Uint8Array,
  wrappingPublicKey: Uint8Array | null,
  opts: {
    encryptFn: (params: { plaintext: Uint8Array; nonce: Uint8Array; publicKey: Uint8Array; secretKey: Uint8Array }) => Uint8Array;
    randomBytesFn: (length: number) => Uint8Array;
    keyPairFn: () => RecoveryKeyPair;
  }
): EncryptedSecretPayload | PlainSecretPayload {
  if (!wrappingPublicKey) {
    return { contentSecretKey: encodeBase64(contentSecretKey) };
  }

  const ephemeral = opts.keyPairFn();
  const nonce = opts.randomBytesFn(24);
  const ciphertext = opts.encryptFn({
    plaintext: contentSecretKey,
    nonce,
    publicKey: wrappingPublicKey,
    secretKey: ephemeral.secretKey,
  });

  return {
    encryptedContentSecretKey: encodeBase64(ciphertext),
    nonce: encodeBase64(nonce),
    ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
