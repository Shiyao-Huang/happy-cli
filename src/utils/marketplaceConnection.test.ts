import { describe, expect, it } from 'vitest';
import { buildMarketplaceConnectionHint, buildMarketplacePublishAuthHint } from './marketplaceConnection';

describe('buildMarketplaceConnectionHint', () => {
    it('suggests SSH tunneling for the default local genome-hub endpoint', () => {
        const hint = buildMarketplaceConnectionHint('http://localhost:3006');
        expect(hint).toContain('ssh -L 3006:127.0.0.1:3006');
        expect(hint).toContain('GENOME_HUB_SSH_HOST');
        expect(hint).not.toContain('wow');
    });

    it('suggests verifying GENOME_HUB_URL for remote endpoints', () => {
        expect(buildMarketplaceConnectionHint('https://market.example.com')).toContain('GENOME_HUB_URL');
    });

    it('explains publish-key failures for 401/403 responses', () => {
        expect(buildMarketplacePublishAuthHint(401)).toContain('HUB_PUBLISH_KEY');
        expect(buildMarketplacePublishAuthHint(403)).toContain('HUB_PUBLISH_KEY');
    });
});
