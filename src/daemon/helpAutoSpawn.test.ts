import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('@/ui/logger', () => ({
  logger: { debug: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/api/types', () => ({}));

// ── Subject under test ────────────────────────────────────────────────────────

import {
  createHelpAutoSpawnState,
  checkHelpAutoSpawn,
  countActiveHelpAgents,
  HELP_POOL_MAX,
  HELP_DEBOUNCE_MS,
  shouldTriggerHelpAutoSpawn,
} from './helpAutoSpawn';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Create a temporary directory with a messages.jsonl for testing. */
function makeTeamDir(tmpDir: string, teamId: string, messages: object[]): string {
  const teamDir = path.join(tmpDir, '.aha', 'teams', teamId);
  fs.mkdirSync(teamDir, { recursive: true });
  const filePath = path.join(teamDir, 'messages.jsonl');
  fs.writeFileSync(filePath, messages.map(m => JSON.stringify(m)).join('\n'));
  return teamDir;
}

function makeMessage(
  content: string,
  timestamp = Date.now(),
  overrides: Record<string, unknown> = {}
) {
  return { id: 'msg-1', teamId: 'team-a', fromRole: 'builder', content, timestamp, ...overrides };
}

function makeSession(teamId: string, role: string) {
  return {
    ahaSessionMetadataFromLocalWebhook: { teamId, role, path: '/', host: 'h', homeDir: '/', ahaHomeDir: '/', ahaLibDir: '/', ahaToolsDir: '/' },
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('checkHelpAutoSpawn', () => {
  let tmpDir: string;
  let requestHelp: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'help-auto-spawn-'));
    requestHelp = vi.fn().mockResolvedValue({ success: true, helpAgentSessionId: 'ha-1' });
  });

  it('spawns help-agent when @help appears in a recent message', async () => {
    const teamId = 'team-a';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [makeMessage('@help I am stuck', now - 1000)]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).toHaveBeenCalledOnce();
    expect(requestHelp).toHaveBeenCalledWith(expect.objectContaining({ teamId }));
    expect(state.lastSpawnTsByTeam.get(teamId)).toBe(now);
  });

  it('does not spawn again within the debounce window (60 s)', async () => {
    const teamId = 'team-b';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [makeMessage('@help again', now - 1000)]);

    const state = createHelpAutoSpawnState();
    // Simulate a spawn that happened 30 s ago
    state.lastSpawnTsByTeam.set(teamId, now - 30_000);

    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });

  it('does not spawn when active help-agent count equals poolMax', async () => {
    const teamId = 'team-c';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [makeMessage('@help needed', now - 500)]);

    const sessions = [
      makeSession(teamId, 'help-agent'),
      makeSession(teamId, 'help-agent'),
    ];

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions,
      state,
      requestHelp,
      poolMax: HELP_POOL_MAX,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });

  it('does not spawn when no message contains @help', async () => {
    const teamId = 'team-d';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [
      makeMessage('anyone there?', now - 2000),
      makeMessage('working on the bug', now - 1000),
    ]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });

  it('updates lastCheckedTs after each cycle regardless of spawn', async () => {
    const teamId = 'team-e';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [makeMessage('no help here', now - 500)]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(state.lastCheckedTsByTeam.get(teamId)).toBe(now);
  });

  it('@help detection is case-insensitive', async () => {
    const teamId = 'team-f';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [makeMessage('@HELP please assist', now - 100)]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).toHaveBeenCalledOnce();
  });

  it('does not auto-spawn from handshake guidance that only documents @help', async () => {
    const teamId = 'team-f2';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [
      makeMessage('If blocked, use `@help` in team chat.', now - 100, {
        metadata: { type: 'handshake' },
      }),
    ]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });

  it('does not auto-spawn from help-agent chatter', async () => {
    const teamId = 'team-f3';
    const now = Date.now();
    makeTeamDir(tmpDir, teamId, [
      makeMessage('@help already handling this', now - 100, {
        fromRole: 'help-agent',
      }),
    ]);

    const state = createHelpAutoSpawnState();
    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });

  it('skips messages older than lastCheckedTs (no double-spawn across cycles)', async () => {
    const teamId = 'team-g';
    const now = Date.now();
    const oldTs = now - 200_000; // 3+ minutes ago
    makeTeamDir(tmpDir, teamId, [makeMessage('@help old message', oldTs)]);

    const state = createHelpAutoSpawnState();
    // Pretend we already checked 100 s ago (after the message was posted)
    state.lastCheckedTsByTeam.set(teamId, oldTs + 1000);

    await checkHelpAutoSpawn({
      activeTeamIds: [teamId],
      sessions: [],
      state,
      requestHelp,
      cwd: tmpDir,
      now,
    });

    expect(requestHelp).not.toHaveBeenCalled();
  });
});

describe('countActiveHelpAgents', () => {
  it('counts only help-agent sessions for the given team', () => {
    const sessions = [
      makeSession('team-1', 'help-agent'),
      makeSession('team-1', 'builder'),
      makeSession('team-2', 'help-agent'),
    ];
    expect(countActiveHelpAgents(sessions, 'team-1')).toBe(1);
    expect(countActiveHelpAgents(sessions, 'team-2')).toBe(1);
    expect(countActiveHelpAgents(sessions, 'team-3')).toBe(0);
  });

  it('counts sessions with roomId when teamId is absent', () => {
    const sessions = [
      {
        ahaSessionMetadataFromLocalWebhook: {
          roomId: 'room-x',
          role: 'help-agent',
          path: '/',
          host: 'h',
          homeDir: '/',
          ahaHomeDir: '/',
          ahaLibDir: '/',
          ahaToolsDir: '/',
        },
      },
    ];
    expect(countActiveHelpAgents(sessions, 'room-x')).toBe(1);
  });
});

describe('shouldTriggerHelpAutoSpawn', () => {
  it('ignores handshake messages that mention @help as documentation', () => {
    expect(shouldTriggerHelpAutoSpawn({
      content: 'If blocked, use `@help` in team chat.',
      timestamp: Date.now(),
      metadata: { type: 'handshake' },
    })).toBe(false);
  });

  it('keeps explicit teammate help requests eligible', () => {
    expect(shouldTriggerHelpAutoSpawn({
      content: '@help I am blocked on auth',
      timestamp: Date.now(),
      fromRole: 'builder',
    })).toBe(true);
  });
});
