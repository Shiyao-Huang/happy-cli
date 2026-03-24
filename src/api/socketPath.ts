/**
 * Build a socket.io path that respects server base paths.
 * Example: https://aha-agi.com/api + /v1/updates => /api/v1/updates
 */
export function buildSocketPath(serverUrl: string, suffix: string): string {
  try {
    const parsed = new URL(serverUrl);
    const basePath = parsed.pathname.replace(/\/+$/, '');
    const combined = `${basePath}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
    return combined.replace(/\/{2,}/g, '/');
  } catch {
    return suffix;
  }
}
