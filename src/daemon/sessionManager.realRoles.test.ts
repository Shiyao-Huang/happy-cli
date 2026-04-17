import { describe, expect, it } from 'vitest';
import { isEvaluableRole, hasRespawnPriority, EVALUABLE_ROLES, RESPAWN_PRIORITY_ROLES } from './sessionManager';

const GENOME_HUB_URL = process.env.GENOME_HUB_URL || 'http://localhost:3006';

const isHubReachable = await (async () => {
    try {
        const r = await fetch(`${GENOME_HUB_URL}/genomes?limit=1`);
        return r.ok;
    } catch { return false; }
})();

describe.skipIf(!isHubReachable)('role classification against real genome-hub agents', () => {
    it('all @official agent roles are correctly classified', async () => {
        const res = await fetch(`${GENOME_HUB_URL}/genomes?namespace=%40official&limit=50`);
        const { genomes } = await res.json() as any;

        const agentGenomes = genomes.filter((g: any) => g.kind !== 'legion');
        expect(agentGenomes.length).toBeGreaterThan(5);

        for (const g of agentGenomes) {
            const spec = typeof g.spec === 'string' ? JSON.parse(g.spec) : g.spec;
            const role = spec.baseRoleId || g.name;

            if (role === 'supervisor' || role === 'help-agent') {
                expect(isEvaluableRole(role), `${role} should be evaluable`).toBe(true);
                expect(hasRespawnPriority(role), `${role} should NOT have respawn priority`).toBe(false);
            } else if (role === 'master') {
                expect(isEvaluableRole(role), `master should NOT be evaluable`).toBe(false);
                expect(hasRespawnPriority(role), `master should have respawn priority`).toBe(true);
            } else {
                expect(isEvaluableRole(role), `${role} should NOT be evaluable`).toBe(false);
            }
        }
    });

    it('evaluable roles do not overlap with priority roles', () => {
        for (const role of EVALUABLE_ROLES) {
            expect(RESPAWN_PRIORITY_ROLES.has(role), `${role} in both sets`).toBe(false);
        }
        for (const role of RESPAWN_PRIORITY_ROLES) {
            expect(EVALUABLE_ROLES.has(role), `${role} in both sets`).toBe(false);
        }
    });
});
