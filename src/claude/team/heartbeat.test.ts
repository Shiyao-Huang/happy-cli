import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AgentHeartbeat } from './heartbeat';

describe('AgentHeartbeat', () => {
    let hb: AgentHeartbeat;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        hb?.stopMonitoring();
        vi.useRealTimers();
    });

    describe('ping and status transitions', () => {
        it('should register agent as alive after ping', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder', ['task-1']);

            const all = hb.getAllAgents();
            expect(all).toHaveLength(1);
            expect(all[0].agentId).toBe('session-1');
            expect(all[0].role).toBe('builder');
            expect(all[0].status).toBe('alive');
            expect(all[0].assignedTasks).toEqual(['task-1']);
        });

        it('should transition to suspect after suspectMs', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');

            vi.advanceTimersByTime(46_000); // past 45s suspect threshold

            const all = hb.getAllAgents();
            expect(all[0].status).toBe('suspect');
        });

        it('should transition to dead after timeoutMs', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');

            vi.advanceTimersByTime(61_000); // past 60s dead threshold

            const all = hb.getAllAgents();
            expect(all[0].status).toBe('dead');
        });

        it('should reset to alive after re-ping', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');

            vi.advanceTimersByTime(50_000); // suspect
            expect(hb.getAllAgents()[0].status).toBe('suspect');

            hb.ping('session-1', 'builder'); // re-ping
            expect(hb.getAllAgents()[0].status).toBe('alive');
        });

        it('should preserve existing tasks when re-ping has empty tasks', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder', ['task-1', 'task-2']);
            hb.ping('session-1', 'builder'); // no tasks

            const all = hb.getAllAgents();
            expect(all[0].assignedTasks).toEqual(['task-1', 'task-2']);
        });
    });

    describe('getDeadAgents', () => {
        it('should return empty when all agents alive', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');
            hb.ping('session-2', 'supervisor');

            expect(hb.getDeadAgents()).toHaveLength(0);
        });

        it('should return dead agents with orphaned tasks', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder', ['task-1', 'task-2']);

            vi.advanceTimersByTime(61_000);

            const dead = hb.getDeadAgents();
            expect(dead).toHaveLength(1);
            expect(dead[0].agentId).toBe('session-1');
            expect(dead[0].orphanedTasks).toEqual(['task-1', 'task-2']);
            expect(dead[0].deadForMs).toBeGreaterThan(60_000);
        });
    });

    describe('getSuspectAgents', () => {
        it('should return agents in suspect window', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');
            hb.ping('session-2', 'supervisor');

            vi.advanceTimersByTime(50_000); // both suspect

            expect(hb.getSuspectAgents()).toHaveLength(2);
        });

        it('should not include dead agents', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');

            vi.advanceTimersByTime(61_000); // dead, not suspect

            expect(hb.getSuspectAgents()).toHaveLength(0);
            expect(hb.getDeadAgents()).toHaveLength(1);
        });
    });

    describe('removeAgent', () => {
        it('should return orphaned tasks and remove agent', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder', ['task-1']);

            const orphaned = hb.removeAgent('session-1');
            expect(orphaned).toEqual(['task-1']);
            expect(hb.getAllAgents()).toHaveLength(0);
        });

        it('should return empty array for non-existent agent', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            const orphaned = hb.removeAgent('non-existent');
            expect(orphaned).toEqual([]);
        });
    });

    describe('monitoring callback', () => {
        it('should invoke dead agent callback on transition', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            const callback = vi.fn();
            hb.onDeadAgent(callback);
            hb.startMonitoring(10_000);

            hb.ping('session-1', 'builder', ['task-1']);

            vi.advanceTimersByTime(61_000); // dead
            vi.advanceTimersByTime(10_000); // monitoring tick

            expect(callback).toHaveBeenCalledTimes(1);
            expect(callback).toHaveBeenCalledWith(expect.objectContaining({
                agentId: 'session-1',
                role: 'builder',
                orphanedTasks: ['task-1'],
            }));
        });

        it('should NOT invoke callback twice for same dead agent', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            const callback = vi.fn();
            hb.onDeadAgent(callback);
            hb.startMonitoring(10_000);

            hb.ping('session-1', 'builder');

            vi.advanceTimersByTime(61_000); // dead
            vi.advanceTimersByTime(10_000); // first tick — callback fires
            vi.advanceTimersByTime(10_000); // second tick — should NOT fire again

            expect(callback).toHaveBeenCalledTimes(1);
        });
    });

    describe('getSummary', () => {
        it('should return summary string', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');
            hb.ping('session-2', 'supervisor');

            expect(hb.getSummary()).toBe('Agents: 2 alive, 0 suspect, 0 dead (2 total)');
        });

        it('should return no agents message when empty', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            expect(hb.getSummary()).toBe('No agents tracked');
        });

        it('should show mixed states', () => {
            hb = new AgentHeartbeat(60_000, 45_000);
            hb.ping('session-1', 'builder');

            // Make session-2 suspect
            hb.ping('session-2', 'supervisor');
            vi.advanceTimersByTime(46_000);

            // session-1 re-ping to keep alive
            hb.ping('session-1', 'builder');

            expect(hb.getSummary()).toBe('Agents: 1 alive, 1 suspect, 0 dead (2 total)');
        });
    });

    describe('multiple teams isolation', () => {
        it('should track agents independently per instance', () => {
            const team1 = new AgentHeartbeat(60_000, 45_000);
            const team2 = new AgentHeartbeat(60_000, 45_000);

            team1.ping('session-1', 'builder');
            team2.ping('session-2', 'supervisor');

            expect(team1.getAllAgents()).toHaveLength(1);
            expect(team2.getAllAgents()).toHaveLength(1);
            expect(team1.getAllAgents()[0].agentId).toBe('session-1');
            expect(team2.getAllAgents()[0].agentId).toBe('session-2');

            team1.stopMonitoring();
            team2.stopMonitoring();
        });
    });
});
