import { describe, expect, it } from 'vitest';

import {
  getEffectiveTeamMessageDisplayName,
  getEffectiveTeamMessageRole,
  getOriginalTeamMessageSessionId,
  withTeamMessageIdentityFallback,
} from './teamMessageIdentity';

describe('team message identity fallback', () => {
  it('strips fromSessionId while preserving original identity in metadata', () => {
    const fallback = withTeamMessageIdentityFallback({
      id: 'msg-1',
      fromSessionId: 'session-1',
      fromRole: 'supervisor',
      fromDisplayName: 'Supervisor',
      metadata: { type: 'handshake' },
    });

    expect(fallback.fromSessionId).toBeUndefined();
    expect(fallback.metadata).toMatchObject({
      type: 'handshake',
      identityFallback: {
        reason: 'fromSessionId-forbidden',
        originalFromSessionId: 'session-1',
        originalFromRole: 'supervisor',
        originalFromDisplayName: 'Supervisor',
      },
    });
  });

  it('resolves direct identity before fallback identity', () => {
    expect(getOriginalTeamMessageSessionId({
      fromSessionId: 'direct-session',
      metadata: {
        identityFallback: { originalFromSessionId: 'fallback-session' },
      },
    })).toBe('direct-session');
  });

  it('uses fallback role and display name for server-coerced user messages', () => {
    const message = {
      fromRole: 'user',
      fromDisplayName: 'User',
      metadata: {
        identityFallback: {
          originalFromSessionId: 'session-1',
          originalFromRole: 'implementer',
          originalFromDisplayName: 'Implementer',
        },
      },
    };

    expect(getOriginalTeamMessageSessionId(message)).toBe('session-1');
    expect(getEffectiveTeamMessageRole(message)).toBe('implementer');
    expect(getEffectiveTeamMessageDisplayName(message)).toBe('Implementer');
  });
});
