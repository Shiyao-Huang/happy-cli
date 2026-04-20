import { describe, expect, it } from 'vitest';

import { AGENT_REPLACE_ROLES } from './roleConstants';

describe('AGENT_REPLACE_ROLES', () => {
    it('allows org-manager to hot-swap team agents', () => {
        expect(AGENT_REPLACE_ROLES).toContain('org-manager');
    });
});
