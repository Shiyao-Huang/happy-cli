import { describe, expect, it } from 'vitest';
import { resolveCreateTaskPolicy } from './taskTools';

describe('resolveCreateTaskPolicy', () => {
    it('allows coordinator roles to create standard tasks with assignees', () => {
        const result = resolveCreateTaskPolicy({
            role: 'master',
            effectiveGenome: null,
            requestedType: 'standard',
            requestedAssigneeId: 'sess-1',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'standard',
            assigneeId: 'sess-1',
        });
    });

    it('denies regular task creation for non-coordinator worker roles', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: null,
            requestedType: 'standard',
        });

        expect(result.allowed).toBe(false);
        expect(result.taskType).toBe('standard');
        expect(result.denyMessage).toContain('cannot create team tasks');
        expect(result.denyMessage).toContain('type="hypothesis"');
    });

    it('allows worker roles to create unassigned hypothesis tasks', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: null,
            requestedType: 'hypothesis',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'hypothesis',
            assigneeId: null,
            labels: ['hypothesis'],
        });
    });

    it('rejects assigneeId on hypothesis tasks even for coordinators', () => {
        const result = resolveCreateTaskPolicy({
            role: 'master',
            effectiveGenome: null,
            requestedType: 'hypothesis',
            requestedAssigneeId: 'sess-2',
        });

        expect(result.allowed).toBe(false);
        expect(result.taskType).toBe('hypothesis');
        expect(result.denyMessage).toContain('must be unassigned');
    });

    it('still honors explicit task.create authority for standard tasks', () => {
        const result = resolveCreateTaskPolicy({
            role: 'implementer',
            effectiveGenome: { authorities: ['task.create'] },
            requestedType: 'standard',
        });

        expect(result).toEqual({
            allowed: true,
            taskType: 'standard',
            assigneeId: null,
        });
    });
});
