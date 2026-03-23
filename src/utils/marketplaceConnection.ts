export function buildMarketplaceConnectionHint(hubUrl?: string): string {
    const baseUrl = (hubUrl ?? process.env.GENOME_HUB_URL ?? 'http://localhost:3006').replace(/\/$/, '');

    if (/localhost:3006|127\.0\.0\.1:3006/.test(baseUrl)) {
        return `genome-hub is unreachable at ${baseUrl}. If the marketplace is running on another machine, set GENOME_HUB_URL or open an SSH tunnel (example: ssh -L 3006:127.0.0.1:3006 wow).`;
    }

    return `genome-hub is unreachable at ${baseUrl}. Verify the server is up and that GENOME_HUB_URL points to the correct marketplace host.`;
}

export function buildMarketplacePublishAuthHint(status?: number): string {
    if (status === 401 || status === 403) {
        return 'Publishing to genome-hub requires a valid HUB_PUBLISH_KEY. Set HUB_PUBLISH_KEY in your environment or publish through a trusted server-side proxy that injects the key.';
    }

    return 'Verify genome-hub publish credentials and server policy before retrying.';
}
