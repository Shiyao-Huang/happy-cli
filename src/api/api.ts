import axios from 'axios'
import { logger } from '@/ui/logger'
import type { AgentState, CreateSessionResponse, Metadata, Session, Machine, MachineMetadata, DaemonState, Artifact } from '@/api/types'
import { ApiSessionClient } from './apiSession';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, encodeBase64, getRandomBytes, encrypt, decrypt, libsodiumDecryptWithSecretKey, libsodiumEncryptForPublicKey, libsodiumPublicKeyFromSecretKey, libsodiumSecretKeyFromSeed } from './encryption';
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
        const secretKey = libsodiumSecretKeyFromSeed(this.credential.encryption.contentSecretKey);
        return libsodiumDecryptWithSecretKey(decoded.slice(1), secretKey);
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

    const encodedDataEncryptionKey = dataEncryptionKey ? encodeBase64(dataEncryptionKey) : null;

    // Create session
    try {
      const response = await axios.post<CreateSessionResponse>(
        `${configuration.serverUrl}/v1/sessions`,
        {
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

      const publicKey = libsodiumPublicKeyFromSecretKey(this.credential.encryption.contentSecretKey);
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

    // Create machine
    const response = await axios.post(
      `${configuration.serverUrl}/v1/machines`,
      {
        id: opts.machineId,
        metadata: encodeBase64(encrypt(encryptionKey, encryptionVariant, opts.metadata)),
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

        const publicKey = libsodiumPublicKeyFromSecretKey(this.credential.encryption.contentSecretKey);
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
  async listTasks(teamId: string, filters?: { status?: string; assigneeId?: string }): Promise<{ tasks: any[]; version: number }> {
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
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/start`,
        { sessionId, role },
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
      throw new Error(`Failed to start task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Complete a task
   */
  async completeTask(teamId: string, taskId: string, sessionId: string): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/complete`,
        { sessionId },
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
      throw new Error(`Failed to complete task: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Report a blocker on a task
   */
  async reportBlocker(teamId: string, taskId: string, sessionId: string, type: string, description: string): Promise<{ success: boolean; task: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/blocker`,
        { sessionId, type, description },
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
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/tasks/${taskId}/blocker/${blockerId}/resolve`,
        { sessionId, resolution },
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

  // === Team Management API Methods ===

  /**
   * Add a member to a team
   */
  async addTeamMember(teamId: string, sessionId: string, roleId?: string, displayName?: string): Promise<{ success: boolean; member: any }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/members`,
        { sessionId, roleId: roleId || 'member', displayName },
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
   * Archive a team and all its sessions
   */
  async archiveTeam(teamId: string): Promise<{ success: boolean; archivedSessions: number }> {
    try {
      const response = await axios.post(
        `${configuration.serverUrl}/v1/teams/${teamId}/archive`,
        {},
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
  async deleteTeam(teamId: string): Promise<{ success: boolean; deletedSessions: number }> {
    try {
      const response = await axios.delete(
        `${configuration.serverUrl}/v1/teams/${teamId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.credential.token}`
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
}
