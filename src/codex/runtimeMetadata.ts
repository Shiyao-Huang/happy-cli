import type { Metadata, PermissionMode } from '@/api/types';

export function buildCodexRuntimeMetadata(
    currentMetadata: Metadata,
    args: {
        permissionMode: PermissionMode;
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
        },
    };
}
