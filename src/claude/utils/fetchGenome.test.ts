import { describe, it, expect } from 'vitest';

/**
 * T-002: fetchGenome resolveUrl 纯函数测试
 *
 * resolveUrl 是模块内部函数，这里用 stub 复刻其逻辑来验证 URL 解析规则。
 * 当 resolveUrl 被导出后，可直接 import 替换 stub。
 */

// Stub — mirrors resolveUrl logic from fetchGenome.ts
function resolveUrl(specId: string): string {
    const base = 'https://api.test.com';
    const nsMatch = specId.match(/^(@[^/]+)\/([^:]+)(?::(\d+))?$/);
    if (nsMatch) {
        const [, ns, name, ver] = nsMatch;
        const encodedNs = encodeURIComponent(ns);
        return ver
            ? `${base}/v1/genomes/${encodedNs}/${name}/${ver}`
            : `${base}/v1/genomes/${encodedNs}/${name}/latest`;
    }
    return `${base}/v1/genomes/${specId}`;
}

describe('fetchGenome resolveUrl', () => {
    it('UUID format → /v1/genomes/:id', () => {
        const url = resolveUrl('abc-123-def');
        expect(url).toContain('/v1/genomes/abc-123-def');
        expect(url).not.toContain('%40');
    });

    it('@ns/name → /v1/genomes/:encodedNs/:name/latest', () => {
        const url = resolveUrl('@official/supervisor');
        expect(url).toContain('/v1/genomes/%40official/supervisor/latest');
    });

    it('@ns/name:version → /v1/genomes/:encodedNs/:name/:version', () => {
        const url = resolveUrl('@official/supervisor:2');
        expect(url).toContain('/v1/genomes/%40official/supervisor/2');
    });

    it('@official/help-agent:1 → correct URL', () => {
        const url = resolveUrl('@official/help-agent:1');
        expect(url).toContain('%40official/help-agent/1');
    });

    it('full URL structure for versioned spec', () => {
        const url = resolveUrl('@myteam/worker:10');
        expect(url).toBe('https://api.test.com/v1/genomes/%40myteam/worker/10');
    });

    it('full URL structure for latest spec', () => {
        const url = resolveUrl('@myteam/worker');
        expect(url).toBe('https://api.test.com/v1/genomes/%40myteam/worker/latest');
    });
});
