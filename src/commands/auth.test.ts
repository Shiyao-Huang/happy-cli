import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  isAccountJoinTicket: vi.fn((code: string) => code.startsWith('aha_join_')),
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
  configuration: {
    ahaHomeDir: '/tmp/.aha-test',
    serverUrl: 'https://aha-agi.test',
  },
}));

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
    expect(output).toContain('aha auth login --code aha_join_abc123');
    expect(output).toContain('One-time join command ready');
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
});
