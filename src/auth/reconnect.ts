import { authGetToken } from '@/api/auth';
import axios from 'axios';
import {
  Credentials,
  writeCredentialsContentSecretKey,
  writeCredentialsLegacy,
} from '@/persistence';

export function getReconnectSeed(credentials: Credentials): Uint8Array | null {
  if (credentials.encryption.type === 'legacy') {
    return credentials.encryption.secret;
  }

  if (credentials.encryption.type === 'contentSecretKey') {
    return credentials.encryption.contentSecretKey;
  }

  return null;
}

export async function persistCredentials(credentials: Credentials): Promise<void> {
  if (credentials.encryption.type === 'legacy') {
    await writeCredentialsLegacy({
      secret: credentials.encryption.secret,
      token: credentials.token
    });
    return;
  }

  if (credentials.encryption.type === 'contentSecretKey') {
    await writeCredentialsContentSecretKey({
      contentSecretKey: credentials.encryption.contentSecretKey,
      token: credentials.token
    });
    return;
  }

  throw new Error('Current credentials format cannot be persisted for reconnect');
}

export async function reconnectWithStoredCredentials(existingCredentials: Credentials): Promise<Credentials> {
  const reconnectSeed = getReconnectSeed(existingCredentials);
  if (!reconnectSeed) {
    throw new Error('Current credentials do not support direct reconnect. Use browser restore instead.');
  }

  let token: string;
  try {
    token = await authGetToken(reconnectSeed, 'reconnect');
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const serverError = typeof error.response?.data?.error === 'string'
        ? error.response?.data?.error
        : null;
      if (serverError) {
        throw new Error(serverError);
      }
      if (error.response?.status === 404) {
        throw new Error('Account not found on the current server for this local reconnect key.');
      }
    }
    throw error;
  }

  const refreshedCredentials: Credentials = {
    ...existingCredentials,
    token
  };

  await persistCredentials(refreshedCredentials);
  return refreshedCredentials;
}
