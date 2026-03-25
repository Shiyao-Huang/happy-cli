import { describe, expect, it } from 'vitest';

import { shouldUsePidHeartbeat } from './heartbeatPolicy';
import { TrackedSession } from './types';

function makeSession(overrides: Partial<TrackedSession> = {}): TrackedSession {
  return {
    startedBy: 'daemon',
    pid: 12345,
    ...overrides,
  };
}

describe('shouldUsePidHeartbeat', () => {
  it('keeps PID heartbeat enabled for Claude sessions by default', () => {
    const session = makeSession({
      claudeLocalSessionId: 'local-claude-session',
      ahaSessionMetadataFromLocalWebhook: {
        flavor: 'claude',
      } as any,
    });

    expect(shouldUsePidHeartbeat(session, false)).toBe(true);
  });

  it('can opt Claude sessions into strict MCP-only heartbeat mode', () => {
    const session = makeSession({
      claudeLocalSessionId: 'local-claude-session',
      ahaSessionMetadataFromLocalWebhook: {
        flavor: 'claude',
      } as any,
    });

    expect(shouldUsePidHeartbeat(session, true)).toBe(false);
  });

  it('always keeps PID heartbeat for codex sessions', () => {
    const session = makeSession({
      claudeLocalSessionId: 'local-codex-session',
      ahaSessionMetadataFromLocalWebhook: {
        flavor: 'codex',
      } as any,
    });

    expect(shouldUsePidHeartbeat(session, true)).toBe(true);
  });
});
