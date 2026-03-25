import { TrackedSession } from './types';

function isStrictClaudeMcpHeartbeatEnabled(value: string | undefined = process.env.AHA_STRICT_CLAUDE_MCP_HEARTBEAT): boolean {
  return value === '1' || value === 'true';
}

export function shouldUsePidHeartbeat(
  session: TrackedSession,
  strictClaudeMcpHeartbeat: boolean = isStrictClaudeMcpHeartbeatEnabled(),
): boolean {
  const flavor = session.ahaSessionMetadataFromLocalWebhook?.flavor;
  const isClaudeLike = flavor !== 'codex' && flavor !== 'open-code';

  if (strictClaudeMcpHeartbeat && isClaudeLike && session.claudeLocalSessionId) {
    return false;
  }

  return true;
}
