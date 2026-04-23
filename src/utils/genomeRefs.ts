export type ParsedGenomeRef = {
    namespace: string;
    name: string;
    version?: number;
};

export function parseGenomeRef(ref: string): ParsedGenomeRef | null {
    const trimmed = ref.trim();
    const match = trimmed.match(/^(@[^/]+)\/(.+?)(?::([1-9]\d*))?$/);
    if (!match) return null;

    return {
        namespace: match[1],
        name: match[2],
        ...(match[3] ? { version: Number(match[3]) } : {}),
    };
}

export function buildGenomeRefPath(
    collection: 'entities' | 'genomes',
    ref: ParsedGenomeRef,
    suffix?: string,
): string {
    const basePath = [
        collection,
        encodeURIComponent(ref.namespace),
        encodeURIComponent(ref.name),
        ...(ref.version ? [String(ref.version)] : []),
    ].join('/');
    return suffix ? `/${basePath}/${suffix.replace(/^\/+/, '')}` : `/${basePath}`;
}
