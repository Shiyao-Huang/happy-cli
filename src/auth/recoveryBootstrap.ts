import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from '@/api/encryption';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';

export function getRecoveryMaterialSecret(credentials: Credentials): Uint8Array | null {
  if (credentials.encryption.type === 'legacy') {
    return credentials.encryption.secret;
  }

  if (credentials.encryption.type === 'contentSecretKey') {
    return credentials.encryption.contentSecretKey;
  }

  return null;
}

async function fetchWrappingPublicKey(token: string): Promise<Uint8Array | null> {
  try {
    const response = await axios.get<{ wrappingPublicKey: string }>(
      `${configuration.serverUrl}/v1/auth/wrapping-key`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return decodeBase64(response.data.wrappingPublicKey);
  } catch {
    return null;
  }
}

export async function bootstrapRecoveryMaterial(token: string, contentSecretKey: Uint8Array): Promise<void> {
  const wrappingPublicKey = await fetchWrappingPublicKey(token);

  if (wrappingPublicKey) {
    const ephemeral = tweetnacl.box.keyPair();
    const nonce = tweetnacl.randomBytes(tweetnacl.box.nonceLength);
    const ciphertext = tweetnacl.box(contentSecretKey, nonce, wrappingPublicKey, ephemeral.secretKey);

    await axios.post(
      `${configuration.serverUrl}/v1/account/recovery-material`,
      {
        encryptedContentSecretKey: encodeBase64(ciphertext),
        nonce: encodeBase64(nonce),
        ephemeralPublicKey: encodeBase64(ephemeral.publicKey),
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  } else {
    // Fallback: server does not yet support wrapping-key endpoint
    await axios.post(
      `${configuration.serverUrl}/v1/account/recovery-material`,
      { contentSecretKey: encodeBase64(contentSecretKey) },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}
