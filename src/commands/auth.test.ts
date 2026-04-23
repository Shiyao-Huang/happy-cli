import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authGetToken } from '@/api/auth';
import { parseBackupKeyToSecret } from '@/utils/backupKey';

const mockConfiguration = vi.hoisted(() => ({
  ahaHomeDir: '/tmp/.aha-test',
  configFile: '/tmp/.aha-test/config.json',
  serverUrl: 'https://aha-agi.test',
  webappUrl: 'https://aha-agi.test/webappv3',
}));

const mockConfigurationResolver = vi.hoisted(() => ({
  DEFAULT_WEBAPP_URL: 'https://aha-agi.com/webappv3',
  writePersistentCliConfig: vi.fn(),
}));

const mockApi = vi.hoisted(() => ({
  listTeams: vi.fn(),
}));

const mockPersistence = vi.hoisted(() => ({
  readCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  clearMachineId: vi.fn(),
  readSettings: vi.fn(),
  writeCredentialsContentSecretKey: vi.fn(),
  writeCredentialsLegacy: vi.fn(),
}));

const mockAccountJoin = vi.hoisted(() => ({
  createAccountJoinTicket: vi.fn(),
  isAccountJoinTicket: vi.fn((code: string) => code.startsWith('aha_join_') || /^[A-Z2-9]{6}$/.test(code)),
  redeemAccountJoinTicket: vi.fn(),
}));

const mockControlClient = vi.hoisted(() => ({
  stopDaemon: vi.fn(),
  checkIfDaemonRunningAndCleanupStaleState: vi.fn(),
  ensureDaemonRunning: vi.fn(),
}));

const mockRecoveryBootstrap = vi.hoisted(() => ({
  bootstrapRecoveryMaterial: vi.fn(),
  getRecoveryMaterialSecret: vi.fn(),
}));

vi.mock('@/persistence', () => mockPersistence);

vi.mock('@/ui/auth', () => ({
  authAndSetupMachineIfNeeded: vi.fn(),
}));

vi.mock('@/configuration', () => ({
  configuration: mockConfiguration,
}));

vi.mock('@/configurationResolver', () => mockConfigurationResolver);

vi.mock('@/daemon/controlClient', () => mockControlClient);

vi.mock('@/ui/logger', () => ({
  logger: {
    debug: vi.fn(),
  },
}));

vi.mock('@/auth/reconnect', () => ({
  reconnectWithStoredCredentials: vi.fn(),
}));

vi.mock('@/utils/backupKey', () => ({
  parseBackupKeyToSecret: vi.fn(),
}));

vi.mock('@/api/auth', () => ({
  authGetToken: vi.fn(),
}));

vi.mock('@/api/supabaseAuth', () => ({
  doEmailOtpAuth: vi.fn(),
}));

vi.mock('@/api/api', () => ({
  ApiClient: {
    create: vi.fn(async () => mockApi),
  },
}));

vi.mock('@/api/accountJoin', () => mockAccountJoin);

vi.mock('@/auth/recoveryBootstrap', () => mockRecoveryBootstrap);

import { doEmailOtpAuth } from '@/api/supabaseAuth';
import { handleAuthCommand } from './auth';

function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls
    .map(call => call.map(value => String(value)).join(' '))
    .join('\n');
}

describe('handleAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfiguration.serverUrl = 'https://aha-agi.test';
    mockConfiguration.webappUrl = 'https://aha-agi.test/webappv3';
    mockPersistence.readSettings.mockResolvedValue({
      onboardingCompleted: false,
      machineId: 'machine-123',
    });
    mockControlClient.checkIfDaemonRunningAndCleanupStaleState.mockResolvedValue(true);
    mockControlClient.ensureDaemonRunning.mockResolvedValue(null);
    mockRecoveryBootstrap.getRecoveryMaterialSecret.mockReturnValue(null);
  });

  it('documents show-join-code in help output', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['help']);

    expect(collectOutput(logSpy)).toContain('show-join-code');
  });

  it('prints a reusable join command from the existing join-ticket endpoint', async () => {
    mockPersistence.readCredentials.mockResolvedValue({
      token: 'token-123',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    mockAccountJoin.createAccountJoinTicket.mockResolvedValue({
      ticket: 'aha_join_abc123',
      expiresAt: '2026-04-02T12:34:56.000Z',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['show-join-code']);

    const output = collectOutput(logSpy);
    expect(mockAccountJoin.createAccountJoinTicket).toHaveBeenCalledWith('token-123');
    expect(output).toContain('npm i aha-agi && npx aha auth login --server-url https://aha-agi.test --webapp-url https://aha-agi.test/webappv3 --code aha_join_abc123');
    expect(output).toContain('One-time join command ready');
    expect(output).toContain('This join code is single-use.');
  });

  it('pins the server URL for the default production deployment too', async () => {
    mockConfiguration.serverUrl = 'https://aha-agi.com/api';
    mockConfiguration.webappUrl = 'https://aha-agi.com/webappv3';
    mockPersistence.readCredentials.mockResolvedValue({
      token: 'token-123',
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    mockAccountJoin.createAccountJoinTicket.mockResolvedValue({
      ticket: 'aha_join_default123',
      expiresAt: '2026-04-02T12:34:56.000Z',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['show-join-code']);

    const output = collectOutput(logSpy);
    expect(output).toContain('npm i aha-agi && npx aha auth login --server-url https://aha-agi.com/api --webapp-url https://aha-agi.com/webappv3 --code aha_join_default123');
  });

  it('uses and persists explicit server URLs during code login', async () => {
    mockPersistence.readCredentials.mockResolvedValue(null);
    mockAccountJoin.redeemAccountJoinTicket.mockResolvedValue({
      token: 'token-joined',
      userId: 'acct-joined',
      secret: new Uint8Array([4, 5, 6]),
    });

    await handleAuthCommand([
      'login',
      '--server-url',
      'https://ahaagi.com/api',
      '--webapp-url',
      'https://ahaagi.com/webappv3',
      '--code',
      'AJXMVN',
    ]);

    expect(mockConfiguration.serverUrl).toBe('https://ahaagi.com/api');
    expect(mockConfiguration.webappUrl).toBe('https://ahaagi.com/webappv3');
    expect(mockConfigurationResolver.writePersistentCliConfig).toHaveBeenCalledWith('/tmp/.aha-test/config.json', {
      serverUrl: 'https://ahaagi.com/api',
      webappUrl: 'https://ahaagi.com/webappv3',
    });
    expect(mockAccountJoin.redeemAccountJoinTicket).toHaveBeenCalledWith('AJXMVN');
    expect(mockPersistence.writeCredentialsContentSecretKey).toHaveBeenCalledWith({
      contentSecretKey: new Uint8Array([4, 5, 6]),
      token: 'token-joined',
    });
  });

  it('shows teams in auth status', async () => {
    const payload = Buffer.from(JSON.stringify({
      sub: 'acct-1',
      session: 'sess-1',
    })).toString('base64url');

    mockPersistence.readCredentials.mockResolvedValue({
      token: `header.${payload}.sig`,
      encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3]) },
    });
    mockApi.listTeams.mockResolvedValue({
      teams: [
        { id: 'team-1', name: 'Alpha', memberCount: 2, taskCount: 3, createdAt: 0, updatedAt: 0 },
        { id: 'team-2', name: 'Beta', memberCount: 1, taskCount: 0, createdAt: 0, updatedAt: 0 },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['status']);

    const output = collectOutput(logSpy);
    expect(output).toContain('Authentication Status');
    expect(output).toContain('Teams (2)');
    expect(output).toContain('Alpha (team-1)');
    expect(output).toContain('Beta (team-2)');
  });

  it('does not print backup key details after email login', async () => {
    const payload = Buffer.from(JSON.stringify({
      sub: 'acct-2',
    })).toString('base64url');

    mockPersistence.readCredentials.mockResolvedValue(null);
    vi.mocked(doEmailOtpAuth).mockResolvedValue({
      token: `header.${payload}.sig`,
      secret: new Uint8Array([9, 8, 7]),
      userId: 'user-1',
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['login', '--email']);

    const output = collectOutput(logSpy);
    expect(output).toContain('Signed in via email');
    expect(output).toContain('aha auth show-join-code');
    expect(output).not.toContain('emergency restore key');
    expect(output).not.toContain('npx aha auth restore --code');
  });

  it('restores account from backup key via login --code', async () => {
    const payload = Buffer.from(JSON.stringify({
      sub: 'acct-backup-restore',
    })).toString('base64url');
    const secret = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

    mockPersistence.readCredentials.mockResolvedValue(null);
    vi.mocked(parseBackupKeyToSecret).mockReturnValue(secret);
    vi.mocked(authGetToken).mockResolvedValue(`header.${payload}.sig`);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleAuthCommand(['login', '--code', 'ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE']);

    expect(parseBackupKeyToSecret).toHaveBeenCalledWith('ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE');
    expect(authGetToken).toHaveBeenCalledWith(secret, 'reconnect');
    expect(mockPersistence.clearMachineId).toHaveBeenCalled();
    expect(mockPersistence.writeCredentialsContentSecretKey).toHaveBeenCalledWith({
      contentSecretKey: secret,
      token: `header.${payload}.sig`,
    });
    expect(mockRecoveryBootstrap.bootstrapRecoveryMaterial).toHaveBeenCalledWith(`header.${payload}.sig`, secret);

    const output = collectOutput(logSpy);
    expect(output).toContain('Restored account from backup key.');
    expect(output).toContain('Account ID: acct-backup-restore');
  });

  it('shows a helpful error when --code is neither join ticket nor backup key', async () => {
    vi.mocked(parseBackupKeyToSecret).mockImplementation(() => {
      throw new Error('invalid backup key');
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(handleAuthCommand(['login', '--code', 'not-a-valid-code'])).rejects.toThrow('process.exit');

    expect(collectOutput(errorSpy)).toContain('Invalid code. Expected a one-time join ticket or backup key.');
    expect(collectOutput(logSpy)).toContain('To join from another device, run: aha auth show-join-code');
    expect(collectOutput(logSpy)).toContain('To restore from a backup key, use the secretKeyFormatted value from your restore JSON.');

    exitSpy.mockRestore();
  });

  it('shows a helpful message when a join code is invalid or already used', async () => {
    mockAccountJoin.redeemAccountJoinTicket.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 404,
        data: {
          error: 'Join code is invalid or expired',
          code: 'JOIN_TICKET_INVALID',
        },
      },
      message: 'Request failed with status code 404',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(handleAuthCommand(['join', '--ticket', 'YHLGVT'])).rejects.toThrow('process.exit');

    const output = collectOutput(errorSpy);
    expect(output).toContain('Join failed:');
    expect(output).toContain('Join code is invalid, already used, or expired.');

    exitSpy.mockRestore();
  });

  it('shows a helpful message when recovery material is not ready for join', async () => {
    mockAccountJoin.redeemAccountJoinTicket.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          error: 'Automatic recovery is not ready for this account yet',
          code: 'RECOVERY_NOT_READY',
        },
      },
      message: 'Request failed with status code 409',
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(handleAuthCommand(['join', '--ticket', 'YHLGVT'])).rejects.toThrow('process.exit');

    const output = collectOutput(errorSpy);
    expect(output).toContain('Join failed:');
    expect(output).toContain('This account is not ready for machine join yet.');

    exitSpy.mockRestore();
  });
});
