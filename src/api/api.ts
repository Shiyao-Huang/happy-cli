import { DEFAULT_GENOME_HUB_URL } from '@/configurationResolver'
import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState, Artifact } from '@/api/types'
import type { LegionImage, LegionMemberOverlay } from '@/api/types/genome'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import {
  canonicalContentSecretBoxPrivateKey,
  canonicalContentSecretBoxPublicKey,
  decodeBase64,
  encodeBase64,
  getRandomBytes,
  encrypt,
  decrypt,
  libsodiumDecryptWithSecretKey,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
  libsodiumSecretKeyFromSeed,
} from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';
import { buildMarketplaceConnectionHint, buildMarketplacePublishAuthHint } from '@/utils/marketplaceConnection';

export class ApiClient {

  static async create(credential: Credentials) {
    return new ApiClient(credential);
  }

  private readonly credential: Credentials;
  private readonly pushClient: PushNotificationClient;

  private constructor(credential: Credentials) {
    this.credential = credential
    this.pushClient = new PushNotificationClient(credential.token, configuration.serverUrl)
  }

  private normalizeTeamArtifactBody(body: any): string {
    if (body && typeof body === 'object' && 'body' in body) {
      const inner = (body as { body?: unknown }).body;
      if (typeof inner === 'string') {
        return JSON.stringify(body);
      }
      return JSON.stringify({ ...(body as Record<string, unknown>), body: JSON.stringify(inner ?? null) });
    }
    if (typeof body === 'string') {
      return JSON.stringify({ body });
    }
    return JSON.stringify({ body: JSON.stringify(body ?? null) });
  }

  private unwrapDataEncryptionKey(encodedKey: string): Uint8Array | null {
    const decoded = decodeBase64(encodedKey);
    if (decoded.length === 0) {
      return null;
    }

    if (decoded[0] === 0) {
      if (this.credential.encryption.type === 'contentSecretKey') {
        const encryptedKey = decoded.slice(1);
        const canonicalSecretKey = canonicalContentSecretBoxPrivateKey(this.credential.encryption.contentSecretKey);
        const canonicalDecrypted = libsodiumDecryptWithSecretKey(encryptedKey, canonicalSecretKey);
        if (canonicalDecrypted) {
          return canonicalDecrypted;
        }

        // Compatibility fallback for data keys wrapped by older CLI builds
        const legacySecretKey = libsodiumSecretKeyFromSeed(this.credential.encryption.contentSecretKey);
        return libsodiumDecryptWithSecretKey(encryptedKey, legacySecretKey);
      }
      if (this.credential.encryption.type === 'dataKey') {
        const secretKey = libsodiumSecretKeyFromSeed(this.credential.encryption.machineKey);
        return libsodiumDecryptWithSecretKey(decoded.slice(1), secretKey);
      }
      return null;
    }

    if (this.credential.encryption.type === 'legacy') {
      const decrypted = decrypt(this.credential.encryption.secret, 'legacy', decoded);
      if (!decrypted) {
        return null;
      }
      if (decrypted instanceof Uint8Array) {
        return decrypted;
      }
      if (Array.isArray(decrypted)) {
        return new Uint8Array(decrypted);
      }
      if (typeof decrypted === 'string') {
        return new TextEncoder().encode(decrypted);
      }
    }

    return null;
  }

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
    sessionId?: string,
    tag: string,
    metadata: Metadata,
    state: AgentState | null
  }): Promise<Session> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';

    if (this.credential.encryption.type === 'contentSecretKey') {
      // New unified approach: use contentSecretKey for encryption (same as Kanban)
      // Generate random data encryption key for this session
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      // Encrypt the data encryption key using box encryption with contentSecretKey
      // This matches how Kanban encrypts data: derive keypair from contentSecretKey
      const publicKey = canonicalContentSecretBoxPublicKey(this.credential.encryption.contentSecretKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Encrypted data key
    } else if (this.credential.encryption.type === 'dataKey') {
      // Legacy dataKey mode (publicKey + machineKey)
      encryptionKey = getRandomBytes(32);
      encryptionVariant = 'dataKey';

      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy mode
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    const encodedDataEncryptionKey = dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null;

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          sessionId: opts.sessionId,
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: encodedDataEncryptionKey,
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000 // 1 minute timeout for very bad network connections
        }
      )

      logger.debug(`Session created/loaded: ${response.data.session.id} (tag: ${opts.tag})`)
      const raw = response.data.session;
      let resolvedEncryptionKey = encryptionKey;
      let resolvedVariant = encryptionVariant;

      if (raw.dataEncryptionKey) {
        const matchesSent = encodedDataEncryptionKey && raw.dataEncryptionKey === encodedDataEncryptionKey;
        if (!matchesSent) {
          const unwrappedKey = this.unwrapDataEncryptionKey(raw.dataEncryptionKey);
          if (!unwrappedKey) {
            throw new Error('Failed to decrypt session data encryption key');
          }
          resolvedEncryptionKey = unwrappedKey;
          resolvedVariant = 'dataKey';
        }
      }

      const session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(resolvedEncryptionKey, resolvedVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(resolvedEncryptionKey, resolvedVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: resolvedEncryptionKey,
        encryptionVariant: resolvedVariant
      }
      return session;
    } catch (error) {
      logger.debug('[API] [ERROR] Failed to get or create session:', error);
      throw new Error(`Failed to get or create session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register or update machine with the server
   * Returns the current machine state from the server with decrypted metadata and daemonState
   */
  async getOrCreateMachine(opts: {
    machineId: string,
    metadata: MachineMetadata,
    daemonState?: DaemonState,
  }): Promise<Machine> {

    // Resolve encryption key
    let dataEncryptionKey: Uint8Array | null = null;
    let encryptionKey: Uint8Array;
    let encryptionVariant: 'legacy' | 'dataKey';

    if (this.credential.encryption.type === 'contentSecretKey') {
      encryptionVariant = 'dataKey';
      encryptionKey = getRandomBytes(32);

      const publicKey = canonicalContentSecretBoxPublicKey(this.credential.encryption.contentSecretKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Encrypted data key
    } else if (this.credential.encryption.type === 'dataKey') {
      encryptionVariant = 'dataKey';
      encryptionKey = getRandomBytes(32);

      let encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy encryption
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    const encodedDataEncryptionKey = dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined;

    // Preserve optional metadata fields (for example a user-assigned displayName)
    // that were previously stored for this machine.
    let metadataToPersist: MachineMetadata = opts.metadata;
    try {
      const existingResponse = await axios.get(`${configuration.serverUrl}/v1/machines/${opts.machineId}`, {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
        },
        validateStatus: (status) => status === 200 || status === 404,
      });

      if (existingResponse.status === 200 && existingResponse.data?.machine) {
        const existingRaw = existingResponse.data.machine;
        let existingEncryptionKey = encryptionKey;
        let existingEncryptionVariant = encryptionVariant;

        if (existingRaw.dataEncryptionKey) {
          const unwrappedKey = this.unwrapDataEncryptionKey(existingRaw.dataEncryptionKey);
          if (unwrappedKey) {
            existingEncryptionKey = unwrappedKey;
            existingEncryptionVariant = 'dataKey';
          }
        }

        const existingMetadata = existingRaw.metadata
          ? decrypt(existingEncryptionKey, existingEncryptionVariant, decodeBase64(existingRaw.metadata))
          : null;

        if (existingMetadata && typeof existingMetadata === 'object') {
          metadataToPersist = {
            ...(existingMetadata as MachineMetadata),
            ...opts.metadata,
          };
        }
      }
    } catch (error) {
      logger.debug('[API] Failed to load existing machine metadata before registration:', error);
    }

    // Create machine
    const response = await axios.post(
      `${configuration.serverUrl}/v1/machines`,
      {
        id: opts.machineId,
        metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, metadataToPersist)),
        daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
        dataEncryptionKey: encodedDataEncryptionKey
      },
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000 // 1 minute timeout for very bad network connections
      }
    );

    if (response.status !== 200) {
      console.error(chalk.red(`[API] Failed to create machine: ${response.statusText}`));
      console.log(chalk.yellow(`[API] Failed to create machine: ${response.statusText}, most likely you have re-authenticated, but you still have a machine associated with the old account. Now we are trying to re-associate the machine with the new account. That is not allowed. Please run 'aha doctor clean' to clean up your aha state, and try your original command again. Please create an issue on github if this is causing you problems. We apologize for the inconvenience.`));
      process.exit(1);
    }

    const raw = response.data.machine;
    let resolvedEncryptionKey = encryptionKey;
    let resolvedVariant = encryptionVariant;

    if (raw.dataEncryptionKey) {
      const matchesSent = encodedDataEncryptionKey && raw.dataEncryptionKey === encodedDataEncryptionKey;
      if (!matchesSent) {
        const unwrappedKey = this.unwrapDataEncryptionKey(raw.dataEncryptionKey);
        if (!unwrappedKey) {
          throw new Error('Failed to decrypt machine data encryption key');
        }
        resolvedEncryptionKey = unwrappedKey;
        resolvedVariant = 'dataKey';
      }
    }
    logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

    // Return decrypted machine like we do for sessions
    const machine: Machine = {
      id: raw.id,
      encryptionKey: resolvedEncryptionKey,
      encryptionVariant: resolvedVariant,
      metadata: raw.metadata ? decrypt(resolvedEncryptionKey, resolvedVariant, decodeBase64(raw.metadata)) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decrypt(resolvedEncryptionKey, resolvedVariant, decodeBase64(raw.daemonState)) : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
    };
    return machine;
  }

  sessionSyncClient(session: Session): ApiSessionClient {
    return new ApiSessionClient(this.credential.token, session);
  }

  machineSyncClient(machine: Machine): ApiMachineClient {
    return new ApiMachineClient(this.credential.token, machine);
  }

  push(): PushNotificationClient {
    return this.pushClient;
  }

  private getDefaultEncryptionContext(): { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' } {
    if (this.credential.encryption.type === 'contentSecretKey') {
      return {
        encryptionKey: this.credential.encryption.contentSecretKey,
        encryptionVariant: 'dataKey',
      };
    }
    if (this.credential.encryption.type === 'dataKey') {
      return {
        encryptionKey: this.credential.encryption.machineKey,
        encryptionVariant: 'dataKey',
      };
    }
    return {
      encryptionKey: this.credential.encryption.secret,
      encryptionVariant: 'legacy',
    };
  }

  private resolveSessionEncryptionContext(dataEncryptionKey?: string | null): { encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' } | null {
    if (!dataEncryptionKey) {
      return this.getDefaultEncryptionContext();
    }

    const decryptedKey = this.unwrapDataEncryptionKey(dataEncryptionKey);
    if (!decryptedKey) {
      return null;
    }

    return {
      encryptionKey: decryptedKey,
      encryptionVariant: 'dataKey',
    };
  }

  private decodeStoredSession(raw: any): any {
    const baseSession = {
      id: raw.id,
      seq: raw.seq,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      active: !!raw.active,
      activeAt: raw.activeAt,
      persistedMessageCount: raw.persistedMessageCount ?? 0,
      metadata: null,
      metadataVersion: raw.metadataVersion ?? 0,
      agentState: null,
      agentStateVersion: raw.agentStateVersion ?? 0,
      isDecrypted: false,
    };

    const encryptionContext = this.resolveSessionEncryptionContext(raw.dataEncryptionKey);
    if (!encryptionContext) {
      logger.debug(`[API] Failed to resolve session encryption key for ${raw.id}`);
      return baseSession;
    }

    try {
      return {
        ...baseSession,
        encryptionKey: encryptionContext.encryptionKey,
        encryptionVariant: encryptionContext.encryptionVariant,
        metadata: raw.metadata ? decrypt(encryptionContext.encryptionKey, encryptionContext.encryptionVariant, decodeBase64(raw.metadata)) : null,
        agentState: raw.agentState ? decrypt(encryptionContext.encryptionKey, encryptionContext.encryptionVariant, decodeBase64(raw.agentState)) : null,
        isDecrypted: true,
      };
    } catch (error) {
      logger.debug(`[API] Failed to decode stored session ${raw.id}:`, error);
      return baseSession;
    }
  }

  async listSessions(): Promise<{ sessions: any[] }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/sessions`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );

      const sessions = Array.isArray(response.data?.sessions)
        ? response.data.sessions.map((raw: any) => this.decodeStoredSession(raw))
        : [];

      logger.debug(`[API] Listed ${sessions.length} sessions`);
      return { sessions };
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list sessions:`, error);
      throw new Error(`Failed to list sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getSession(sessionId: string): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/sessions/${sessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 404
        }
      );

      if (response.status === 404) {
        return null;
      }

      return this.decodeStoredSession(response.data.session);
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get session ${sessionId}:`, error);
      throw new Error(`Failed to get session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateSessionMetadata(sessionId: string, metadata: Metadata, expectedVersion?: number): Promise<{ success: boolean; session: any }> {
    const existing = await this.getSession(sessionId);

    if (!existing) {
      throw new Error('Session not found');
    }

    if (!existing.isDecrypted || !existing.encryptionKey || !existing.encryptionVariant) {
      throw new Error('Session metadata could not be decrypted; refusing to overwrite opaque data.');
    }

    try {
      const encodedMetadata = encodeBase64(encrypt(existing.encryptionKey, existing.encryptionVariant, metadata));

      await axios.post(
        `${configuration.serverUrl}/v1/sessions/${sessionId}/metadata`,
        {
          metadata: encodedMetadata,
          expectedVersion: expectedVersion ?? existing.metadataVersion
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      logger.debug(`[API] Updated metadata for session ${sessionId}`);
      return {
        success: true,
        session: {
          ...existing,
          metadata,
          metadataVersion: (expectedVersion ?? existing.metadataVersion) + 1,
          updatedAt: Date.now(),
        }
      };
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to update metadata for session ${sessionId}:`, error);
      throw new Error(`Failed to update session metadata: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async deleteSession(sessionId: string): Promise<{ success: boolean }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/sessions/${sessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 30000,
          validateStatus: (status) => status === 200 || status === 404
        }
      );

      if (response.status === 404) {
        throw new Error('Session not found');
      }

      logger.debug(`[API] Deleted session ${sessionId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to delete session ${sessionId}:`, error);
      throw new Error(`Failed to delete session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register a vendor API token with the server
   * The token is sent as a JSON string - server handles encryption
   */
  async registerVendorToken(vendor: 'openai' | 'anthropic' | 'gemini', apiKey: any): Promise<void> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/connect/${vendor}/register`,
        {
          token: JSON.stringify(apiKey)
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000
        }
      );

      if (response.status !== 200 && response.status !== 201) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} registered successfully`);
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to register vendor token:`, error);
      throw new Error(`Failed to register vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a stored vendor token from the server.
   * Returns parsed JSON when the token was stored as JSON, otherwise the raw value.
   */
  async getVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/${vendor}/token`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 5000,
          validateStatus: (status) => status === 200 || status === 404
        }
      );

      if (response.status === 404 || response.data?.token == null) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      const rawToken = response.data?.token;
      if (typeof rawToken !== 'string') {
        return rawToken ?? null;
      }

      try {
        return JSON.parse(rawToken);
      } catch {
        return rawToken;
      }
    } catch (error: any) {
      if (error.response?.status === 404) {
        logger.debug(`[API] No vendor token found for ${vendor}`);
        return null;
      }
      logger.debug(`[API] [ERROR] Failed to get vendor token for ${vendor}:`, error);
      return null;
    }
  }

  /**
   * Remove a stored vendor API token from the server.
   */
  async removeVendorToken(vendor: 'openai' | 'anthropic' | 'gemini'): Promise<void> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/connect/${vendor}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 5000
        }
      );

      if (response.status !== 200) {
        throw new Error(`Server returned status ${response.status}`);
      }

      logger.debug(`[API] Vendor token for ${vendor} removed successfully`);
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to remove vendor token:`, error);
      throw new Error(`Failed to remove vendor token: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getChannelStatus(): Promise<{
    weixin: {
      connected: boolean;
      pushPolicy: 'all' | 'important' | 'silent';
      boundAt?: boolean;
    } | null;
  }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/channels/status`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get channel status:`, error);
      throw new Error(`Failed to get channel status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async requestWeixinQRCode(): Promise<{ qrcode: string; displayUrl: string }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/channels/weixin/qr`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to request Weixin QR code:`, error);
      throw new Error(`Failed to request Weixin QR code: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async pollWeixinQRCode(qrcode: string): Promise<{
    status: 'wait' | 'scaned' | 'confirmed' | 'expired' | string;
    token?: string;
    baseUrl?: string;
    weixinUserId?: string;
    accountId?: string;
  }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/channels/weixin/poll`,
        { qrcode },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 40000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to poll Weixin QR code:`, error);
      throw new Error(`Failed to poll Weixin QR code: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async bindWeixinChannel(payload: {
    token: string;
    baseUrl: string;
    weixinUserId?: string;
    accountId?: string;
  }): Promise<{ ok: boolean }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/channels/weixin/bind`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to bind Weixin channel:`, error);
      throw new Error(`Failed to bind Weixin channel: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async disconnectWeixinChannel(): Promise<{ ok: boolean }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/channels/weixin`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to disconnect Weixin channel:`, error);
      throw new Error(`Failed to disconnect Weixin channel: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async updateWeixinChannelPolicy(pushPolicy: 'all' | 'important' | 'silent'): Promise<{ ok: boolean }> {
    try {
      const response = await axios.patch(
        `${configuration.serverUrl}/v1/channels/weixin/policy`,
        { pushPolicy },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json',
          },
          timeout: 10000,
        }
      );

      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to update Weixin channel policy:`, error);
      throw new Error(`Failed to update Weixin channel policy: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List stored vendor API tokens for the current user.
   */
  async listVendorTokens(): Promise<{ tokens: Array<{ vendor: string; token: string }> }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/connect/tokens`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 5000
        }
      );

      logger.debug(`[API] Listed ${response.data?.tokens?.length ?? 0} vendor tokens`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list vendor tokens:`, error);
      throw new Error(`Failed to list vendor tokens: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getArtifact(artifactId: string): Promise<Artifact> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/artifacts/${artifactId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );

      const raw = response.data.artifact ?? response.data;

      // Resolve encryption key
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';

      if (raw.dataEncryptionKey) {
        const decryptedKey = this.unwrapDataEncryptionKey(raw.dataEncryptionKey);
        if (decryptedKey) {
          encryptionKey = decryptedKey;
          encryptionVariant = 'dataKey';
        } else {
          logger.debug(`[API] Failed to decrypt dataEncryptionKey for artifact ${artifactId}, using credential key`);
          if (this.credential.encryption.type === 'contentSecretKey') {
            encryptionKey = this.credential.encryption.contentSecretKey;
            encryptionVariant = 'dataKey';
          } else if (this.credential.encryption.type === 'dataKey') {
            encryptionKey = this.credential.encryption.machineKey;
            encryptionVariant = 'dataKey';
          } else {
            encryptionKey = this.credential.encryption.secret;
            encryptionVariant = 'legacy';
          }
        }
      } else {
        // No data encryption key, use credential directly
        if (this.credential.encryption.type === 'contentSecretKey') {
          encryptionKey = this.credential.encryption.contentSecretKey;
          encryptionVariant = 'dataKey';
        } else if (this.credential.encryption.type === 'dataKey') {
          encryptionKey = this.credential.encryption.machineKey;
          encryptionVariant = 'dataKey';
        } else {
          encryptionKey = this.credential.encryption.secret;
          encryptionVariant = 'legacy';
        }
      }

      // Decrypt header and body
      let header = null;
      if (raw.header) {
        try {
          header = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.header));
        } catch (error) {
          logger.debug(`[API] Failed to decrypt artifact header for ${artifactId}, continuing with body-only access`, error);
        }
      }

      // Try to decrypt body, fallback to plaintext for team artifacts
      let body = null;
      if (raw.body) {
        try {
          body = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.body));
        } catch (decryptError) {
          body = null;
          // If decryption throws, try to parse as plaintext (for team artifacts)
          try {
            const decoded = decodeBase64(raw.body);
            const textDecoder = new TextDecoder();
            const plainText = textDecoder.decode(decoded);
            const parsed = JSON.parse(plainText);
            let bodyContent: any = parsed;
            if (parsed && typeof parsed === 'object' && 'body' in parsed) {
              bodyContent = (parsed as { body?: unknown }).body ?? null;
            }
            // bodyContent might be a JSON string (for team artifacts created by Kanban)
            // that needs to be parsed again to get the actual object
            if (typeof bodyContent === 'string') {
              try {
                bodyContent = JSON.parse(bodyContent);
                logger.debug(`[API] Parsed nested JSON body for artifact ${artifactId}`);
              } catch (nestedParseError) {
                // Keep as string if not valid JSON
                logger.debug(`[API] Body is string but not valid JSON, keeping as-is for artifact ${artifactId}`);
              }
            }
            body = bodyContent;
            logger.debug(`[API] Successfully read plaintext body for artifact ${artifactId}`);
          } catch (plaintextError) {
            logger.debug(`[API] Failed to decrypt or parse body for artifact ${artifactId}:`, plaintextError);
            body = null;
          }
        }

        if (body === null) {
          // Decrypt may return null without throwing for plaintext team artifacts.
          // In that case we must still attempt plaintext parsing.
          try {
            const decoded = decodeBase64(raw.body);
            const textDecoder = new TextDecoder();
            const plainText = textDecoder.decode(decoded);
            const parsed = JSON.parse(plainText);
            let bodyContent: any = parsed;
            if (parsed && typeof parsed === 'object' && 'body' in parsed) {
              bodyContent = (parsed as { body?: unknown }).body ?? null;
            }
            // bodyContent might be a JSON string (for team artifacts created by Kanban)
            // that needs to be parsed again to get the actual object
            if (typeof bodyContent === 'string') {
              try {
                bodyContent = JSON.parse(bodyContent);
                logger.debug(`[API] Parsed nested JSON body for artifact ${artifactId}`);
              } catch (nestedParseError) {
                // Keep as string if not valid JSON
                logger.debug(`[API] Body is string but not valid JSON, keeping as-is for artifact ${artifactId}`);
              }
            }
            body = bodyContent;
            logger.debug(`[API] Successfully read plaintext body for artifact ${artifactId}`);
          } catch (plaintextError) {
            logger.debug(`[API] Failed to decrypt or parse body for artifact ${artifactId}:`, plaintextError);
            body = null;
          }
        }
      }

      return {
        id: raw.id,
        header,
        headerVersion: raw.headerVersion,
        body,
        bodyVersion: raw.bodyVersion,
        type: raw.type || 'unknown',
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt
      };

    } catch (error) {
      if (axios.isAxiosError(error)) {
        logger.debug(`[API] [ERROR] Failed to get artifact ${artifactId}:`, {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          message: error.message
        });
      } else {
        logger.debug(`[API] [ERROR] Failed to get artifact ${artifactId}:`, error);
      }
      throw new Error(`Failed to get artifact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async sendTeamMessage(teamId: string, message: any): Promise<void> {
    try {
      await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/messages`,
        message,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Sent team message to ${teamId}`);
      logger.debug(`[METRICS] TeamMessage sent to ${teamId}`);
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 410) {
        logger.debug(`[API] Session deleted (410), stopping message send to ${teamId}`);
        return;
      }
      logger.debug(`[API] [ERROR] Failed to send team message:`, error);
      throw new Error(`Failed to send team message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getTeamMessages(teamId: string, params?: { limit?: number; before?: string }): Promise<{ messages: any[], hasMore: boolean, cursor?: string }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/messages`,
        {
          params: {
            limit: params?.limit,
            before: params?.before
          },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Loaded ${response.data?.messages?.length || 0} team messages for ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to fetch team messages:`, error);
      throw new Error(`Failed to fetch team messages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getSessionMessages(sessionId: string, params?: { limit?: number; before?: string }): Promise<{ messages: any[] }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/sessions/${sessionId}/messages`,
        {
          params: { limit: params?.limit, before: params?.before },
          headers: { 'Authorization': `Bearer ${this.credential.token}` },
          timeout: 10000
        }
      );
      return { messages: response.data?.messages ?? [] };
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to fetch session messages:`, error);
      throw new Error(`Failed to fetch session messages: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // KV Store Methods

  async kvGet(key: string): Promise<{ key: string, value: string, version: number } | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/kv/${key}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          validateStatus: (status) => status === 200 || status === 404
        }
      );

      if (response.status === 404) {
        return null;
      }

      // Server returns base64-encoded values — decode to plain string
      const raw = response.data;
      return {
        ...raw,
        value: new TextDecoder().decode(decodeBase64(raw.value)),
      };
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get KV ${key}:`, error);
      throw new Error(`Failed to get KV: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async kvList(prefix?: string, limit: number = 100): Promise<{ items: Array<{ key: string, value: string, version: number }> }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/kv`,
        {
          params: { prefix, limit },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          }
        }
      );
      // Server returns base64-encoded values — decode each item to plain string
      const raw = response.data;
      return {
        ...raw,
        items: (raw.items ?? []).map((item: any) => ({
          ...item,
          value: new TextDecoder().decode(decodeBase64(item.value)),
        })),
      };
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list KV:`, error);
      throw new Error(`Failed to list KV: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async kvMutate(mutations: Array<{ key: string, value: string | null, version: number }>): Promise<{ success: boolean, results?: any[], errors?: any[] }> {
    try {
      // Base64-encode values to match server convention (see apiSession kv-batch-update handler)
      const encodedMutations = mutations.map(m => ({
        ...m,
        value: m.value !== null ? encodeBase64(new TextEncoder().encode(m.value)) : null,
      }));

      const response = await axios.post(
        `${configuration.serverUrl}/v1/kv`,
        { mutations: encodedMutations },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          validateStatus: (status) => status === 200 || status === 409
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to mutate KV:`, error);
      throw new Error(`Failed to mutate KV: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  async updateArtifact(
    artifactId: string,
    header: any | null,
    body: any | null,
    expectedHeaderVersion?: number,
    expectedBodyVersion?: number
  ): Promise<void> {
    try {
      // 1. Fetch current artifact to get encryption key and versions
      const response = await axios.get(
        `${configuration.serverUrl}/v1/artifacts/${artifactId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      const raw = response.data.artifact ?? response.data;

      // 2. Resolve encryption key
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';

      if (raw.dataEncryptionKey) {
        const decryptedKey = this.unwrapDataEncryptionKey(raw.dataEncryptionKey);
        if (!decryptedKey) {
          throw new Error('Failed to decrypt artifact data key');
        }
        encryptionKey = decryptedKey;
        encryptionVariant = 'dataKey';

      } else {
        // Legacy artifact without specific data key
        if (this.credential.encryption.type === 'contentSecretKey') {
          encryptionKey = this.credential.encryption.contentSecretKey;
          encryptionVariant = 'dataKey';
        } else if (this.credential.encryption.type === 'dataKey') {
          encryptionKey = this.credential.encryption.machineKey;
          encryptionVariant = 'dataKey';
        } else {
          encryptionKey = this.credential.encryption.secret;
          encryptionVariant = 'legacy';
        }
      }

      // 3. Encrypt new content
      let encryptedHeader: string | undefined;
      let encryptedBody: string | undefined;

      let currentHeaderType: string | undefined;
      if (raw.header) {
        try {
          const decryptedHeader = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.header));
          if (decryptedHeader && typeof decryptedHeader === 'object') {
            currentHeaderType = (decryptedHeader as any).type;
          }
        } catch (error) {
          logger.debug(`[API] Failed to decrypt artifact header for ${artifactId} when determining type`, error);
        }
      }

      // Check if this is a team artifact (from header.type or existing artifact)
      const headerType = header && typeof header === 'object' ? header.type : undefined;
      const isTeamArtifact = headerType === 'team' || currentHeaderType === 'team' || raw.type === 'team';

      if (header !== undefined) {
        encryptedHeader = encodeBase64(encrypt(encryptionKey, encryptionVariant, header));
      }
      if (body !== undefined) {
        // For team artifacts, store body as plaintext (base64-encoded JSON)
        // This matches mobile app format and allows cross-client access
        if (isTeamArtifact) {
          const plainBody = this.normalizeTeamArtifactBody(body);
          encryptedBody = encodeBase64(new TextEncoder().encode(plainBody));
          logger.debug(`[API] Updating team artifact with plaintext body for cross-client access`);
        } else {
          encryptedBody = encodeBase64(encrypt(encryptionKey, encryptionVariant, body));
        }
      }

      // 4. Send update
      const updateRequest = {
        header: encryptedHeader,
        expectedHeaderVersion: expectedHeaderVersion ?? raw.headerVersion,
        body: encryptedBody,
        expectedBodyVersion: expectedBodyVersion ?? raw.bodyVersion
      };

      await axios.post(
        `${configuration.serverUrl}/v1/artifacts/${artifactId}`,
        updateRequest,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      logger.debug(`[API] Updated artifact ${artifactId}`);
      logger.debug(`[METRICS] ArtifactUpdated ${artifactId}`);

    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to update artifact ${artifactId}:`, error);
      throw new Error(`Failed to update artifact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create a new artifact with the given ID, header, and body
   * Used for lazy initialization of team artifacts
   */
  async createArtifact(
    artifactId: string,
    header: any,
    body: any
  ): Promise<Artifact> {
    try {
      // Generate encryption key for this artifact
      let dataEncryptionKey: Uint8Array;
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';

      if (this.credential.encryption.type === 'contentSecretKey') {
        // New unified approach: generate random data key and encrypt with contentSecretKey
        encryptionKey = getRandomBytes(32);
        encryptionVariant = 'dataKey';

        const publicKey = canonicalContentSecretBoxPublicKey(this.credential.encryption.contentSecretKey);
        const encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, publicKey);
        dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
        dataEncryptionKey.set([0], 0); // Version byte
        dataEncryptionKey.set(encryptedDataKey, 1);
      } else if (this.credential.encryption.type === 'dataKey') {
        // Legacy dataKey mode
        encryptionKey = getRandomBytes(32);
        encryptionVariant = 'dataKey';

        const encryptedDataKey = libsodiumEncryptForPublicKey(encryptionKey, this.credential.encryption.publicKey);
        dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
        dataEncryptionKey.set([0], 0); // Version byte
        dataEncryptionKey.set(encryptedDataKey, 1);
      } else {
        // Legacy mode - use secret directly
        encryptionKey = this.credential.encryption.secret;
        encryptionVariant = 'legacy';
        // For legacy mode, generate a random key and encrypt it
        const randomKey = getRandomBytes(32);
        dataEncryptionKey = encrypt(encryptionKey, encryptionVariant, randomKey);
        // Use the random key for content encryption
        encryptionKey = randomKey;
        encryptionVariant = 'legacy';
      }

      // Encrypt header (always encrypted)
      const encryptedHeader = encodeBase64(encrypt(encryptionKey, encryptionVariant, header));

      // For team artifacts, store body as plaintext (base64-encoded JSON)
      // This matches mobile app format and allows cross-client access without shared encryption keys
      let encryptedBody: string;
      if (header.type === 'team') {
        // Store as plaintext JSON (base64 encoded) - matches mobile kanban format
        const plainBody = this.normalizeTeamArtifactBody(body);
        encryptedBody = encodeBase64(new TextEncoder().encode(plainBody));
        logger.debug(`[API] Creating team artifact with plaintext body for cross-client access`);
      } else {
        // Normal encryption for non-team artifacts
        encryptedBody = encodeBase64(encrypt(encryptionKey, encryptionVariant, body));
      }
      const encodedDataKey = encodeBase64(dataEncryptionKey);

      // Create artifact via POST /v1/artifacts
      const response = await axios.post(
        `${configuration.serverUrl}/v1/artifacts`,
        {
          id: artifactId,
          header: encryptedHeader,
          body: encryptedBody,
          dataEncryptionKey: encodedDataKey
        },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );

      logger.debug(`[API] Created artifact ${artifactId}`);

      // Decrypt and return the created artifact
      const raw = response.data;
      return {
        id: raw.id,
        header: header, // Return original unencrypted header
        headerVersion: raw.headerVersion,
        body: body, // Return original unencrypted body
        bodyVersion: raw.bodyVersion,
        type: header.type || 'team', // Use type from header
        seq: raw.seq,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt
      };

    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to create artifact ${artifactId}:`, error);
      throw new Error(`Failed to create artifact: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // === Task API Methods (Server-Driven Task Orchestration) ===

  /**
   * List tasks for a team with optional filtering
   */
  async listTasks(teamId: string, filters?: {
    status?: string;
    assigneeId?: string;
    scopePath?: string;
    repoName?: string;
    includeGlobal?: boolean;
  }): Promise<{ tasks: any[]; version: number }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks`,
        {
          params: filters,
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Listed ${response.data.tasks?.length || 0} tasks for team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list tasks:`, error);
      throw new Error(`Failed to list tasks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a single task by ID
   */
  async getTask(teamId: string, taskId: string): Promise<any | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 404
        }
      );
      if (response.status === 404) return null;
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get task:`, error);
      throw new Error(`Failed to get task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Create a new task
   */
  async createTask(teamId: string, task: any): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks`,
        task,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Created task ${response.data.task?.id} for team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to create task:`, error);
      throw new Error(`Failed to create task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Update an existing task
   */
  async updateTask(teamId: string, taskId: string, updates: any): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.put(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}`,
        updates,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Updated task ${taskId} for team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to update task:`, error);
      if (axios.isAxiosError(error)) {
        const serverMessage = typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : error.message;
        throw new Error(`Failed to update task: ${serverMessage}`);
      }
      throw new Error(`Failed to update task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(teamId: string, taskId: string): Promise<{ success: boolean }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Deleted task ${taskId} from team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to delete task:`, error);
      throw new Error(`Failed to delete task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Start working on a task
   */
  async startTask(teamId: string, taskId: string, sessionId: string, role: string = 'builder'): Promise<{ success: boolean; task: any }> {
    return this.startTaskWithComment(teamId, taskId, sessionId, role);
  }

  async startTaskWithComment(teamId: string, taskId: string, sessionId: string, role: string = 'builder', comment?: {
    displayName?: string;
    content: string;
    mentions?: string[];
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/start`,
        { sessionId, role, ...(comment ? { comment } : {}) },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Started task ${taskId} with session ${sessionId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to start task:`, error);
      if (axios.isAxiosError(error)) {
        const serverMessage = typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : error.message;
        throw new Error(`Failed to start task: ${serverMessage}`);
      }
      throw new Error(`Failed to start task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Complete a task
   */
  async completeTask(teamId: string, taskId: string, sessionId: string): Promise<{ success: boolean; task: any }> {
    return this.completeTaskWithComment(teamId, taskId, sessionId);
  }

  async completeTaskWithComment(teamId: string, taskId: string, sessionId: string, comment?: {
    role?: string;
    displayName?: string;
    content: string;
    mentions?: string[];
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/complete`,
        { sessionId, ...(comment ? { comment } : {}) },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Completed task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to complete task:`, error);
      if (axios.isAxiosError(error)) {
        const serverMessage = typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : error.message;
        throw new Error(`Failed to complete task: ${serverMessage}`);
      }
      throw new Error(`Failed to complete task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async setTaskHumanStatusLock(teamId: string, taskId: string, lock: {
    sessionId?: string;
    role?: string;
    displayName?: string;
    kind?: 'human' | 'agent';
    mode: 'viewing' | 'editing' | 'manual-status';
    reason?: string;
    comment?: string;
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/human-lock`,
        lock,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Set human status lock on task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to set human status lock:`, error);
      if (axios.isAxiosError(error)) {
        const serverMessage = typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : error.message;
        throw new Error(`Failed to set human status lock: ${serverMessage}`);
      }
      throw new Error(`Failed to set human status lock: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async clearTaskHumanStatusLock(teamId: string, taskId: string, lock?: {
    sessionId?: string;
    role?: string;
    displayName?: string;
    kind?: 'human' | 'agent';
    mode?: 'viewing' | 'editing' | 'manual-status';
    comment?: string;
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/human-lock/clear`,
        lock ?? {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Cleared human status lock on task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to clear human status lock:`, error);
      if (axios.isAxiosError(error)) {
        const serverMessage = typeof error.response?.data?.error === 'string'
          ? error.response.data.error
          : error.message;
        throw new Error(`Failed to clear human status lock: ${serverMessage}`);
      }
      throw new Error(`Failed to clear human status lock: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Report a blocker on a task
   */
  async reportBlocker(teamId: string, taskId: string, sessionId: string, type: string, description: string): Promise<{ success: boolean; task: any }> {
    return this.reportBlockerWithComment(teamId, taskId, sessionId, type, description);
  }

  async reportBlockerWithComment(teamId: string, taskId: string, sessionId: string, type: string, description: string, comment?: {
    role?: string;
    displayName?: string;
    mentions?: string[];
    content?: string;
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/blocker`,
        { sessionId, type, description, ...(comment ? { ...comment, comment: comment.content } : {}) },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Reported blocker on task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to report blocker:`, error);
      throw new Error(`Failed to report blocker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Resolve a blocker
   */
  async resolveBlocker(teamId: string, taskId: string, blockerId: string, sessionId: string, resolution: string): Promise<{ success: boolean; task: any }> {
    return this.resolveBlockerWithComment(teamId, taskId, blockerId, sessionId, resolution);
  }

  async resolveBlockerWithComment(teamId: string, taskId: string, blockerId: string, sessionId: string, resolution: string, comment?: {
    role?: string;
    displayName?: string;
    type?: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request';
    content: string;
    mentions?: string[];
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/blocker/${blockerId}/resolve`,
        { sessionId, resolution, ...(comment ? { comment } : {}) },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Resolved blocker ${blockerId} on task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to resolve blocker:`, error);
      throw new Error(`Failed to resolve blocker: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async releaseSessionTaskLocks(teamId: string, sessionId: string): Promise<{ success: boolean; unlockedTaskIds: string[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/sessions/${sessionId}/release-locks`,
        {},
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Released task locks for session ${sessionId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to release task locks:`, error);
      throw new Error(`Failed to release task locks: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async addTaskComment(teamId: string, taskId: string, comment: {
    sessionId: string;
    role?: string;
    displayName?: string;
    type?: 'note' | 'status-change' | 'review-feedback' | 'handoff' | 'blocker' | 'decision' | 'human-override' | 'plan' | 'plan-review' | 'execution-check' | 'rework-request';
    content: string;
    fromStatus?: string;
    toStatus?: string;
    mentions?: string[];
  }): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/comments`,
        comment,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Added comment to task ${taskId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to add task comment:`, error);
      throw new Error(`Failed to add task comment: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // === Team Management API Methods ===

  /**
   * Add a member to a team.
   * Supports M1 extended fields: candidateId, specId, parentSessionId, executionPlane, runtimeType.
   */
  async addTeamMember(
    teamId: string,
    sessionId: string,
    roleId?: string,
    displayName?: string,
    opts?: {
      memberId?: string;
      sessionTag?: string;
      candidateId?: string;
      specId?: string;
      parentSessionId?: string;
      executionPlane?: string;
      runtimeType?: string;
      authorities?: string[];
      teamOverlay?: LegionMemberOverlay;
    }
  ): Promise<{ success: boolean; member: any }> {
    try {
      const candidateId = opts?.candidateId ?? (opts?.specId ? `spec:${opts.specId}` : undefined);
      const body: Record<string, unknown> = {
        sessionId,
        roleId: roleId || 'member',
        displayName,
        ...(opts?.memberId !== undefined && { memberId: opts.memberId }),
        ...(opts?.sessionTag !== undefined && { sessionTag: opts.sessionTag }),
        ...(candidateId !== undefined && { candidateId }),
        ...(opts?.specId !== undefined && { specId: opts.specId }),
        ...(opts?.parentSessionId !== undefined && { parentSessionId: opts.parentSessionId }),
        ...(opts?.executionPlane !== undefined && { executionPlane: opts.executionPlane }),
        ...(opts?.runtimeType !== undefined && { runtimeType: opts.runtimeType }),
        ...(opts?.authorities !== undefined && { authorities: opts.authorities }),
        ...(opts?.teamOverlay !== undefined && { teamOverlay: opts.teamOverlay }),
      };
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/members`,
        body,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Added member ${sessionId} to team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to add team member:`, error);
      throw new Error(`Failed to add team member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Remove a member from a team
   */
  async removeTeamMember(teamId: string, sessionId: string): Promise<{ success: boolean }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/teams/${teamId}/members/${sessionId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Removed member ${sessionId} from team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to remove team member:`, error);
      throw new Error(`Failed to remove team member: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List raw artifacts for the current user and decrypt their headers client-side.
   * Used as a compatibility fallback when dedicated team list endpoints are unavailable.
   */
  async listArtifacts(): Promise<Array<{
    id: string;
    title: string | null;
    type?: string;
    sessions?: string[];
    draft?: boolean;
    headerVersion: number;
    seq: number;
    createdAt: number;
    updatedAt: number;
    isDecrypted: boolean;
  }>> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/artifacts`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );

      const artifacts = Array.isArray(response.data)
        ? response.data
        : response.data?.artifacts ?? [];

      const decryptedArtifacts = artifacts.map((raw: any) => {
        let encryptionKey: Uint8Array;
        let encryptionVariant: 'legacy' | 'dataKey';

        if (raw.dataEncryptionKey) {
          const decryptedKey = this.unwrapDataEncryptionKey(raw.dataEncryptionKey);
          if (decryptedKey) {
            encryptionKey = decryptedKey;
            encryptionVariant = 'dataKey';
          } else if (this.credential.encryption.type === 'contentSecretKey') {
            encryptionKey = this.credential.encryption.contentSecretKey;
            encryptionVariant = 'dataKey';
          } else if (this.credential.encryption.type === 'dataKey') {
            encryptionKey = this.credential.encryption.machineKey;
            encryptionVariant = 'dataKey';
          } else {
            encryptionKey = this.credential.encryption.secret;
            encryptionVariant = 'legacy';
          }
        } else if (this.credential.encryption.type === 'contentSecretKey') {
          encryptionKey = this.credential.encryption.contentSecretKey;
          encryptionVariant = 'dataKey';
        } else if (this.credential.encryption.type === 'dataKey') {
          encryptionKey = this.credential.encryption.machineKey;
          encryptionVariant = 'dataKey';
        } else {
          encryptionKey = this.credential.encryption.secret;
          encryptionVariant = 'legacy';
        }

        let header: any = null;
        try {
          header = raw.header
            ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.header))
            : null;
        } catch (error) {
          logger.debug(`[API] Failed to decrypt artifact header for list item ${raw.id}:`, error);
        }

        return {
          id: raw.id,
          title: header?.title || null,
          type: header?.type,
          sessions: header?.sessions,
          draft: header?.draft,
          headerVersion: raw.headerVersion,
          seq: raw.seq,
          createdAt: raw.createdAt,
          updatedAt: raw.updatedAt,
          isDecrypted: !!header,
        };
      });

      logger.debug(`[API] Listed ${decryptedArtifacts.length} artifacts`);
      return decryptedArtifacts;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list artifacts:`, error);
      throw new Error(`Failed to list artifacts: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List teams accessible to the current user.
   */
  async listTeams(): Promise<{ teams: Array<{ id: string; name: string; memberCount: number; taskCount: number; createdAt: number; updatedAt: number }> }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Listed ${response.data?.teams?.length ?? 0} teams`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        logger.debug('[API] /v1/teams unavailable, falling back to decrypted artifact list');
        const artifacts = await this.listArtifacts();
        const teamArtifacts = artifacts.filter(
          artifact => artifact.type === 'team' || (!!artifact.sessions && artifact.sessions.length > 0)
        );

        const teams = await Promise.all(teamArtifacts.map(async (artifact) => {
          let memberCount = artifact.sessions?.length || 0;
          let taskCount = 0;

          try {
            const fullArtifact = await this.getArtifact(artifact.id);
            const body = fullArtifact?.body as any;
            const members = Array.isArray(body?.team?.members) ? body.team.members : [];
            const tasks = Array.isArray(body?.tasks) ? body.tasks : [];
            if (members.length > 0) {
              memberCount = members.length;
            }
            taskCount = tasks.length;
          } catch (nestedError) {
            logger.debug(`[API] Fallback team summary fetch failed for ${artifact.id}:`, nestedError);
          }

          return {
            id: artifact.id,
            name: artifact.title || artifact.id,
            memberCount,
            taskCount,
            createdAt: artifact.createdAt,
            updatedAt: artifact.updatedAt,
          };
        }));
        return { teams };
      }
      logger.debug(`[API] [ERROR] Failed to list teams:`, error);
      throw new Error(`Failed to list teams: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get a single team summary, including members.
   */
  async getTeam(teamId: string): Promise<{ team: { id: string; name: string; memberCount: number; taskCount: number; members: any[]; createdAt: number; updatedAt: number } } | null> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000,
          validateStatus: (status) => status === 200 || status === 404
        }
      );
      if (response.status === 404) return null;
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get team ${teamId}:`, error);
      throw new Error(`Failed to get team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Archive a team and all its sessions
   */
  async archiveTeam(teamId: string, sessionIds: string[] = []): Promise<{ success: boolean; archivedSessions: number }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/archive`,
        { sessionIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      logger.debug(`[API] Archived team ${teamId} with ${response.data.archivedSessions} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to archive team:`, error);
      throw new Error(`Failed to archive team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a team and all its sessions
   */
  async deleteTeam(teamId: string, sessionIds: string[] = []): Promise<{ success: boolean; deletedSessions: number }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/teams/${teamId}`,
        {
          data: { sessionIds },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );
      logger.debug(`[API] Deleted team ${teamId} with ${response.data.deletedSessions} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to delete team:`, error);
      throw new Error(`Failed to delete team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Rename a team
   */
  async renameTeam(teamId: string, newName: string): Promise<{ success: boolean; team: any }> {
    try {
      const response = await axios.put(
        `${configuration.serverUrl}/v1/teams/${teamId}/rename`,
        { name: newName },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Renamed team ${teamId} to "${newName}"`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to rename team:`, error);
      throw new Error(`Failed to rename team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch archive multiple sessions
   */
  async batchArchiveSessions(sessionIds: string[]): Promise<{ success: boolean; archived: number; results: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/batch/archive`,
        { sessionIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Batch archived ${response.data.archived} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to batch archive sessions:`, error);
      throw new Error(`Failed to batch archive sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch delete multiple sessions
   */
  async batchDeleteSessions(sessionIds: string[]): Promise<{ success: boolean; deleted: number; results: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/batch/delete`,
        { sessionIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Batch deleted ${response.data.deleted} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to batch delete sessions:`, error);
      throw new Error(`Failed to batch delete sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Rename a session
   */
  async renameSession(sessionId: string, newName: string): Promise<{ success: boolean; session: any }> {
    try {
      const response = await axios.put(
        `${configuration.serverUrl}/v1/sessions/${sessionId}/rename`,
        { name: newName },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      logger.debug(`[API] Renamed session ${sessionId} to "${newName}"`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to rename session:`, error);
      throw new Error(`Failed to rename session: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch archive multiple teams
   */
  async batchArchiveTeams(teamIds: string[]): Promise<{ success: boolean; archived: number; results: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/batch/archive`,
        { teamIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Batch archived ${response.data.archived} teams`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to batch archive teams:`, error);
      throw new Error(`Failed to batch archive teams: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch unarchive (restore) multiple sessions
   */
  async batchUnarchiveSessions(sessionIds: string[]): Promise<{ success: boolean; restored: number; results: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/sessions/batch/unarchive`,
        { sessionIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Batch unarchived ${response.data.restored} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to batch unarchive sessions:`, error);
      throw new Error(`Failed to batch unarchive sessions: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Unarchive (restore) a team and all its sessions
   */
  async unarchiveTeam(teamId: string, sessionIds: string[] = []): Promise<{ success: boolean; restoredSessions: number }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/unarchive`,
        { sessionIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Unarchived team ${teamId} with ${response.data.restoredSessions} sessions`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to unarchive team:`, error);
      throw new Error(`Failed to unarchive team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Batch delete multiple teams
   */
  async batchDeleteTeams(teamIds: string[]): Promise<{ success: boolean; deleted: number; results: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/batch/delete`,
        { teamIds },
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 60000
        }
      );
      logger.debug(`[API] Batch deleted ${response.data.deleted} teams`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to batch delete teams:`, error);
      throw new Error(`Failed to batch delete teams: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // === Role Pool & Reviews API Methods ===

  /**
   * List server-provided default role templates.
   */
  async listDefaultRoles(): Promise<{ roles: Array<{ id: string; title: string; summary: string; icon?: string; category?: string }> }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/roles/defaults`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list default roles:`, error);
      throw new Error(`Failed to list default roles: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List current user's custom roles.
   */
  async listRoles(limit = 100): Promise<{ roles: any[]; total: number }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/roles`,
        {
          params: { limit },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list roles:`, error);
      throw new Error(`Failed to list roles: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List public roles from role pool.
   */
  async listRolePool(limit = 100, search?: string): Promise<{ roles: any[]; total: number }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/roles/pool`,
        {
          params: { limit, search },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list role pool:`, error);
      throw new Error(`Failed to list role pool: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Submit a public review for a role.
   */
  async reviewRole(roleId: string, payload: {
    rating: number;
    codeScore?: number;
    qualityScore?: number;
    source?: 'user' | 'master' | 'system';
    sourceScores?: { user?: number; master?: number; system?: number };
    teamId?: string;
    comment?: string;
  }): Promise<{ success: true; review: any; stats: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/roles/${roleId}/reviews`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to review role:`, error);
      throw new Error(`Failed to review role: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List public role reviews.
   */
  async listRoleReviews(roleId: string, limit = 50): Promise<{ reviews: any[]; total: number }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/roles/${roleId}/reviews`,
        {
          params: { limit },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list role reviews:`, error);
      throw new Error(`Failed to list role reviews: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Submit a public review for a team.
   */
  async reviewTeam(teamId: string, payload: {
    rating: number;
    codeScore?: number;
    qualityScore?: number;
    source?: 'user' | 'master' | 'system';
    sourceScores?: { user?: number; master?: number; system?: number };
    roleIds?: string[];
    comment?: string;
  }): Promise<{ success: true; review: any; scorecard: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/reviews`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to review team:`, error);
      throw new Error(`Failed to review team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List public team reviews.
   */
  async listTeamReviews(teamId: string, limit = 50): Promise<{ reviews: any[]; total: number }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/reviews`,
        {
          params: { limit },
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list team reviews:`, error);
      throw new Error(`Failed to list team reviews: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get cumulative team scorecard.
   */
  async getTeamScore(teamId: string): Promise<any> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/score`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
          },
          timeout: 10000
        }
      );
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to get team score:`, error);
      throw new Error(`Failed to get team score: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // === Evolution / Genome API Methods (M3) ===

  /**
   * List bypass agents (executionPlane === 'bypass') registered for a team.
   * These are supervisor and help-agent sessions stored in the team artifact.
   */
  async listBypassAgents(teamId: string): Promise<{ agents: any[] }> {
    try {
      const response = await axios.get(
        `${configuration.serverUrl}/v1/teams/${teamId}/bypass-agents`,
        {
          headers: { 'Authorization': `Bearer ${this.credential.token}` },
          timeout: 10000,
        }
      );
      logger.debug(`[API] Listed ${response.data?.agents?.length ?? 0} bypass agents for team ${teamId}`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list bypass agents:`, error);
      throw new Error(`Failed to list bypass agents: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * List genomes visible to the current user.
   * Supports optional teamId and parentSessionId filters.
   */
  async listGenomes(opts?: {
    teamId?: string;
    parentSessionId?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ genomes: any[]; total: number }> {
    try {
      const params: Record<string, string | number> = {};
      if (opts?.teamId) params.teamId = opts.teamId;
      if (opts?.parentSessionId) params.parentSessionId = opts.parentSessionId;
      if (opts?.limit !== undefined) params.limit = opts.limit;
      if (opts?.offset !== undefined) params.offset = opts.offset;

      const response = await axios.get(
        `${configuration.serverUrl}/v1/genomes`,
        {
          headers: { 'Authorization': `Bearer ${this.credential.token}` },
          params,
          timeout: 10000,
        }
      );
      logger.debug(`[API] Listed ${response.data?.total ?? 0} genomes`);
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list genomes:`, error);
      throw new Error(`Failed to list genomes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Register or update a genome (reusable agent specification).
   * Called by the create_genome MCP tool.
   *
   * Routes to genome-hub (GENOME_HUB_URL, default aha-agi.com/genome) —
   * the M3 standalone marketplace server. Falls back to happy-server
   * legacy endpoint if genome-hub is unreachable.
   */
  async createGenome(genome: {
    id?: string;
    name: string;
    description?: string;
    spec: string;
    parentSessionId: string;
    teamId?: string;
    isPublic?: boolean;
    namespace?: string;
    tags?: string;
    category?: string;
  }): Promise<{ genome: any }> {
    // Primary: genome-hub (M3 marketplace, port 3006)
    const hubUrl = (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const hubKey = process.env.HUB_PUBLISH_KEY ?? '';
    const connectionHint = buildMarketplaceConnectionHint(hubUrl);
    const namespace = genome.namespace ?? '@public';
    const encodedNs = encodeURIComponent(namespace);
    const encodedName = encodeURIComponent(genome.name);

    // genome-hub promote body format (no parentSessionId / teamId — those are happy-server concepts)
    // Server creates v1 for brand-new genomes and vN+1 for validated promotions.
    const hubBody = {
      description: genome.description,
      spec: genome.spec,
      tags: genome.tags,
      category: genome.category,
      isPublic: genome.isPublic ?? false,
    };

    try {
      const response = await axios.post(
        `${hubUrl}/genomes/${encodedNs}/${encodedName}/promote`,
        hubBody,
        {
          headers: {
            'Content-Type': 'application/json',
            ...(hubKey ? { 'Authorization': `Bearer ${hubKey}` } : {}),
          },
          timeout: 10000,
        }
      );
      logger.debug(`[API] Created genome in genome-hub: ${response.data?.genome?.id}`);
      return response.data;
    } catch (hubError: any) {
      // Surface meaningful error if genome-hub is reachable but returned an error
      if (hubError?.response) {
        const status = hubError.response.status;
        const body = JSON.stringify(hubError.response.data ?? {});
        const authHint = buildMarketplacePublishAuthHint(status);
        throw new Error(`genome-hub returned ${status}: ${body}. ${authHint}`);
      }

      // genome-hub unreachable — fall back to happy-server legacy endpoint
      logger.debug(`[API] genome-hub unreachable (${hubError?.message}), falling back to happy-server`);
      try {
        const fallback = await axios.post(
          `${configuration.serverUrl}/v1/genomes`,
          { ...genome, isPublic: genome.isPublic ?? false },
          {
            headers: {
              'Authorization': `Bearer ${this.credential.token}`,
              'Content-Type': 'application/json',
            },
            timeout: 10000,
          }
        );
        logger.debug(`[API] Created genome via happy-server fallback: ${fallback.data?.genome?.id}`);
        return fallback.data;
      } catch (fallbackError) {
        logger.debug(`[API] [ERROR] Both genome-hub and happy-server failed`, fallbackError);
        throw new Error(`Failed to create genome: ${fallbackError instanceof Error ? fallbackError.message : 'Unknown error'}. ${connectionHint}`);
      }
    }
  }

  /**
   * Publish a LegionImage team template directly to genome-hub /corps.
   * Unlike createGenome, corps publication currently has no happy-server fallback
   * because the public marketplace is the source of truth for team templates.
   */
  async createCorpsTemplate(corps: {
    name: string;
    description: string;
    spec: string;
    namespace?: string;
    version?: number;
    tags?: string;
    isPublic?: boolean;
    publisherId?: string | null;
  }): Promise<{ genome: any; corps: LegionImage }> {
    const hubUrl = (process.env.GENOME_HUB_URL ?? DEFAULT_GENOME_HUB_URL).replace(/\/$/, '');
    const hubKey = process.env.HUB_PUBLISH_KEY ?? '';
    const connectionHint = buildMarketplaceConnectionHint(hubUrl);

    try {
      const response = await axios.post(
        `${hubUrl}/corps`,
        {
          namespace: corps.namespace ?? '@public',
          name: corps.name,
          version: corps.version ?? 1,
          description: corps.description,
          spec: corps.spec,
          tags: corps.tags,
          isPublic: corps.isPublic ?? false,
          publisherId: corps.publisherId ?? null,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            ...(hubKey ? { 'Authorization': `Bearer ${hubKey}` } : {}),
          },
          timeout: 10000,
        }
      );
      logger.debug(`[API] Created corps template in genome-hub: ${response.data?.genome?.id}`);
      return response.data;
    } catch (hubError: any) {
      if (hubError?.response) {
        const status = hubError.response.status;
        const body = JSON.stringify(hubError.response.data ?? {});
        const authHint = buildMarketplacePublishAuthHint(status);
        throw new Error(`genome-hub returned ${status}: ${body}. ${authHint}`);
      }

      logger.debug(`[API] [ERROR] Failed to create corps template in genome-hub`, hubError);
      throw new Error(`Failed to create corps template: ${hubError instanceof Error ? hubError.message : 'Unknown error'}. ${connectionHint}`);
    }
  }

  /**
   * Update genome marketing metadata (description, tags, category, isPublic, status)
   * without creating a new spec version. Calls PATCH /v1/genomes/:id on happy-server.
   * Called by the update_genome MCP tool.
   */
  async updateGenome(genomeId: string, updates: {
    description?: string | null;
    tags?: string | null;
    category?: string | null;
    isPublic?: boolean;
    status?: 'draft' | 'unverified' | 'verified' | 'official' | 'archived';
  }): Promise<{ genome: any }> {
    const response = await axios.patch(
      `${configuration.serverUrl}/v1/genomes/${encodeURIComponent(genomeId)}`,
      updates,
      {
        headers: {
          'Authorization': `Bearer ${this.credential.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    return response.data;
  }
}
