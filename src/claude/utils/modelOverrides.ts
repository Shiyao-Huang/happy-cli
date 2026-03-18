import type { Metadata } from '@/api/types';

export function resolveInitialModelOverrides(
    metadata: Pick<Metadata, 'modelOverride' | 'fallbackModelOverride'> | null | undefined,
    cliModel?: string,
): { model: string | undefined; fallbackModel: string | undefined } {
    return {
        model: cliModel || metadata?.modelOverride,
        fallbackModel: metadata?.fallbackModelOverride,
    };
}
