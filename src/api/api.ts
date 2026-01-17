import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState, Artifact } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumEncryptForPublicKey, libsodiumPublicKeyFromSecretKey } from './encryption';
import { PushNotificationClient } from './pushNotifications';
import { configuration } from '@/configuration';
import chalk from 'chalk';
import { Credentials } from '@/persistence';

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

  /**
   * Create a new session or load existing one with the given tag
   */
  async getOrCreateSession(opts: {
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
      const publicKey = libsodiumPublicKeyFromSecretKey(this.credential.encryption.contentSecretKey);
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

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
          tag: opts.tag,
          metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
          agentState: opts.state ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.state)) : null,
          dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null,
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
      let raw = response.data.session;
      let session: Session = {
        id: raw.id,
        seq: raw.seq,
        metadata: decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)),
        metadataVersion: raw.metadataVersion,
        agentState: raw.agentState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.agentState)) : null,
        agentStateVersion: raw.agentStateVersion,
        encryptionKey: encryptionKey,
        encryptionVariant: encryptionVariant
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
      // New unified approach: use contentSecretKey for machine encryption
      encryptionVariant = 'dataKey';
      encryptionKey = this.credential.encryption.contentSecretKey;

      // Encrypt using box encryption with derived public key
      const publicKey = libsodiumPublicKeyFromSecretKey(this.credential.encryption.contentSecretKey);
      let encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.contentSecretKey, publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Encrypted data key
    } else if (this.credential.encryption.type === 'dataKey') {
      // Legacy dataKey mode
      encryptionVariant = 'dataKey';
      encryptionKey = this.credential.encryption.machineKey;
      let encryptedDataKey = libsodiumEncryptForPublicKey(this.credential.encryption.machineKey, this.credential.encryption.publicKey);
      dataEncryptionKey = new Uint8Array(encryptedDataKey.length + 1);
      dataEncryptionKey.set([0], 0); // Version byte
      dataEncryptionKey.set(encryptedDataKey, 1); // Data key
    } else {
      // Legacy encryption
      encryptionKey = this.credential.encryption.secret;
      encryptionVariant = 'legacy';
    }

    // Create machine
    const response = await axios.post(
      `${configuration.serverUrl}/v1/machines`,
      {
        id: opts.machineId,
        metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
        daemonState: opts.daemonState ? encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.daemonState)) : undefined,
        dataEncryptionKey: dataEncryptionKey ? encodeBase64(dataEncryptionKey) : undefined
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
      console.log(chalk.yellow(`[API] Failed to create machine: ${response.statusText}, most likely you have re-authenticated, but you still have a machine associated with the old account. Now we are trying to re-associate the machine with the new account. That is not allowed. Please run 'happy doctor clean' to clean up your happy state, and try your original command again. Please create an issue on github if this is causing you problems. We apologize for the inconvenience.`));
      process.exit(1);
    }

    const raw = response.data.machine;
    logger.debug(`[API] Machine ${opts.machineId} registered/updated with server`);

    // Return decrypted machine like we do for sessions
    const machine: Machine = {
      id: raw.id,
      encryptionKey: encryptionKey,
      encryptionVariant: encryptionVariant,
      metadata: raw.metadata ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.metadata)) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.daemonState)) : null,
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

      const raw = response.data.artifact;

      // Resolve encryption key
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';

      if (raw.dataEncryptionKey) {
        // Artifact has its own data key - need to decrypt it
        const encryptedDataKey = decodeBase64(raw.dataEncryptionKey);

        if (this.credential.encryption.type === 'contentSecretKey') {
          // Use contentSecretKey for decryption (same as Kanban)
          encryptionKey = this.credential.encryption.contentSecretKey;
          encryptionVariant = 'dataKey';
        } else if (this.credential.encryption.type === 'dataKey') {
          encryptionKey = this.credential.encryption.machineKey;
          encryptionVariant = 'dataKey';
        } else {
          encryptionKey = this.credential.encryption.secret;
          encryptionVariant = 'legacy';
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
      const header = raw.header ? decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.header)) : null;

      // Try to decrypt body, fallback to plaintext for team artifacts
      let body = null;
      if (raw.body) {
        try {
          body = decrypt(encryptionKey, encryptionVariant, decodeBase64(raw.body));
        } catch (decryptError) {
          // If decryption fails, try to parse as plaintext (for team artifacts)
          try {
            const decoded = decodeBase64(raw.body);
            const textDecoder = new TextDecoder();
            const plainText = textDecoder.decode(decoded);
            const parsed = JSON.parse(plainText);
            body = parsed.body || null;
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

      return response.data;
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
      return response.data;
    } catch (error) {
      logger.debug(`[API] [ERROR] Failed to list KV:`, error);
      throw new Error(`Failed to list KV: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async kvMutate(mutations: Array<{ key: string, value: string | null, version: number }>): Promise<{ success: boolean, results?: any[], errors?: any[] }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/kv`,
        { mutations },
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
      const raw = response.data.artifact;

      // 2. Resolve encryption key
      let encryptionKey: Uint8Array;
      let encryptionVariant: 'legacy' | 'dataKey';
      let artifactDataKey: Uint8Array;

      if (raw.dataEncryptionKey) {
        // Artifact has its own data key
        const encryptedDataKey = decodeBase64(raw.dataEncryptionKey);

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

        // Decrypt the data key
        const decryptedKey = decrypt(encryptionKey, encryptionVariant, encryptedDataKey);
        if (!decryptedKey) {
          throw new Error('Failed to decrypt artifact data key');
        }
        artifactDataKey = decryptedKey;
        // Use the decrypted data key with 'legacy' variant for actual encryption
        encryptionKey = artifactDataKey;
        encryptionVariant = 'legacy';

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

      if (header !== undefined) {
        encryptedHeader = encodeBase64(encrypt(encryptionKey, encryptionVariant, header));
      }
      if (body !== undefined) {
        encryptedBody = encodeBase64(encrypt(encryptionKey, encryptionVariant, body));
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
}
