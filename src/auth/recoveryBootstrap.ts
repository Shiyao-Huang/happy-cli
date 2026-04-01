import axios from 'axios';
import { encodeBase64 } from '@/api/encryption';
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

export async function bootstrapRecoveryMaterial(token: string, contentSecretKey: Uint8Array): Promise<void> {
  await axios.post(
    `${configuration.serverUrl}/v1/account/recovery-material`,
    {
      contentSecretKey: encodeBase64(contentSecretKey),
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );
}
