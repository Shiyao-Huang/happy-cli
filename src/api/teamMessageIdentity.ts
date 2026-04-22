export type TeamMessageIdentityFallback = {
  reason?: string;
  originalFromSessionId?: string;
  originalFromRole?: string;
  originalFromDisplayName?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function getTeamMessageIdentityFallback(message: unknown): TeamMessageIdentityFallback | undefined {
  const record = asRecord(message);
  const metadata = asRecord(record?.metadata);
  const fallback = asRecord(metadata?.identityFallback);
  if (!fallback) {
    return undefined;
  }

  return {
    reason: nonEmptyString(fallback.reason),
    originalFromSessionId: nonEmptyString(fallback.originalFromSessionId),
    originalFromRole: nonEmptyString(fallback.originalFromRole),
    originalFromDisplayName: nonEmptyString(fallback.originalFromDisplayName),
  };
}

export function getOriginalTeamMessageSessionId(message: unknown): string | undefined {
  const record = asRecord(message);
  return nonEmptyString(record?.fromSessionId)
    || getTeamMessageIdentityFallback(message)?.originalFromSessionId;
}

export function getEffectiveTeamMessageRole(message: unknown): string | undefined {
  return getTeamMessageIdentityFallback(message)?.originalFromRole
    || nonEmptyString(asRecord(message)?.fromRole);
}

export function getEffectiveTeamMessageDisplayName(message: unknown): string | undefined {
  return getTeamMessageIdentityFallback(message)?.originalFromDisplayName
    || nonEmptyString(asRecord(message)?.fromDisplayName);
}

export function withTeamMessageIdentityFallback(
  message: Record<string, unknown>,
  reason = 'fromSessionId-forbidden'
): Record<string, unknown> {
  const {
    fromSessionId,
    fromRole,
    fromDisplayName,
    metadata,
    ...rest
  } = message;

  return {
    ...rest,
    fromRole,
    fromDisplayName,
    metadata: {
      ...(asRecord(metadata) ?? {}),
      identityFallback: {
        reason,
        originalFromSessionId: nonEmptyString(fromSessionId),
        originalFromRole: nonEmptyString(fromRole),
        originalFromDisplayName: nonEmptyString(fromDisplayName),
      },
    },
  };
}
