import axios from 'axios';
import tweetnacl from 'tweetnacl';
import { randomBytes } from 'node:crypto';
import { configuration } from '@/configuration';
import { decodeBase64, encodeBase64 } from './encryption';

const ACCOUNT_JOIN_TICKET_PREFIX = 'aha_join_';

export function isAccountJoinTicket(code: string): boolean {
  return code.startsWith(ACCOUNT_JOIN_TICKET_PREFIX);
}

function generateEphemeralBoxKeyPair() {
  const secret = new Uint8Array(randomBytes(tweetnacl.box.secretKeyLength));
  return tweetnacl.box.keyPair.fromSecretKey(secret);
}

function decryptJoinPayload(encryptedBundle: Uint8Array, recipientSecretKey: Uint8Array): Uint8Array | null {
  const ephemeralPublicKey = encryptedBundle.slice(0, tweetnacl.box.publicKeyLength);
  const nonce = encryptedBundle.slice(
    tweetnacl.box.publicKeyLength,
    tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength,
  );
  const encrypted = encryptedBundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);

  return tweetnacl.box.open(encrypted, nonce, ephemeralPublicKey, recipientSecretKey);
}

export async function redeemAccountJoinTicket(ticket: string): Promise<{
  token: string;
  userId: string;
  secret: Uint8Array;
}> {
  const keypair = generateEphemeralBoxKeyPair();

  const response = await axios.post(`${configuration.serverUrl}/v1/auth/account/join`, {
    ticket,
    publicKey: encodeBase64(keypair.publicKey),
  });

  const encryptedContentSecretKey = decodeBase64(response.data.encryptedContentSecretKey);
  const secret = decryptJoinPayload(encryptedContentSecretKey, keypair.secretKey);
  if (!secret) {
    throw new Error('Failed to decrypt joined account secret');
  }

  return {
    token: response.data.token,
    userId: response.data.userId,
    secret,
  };
}
