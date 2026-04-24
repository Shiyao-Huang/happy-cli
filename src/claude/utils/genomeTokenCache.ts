/**
 * @module genomeTokenCache
 * @description Shared in-memory cache for the genome-hub JWT token.
 *
 * The token is minted by happy-server (`POST /v1/genome/token`) and verified
 * by genome-hub using its public key. Both `ApiClient.createGenome` and
 * `entityHub` read from this cache so they don't each need their own fetch logic.
 *
 * Call `setGenomeHubToken(token, expiresIn)` after a successful fetch.
 * Call `getGenomeHubToken()` to retrieve (returns null if expired or never set).
 */

let _token: string | null = null;
let _expiresAt = 0; // ms since epoch

/** Store a freshly minted genome token. */
export function setGenomeHubToken(token: string, expiresInS: number): void {
    _token = token;
    // Refresh 5 minutes before actual expiry
    _expiresAt = Date.now() + (expiresInS - 300) * 1000;
}

/** Return cached token if still valid, otherwise null. */
export function getGenomeHubToken(): string | null {
    if (_token && Date.now() < _expiresAt) {
        return _token;
    }
    _token = null;
    _expiresAt = 0;
    return null;
}
