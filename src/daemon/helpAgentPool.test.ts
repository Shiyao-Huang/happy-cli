import { describe, expect, it } from 'vitest';

import { chooseHelpAgentForRequest } from './helpAgentPool';

describe('helpAgentPool', () => {
  it('spawns when no active help-agent exists', () => {
    expect(chooseHelpAgentForRequest({
      activeSessionIds: [],
      leaseExpiryBySessionId: new Map(),
      maxAgents: 2,
      now: 1000,
    })).toEqual({ action: 'spawn' });
  });

  it('reuses an idle help-agent before spawning a new one', () => {
    expect(chooseHelpAgentForRequest({
      activeSessionIds: ['help-1'],
      leaseExpiryBySessionId: new Map([['help-1', 900]]),
      maxAgents: 2,
      now: 1000,
    })).toEqual({ action: 'reuse', sessionId: 'help-1' });
  });

  it('spawns a second help-agent when the existing one is still leased and pool is below max', () => {
    expect(chooseHelpAgentForRequest({
      activeSessionIds: ['help-1'],
      leaseExpiryBySessionId: new Map([['help-1', 5000]]),
      maxAgents: 2,
      now: 1000,
    })).toEqual({ action: 'spawn' });
  });

  it('reuses the least-recently-leased help-agent when the pool is saturated', () => {
    expect(chooseHelpAgentForRequest({
      activeSessionIds: ['help-1', 'help-2'],
      leaseExpiryBySessionId: new Map([
        ['help-1', 9000],
        ['help-2', 4000],
      ]),
      maxAgents: 2,
      now: 1000,
    })).toEqual({ action: 'reuse', sessionId: 'help-2', saturated: true });
  });
});
