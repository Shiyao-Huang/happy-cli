export interface HelpAgentPoolDecision {
  action: 'spawn' | 'reuse';
  sessionId?: string;
  saturated?: boolean;
}

export function chooseHelpAgentForRequest(args: {
  activeSessionIds: string[];
  leaseExpiryBySessionId: Map<string, number>;
  maxAgents: number;
  now?: number;
}): HelpAgentPoolDecision {
  const { activeSessionIds, leaseExpiryBySessionId, maxAgents } = args;
  const now = args.now ?? Date.now();

  if (activeSessionIds.length === 0) {
    return { action: 'spawn' };
  }

  const idleCandidates = activeSessionIds.filter((sessionId) => {
    const leaseExpiry = leaseExpiryBySessionId.get(sessionId) ?? 0;
    return leaseExpiry <= now;
  });

  if (idleCandidates.length > 0) {
    return { action: 'reuse', sessionId: idleCandidates[0] };
  }

  if (activeSessionIds.length < maxAgents) {
    return { action: 'spawn' };
  }

  const leastRecentlyLeased = [...activeSessionIds].sort((left, right) => {
    const leftLease = leaseExpiryBySessionId.get(left) ?? 0;
    const rightLease = leaseExpiryBySessionId.get(right) ?? 0;
    return leftLease - rightLease;
  })[0];

  return {
    action: 'reuse',
    sessionId: leastRecentlyLeased,
    saturated: true,
  };
}
