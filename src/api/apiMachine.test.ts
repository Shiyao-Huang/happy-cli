import { describe, expect, it } from 'vitest';

import { classifyMachineUpdate } from './apiMachine';

describe('classifyMachineUpdate', () => {
    it('applies update-machine events for the current machine', () => {
        expect(
            classifyMachineUpdate({
                body: {
                    t: 'update-machine',
                    machineId: 'machine-1'
                }
            }, 'machine-1')
        ).toBe('apply-machine-update');
    });

    it('ignores update-machine events for other machines', () => {
        expect(
            classifyMachineUpdate({
                body: {
                    t: 'update-machine',
                    machineId: 'machine-2'
                }
            }, 'machine-1')
        ).toBe('ignore');
    });

    it('ignores non-machine updates that a daemon connection can receive', () => {
        expect(classifyMachineUpdate({ body: { t: 'team-update' } }, 'machine-1')).toBe('ignore');
        expect(classifyMachineUpdate({ body: { t: 'team-message' } }, 'machine-1')).toBe('ignore');
        expect(classifyMachineUpdate({ body: { t: 'task-updated' } }, 'machine-1')).toBe('ignore');
    });

    it('keeps logging truly unknown update types', () => {
        expect(classifyMachineUpdate({ body: { t: 'future-update-type' } }, 'machine-1')).toBe('unknown');
    });
});
