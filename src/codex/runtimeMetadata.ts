import type { Metadata, PermissionMode } from '@/api/types';

export function buildCodexRuntimeMetadata(
    currentMetadata: Metadata,
    args: {
        permissionMode: PermissionMode;
        allowedTools?: string[] | null;
        disallowedTools?: string[] | null;
        updatedAt?: number;
    }
): Metadata {
    const { tools: _staleVisibleTools, ...rest } = currentMetadata;

    return {
        ...rest,
        runtimePermissions: {
            source: 'codex-runtime',
            updatedAt: args.updatedAt ?? Date.now(),
            permissionMode: args.permissionMode,
            allowedTools: args.allowedTools ?? null,
            disallowedTools: args.disallowedTools ?? null,
        },
    };
}
