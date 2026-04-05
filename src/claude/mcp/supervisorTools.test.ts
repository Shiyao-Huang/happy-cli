import { describe, expect, it, vi } from 'vitest';
import {
    buildVisibleToolsPayload,
    resolveEntityNsName,
    buildVerdictContent,
    writeRetireHandoffTaskComments,
    type RetireHandoffTaskApi,
} from './supervisorTools';

describe('resolveEntityNsName', () => {
    it('returns explicit namespace and name when both are provided', () => {
        const result = resolveEntityNsName('@myorg', 'scout', undefined);
        expect(result).toEqual({ ns: '@myorg', name: 'scout' });
    });

    it('prefers explicit params over specRef when both are available', () => {
        const result = resolveEntityNsName('@myorg', 'scout', '@other/builder:v3');
        expect(result).toEqual({ ns: '@myorg', name: 'scout' });
    });

    it('parses specRef with @ prefix and version', () => {
        const result = resolveEntityNsName(undefined, undefined, '@official/supervisor:v2');
        expect(result).toEqual({ ns: '@official', name: 'supervisor' });
    });

    it('parses specRef with @ prefix and no version', () => {
        const result = resolveEntityNsName(undefined, undefined, '@official/supervisor');
        expect(result).toEqual({ ns: '@official', name: 'supervisor' });
    });

    it('parses specRef without @ prefix (adds @ to namespace)', () => {
        const result = resolveEntityNsName(undefined, undefined, 'official/supervisor:v1');
        expect(result).toEqual({ ns: '@official', name: 'supervisor' });
    });

    it('returns null when specRef is empty string', () => {
        const result = resolveEntityNsName(undefined, undefined, '');
        expect(result).toBeNull();
    });

    it('returns null when specRef is undefined and explicit params missing', () => {
        const result = resolveEntityNsName(undefined, undefined, undefined);
        expect(result).toBeNull();
    });

    it('returns null when only specNamespace is provided (no specName)', () => {
        const result = resolveEntityNsName('@myorg', undefined, undefined);
        expect(result).toBeNull();
    });

    it('returns null when only specName is provided (no specNamespace)', () => {
        const result = resolveEntityNsName(undefined, 'scout', undefined);
        expect(result).toBeNull();
    });

    it('returns null for malformed specRef without slash', () => {
        const result = resolveEntityNsName(undefined, undefined, 'justname');
        expect(result).toBeNull();
    });

    it('handles specRef with complex name containing dashes', () => {
        const result = resolveEntityNsName(undefined, undefined, '@my-org/agent-builder:v3.1');
        expect(result).toEqual({ ns: '@my-org', name: 'agent-builder' });
    });
});

describe('buildVerdictContent', () => {
    const baseDimensions = {
        delivery: 80,
        integrity: 90,
        efficiency: 70,
        collaboration: 85,
        reliability: 75,
    };

    it('builds content with all fields including recommendations', () => {
        const content = buildVerdictContent({
            role: 'scout',
            sessionId: 'sess-123',
            overall: 82,
            action: 'keep',
            dimensions: baseDimensions,
            recommendations: ['improve delivery', 'add tests'],
        });

        expect(content).toContain('Role: scout, Session: sess-123');
        expect(content).toContain('Overall: 82/100, Action: keep');
        expect(content).toContain('delivery=80');
        expect(content).toContain('integrity=90');
        expect(content).toContain('efficiency=70');
        expect(content).toContain('collaboration=85');
        expect(content).toContain('reliability=75');
        expect(content).toContain('Recommendations: improve delivery; add tests');
    });

    it('omits recommendations line when array is empty', () => {
        const content = buildVerdictContent({
            role: 'builder',
            sessionId: 'sess-456',
            overall: 45,
            action: 'retire',
            dimensions: baseDimensions,
            recommendations: [],
        });

        expect(content).not.toContain('Recommendations');
        const lines = content.split('\n');
        expect(lines).toHaveLength(3);
    });

    it('omits recommendations line when undefined', () => {
        const content = buildVerdictContent({
            role: 'builder',
            sessionId: 'sess-789',
            overall: 60,
            action: 'keep',
            dimensions: baseDimensions,
        });

        expect(content).not.toContain('Recommendations');
        const lines = content.split('\n');
        expect(lines).toHaveLength(3);
    });

    it('formats dimensions on a single line in correct order', () => {
        const content = buildVerdictContent({
            role: 'supervisor',
            sessionId: 'sess-abc',
            overall: 100,
            action: 'keep',
            dimensions: {
                delivery: 100,
                integrity: 100,
                efficiency: 100,
                collaboration: 100,
                reliability: 100,
            },
        });

        const dimLine = content.split('\n')[2];
        expect(dimLine).toBe(
            'Dimensions: delivery=100 integrity=100 efficiency=100 collaboration=100 reliability=100',
        );
    });
});

describe('buildVisibleToolsPayload', () => {
    it('preserves unknown visible inventory instead of collapsing it to an empty list', () => {
        const payload = buildVisibleToolsPayload({
            sessionId: 'sess-unknown',
            snapshot: {
                permissionMode: 'bypassPermissions',
                allowedTools: null,
                deniedTools: null,
                visibleTools: null,
                visibleEntries: [],
                hiddenTools: null,
                allowlistKnown: false,
                denylistKnown: false,
                visibleInventoryKnown: false,
                warnings: ['Visible tool inventory unavailable in session metadata.'],
            },
        });

        expect(payload).toEqual({
            sessionId: 'sess-unknown',
            total: null,
            cursor: 0,
            limit: 50,
            nextCursor: null,
            includeAll: true,
            visibleInventoryKnown: false,
            tools: null,
            warnings: ['Visible tool inventory unavailable in session metadata.'],
        });
    });

    it('filters and paginates visible tools when the inventory is known', () => {
        const payload = buildVisibleToolsPayload({
            sessionId: 'sess-known',
            includeAll: false,
            cursor: 0,
            limit: 1,
            snapshot: {
                permissionMode: 'acceptEdits',
                allowedTools: ['get_self_view'],
                deniedTools: [],
                visibleTools: ['Bash', 'get_self_view'],
                visibleEntries: [
                    { rawName: 'Bash', name: 'Bash', surface: 'native' },
                    { rawName: 'mcp__aha__get_self_view', name: 'get_self_view', surface: 'mcp' },
                ],
                hiddenTools: [],
                allowlistKnown: true,
                denylistKnown: true,
                visibleInventoryKnown: true,
                warnings: [],
            },
        });

        expect(payload).toEqual({
            sessionId: 'sess-known',
            total: 1,
            cursor: 0,
            limit: 1,
            nextCursor: null,
            includeAll: false,
            visibleInventoryKnown: true,
            tools: [
                { rawName: 'mcp__aha__get_self_view', name: 'get_self_view', surface: 'mcp' },
            ],
            warnings: [],
        });
    });
});

describe('writeRetireHandoffTaskComments', () => {
    it('writes a handoff comment to every in-progress task for the retiring session', async () => {
        const api: RetireHandoffTaskApi = {
            listTasks: vi.fn().mockResolvedValue({
                tasks: [{ id: 'task-1' }, { id: 'task-2' }],
                version: 1,
            }),
            addTaskComment: vi.fn().mockResolvedValue({ success: true }),
        };

        const result = await writeRetireHandoffTaskComments({
            api,
            teamId: 'team-1',
            sessionId: 'sess-1',
            role: 'implementer',
            displayName: 'Implementer',
            handoffNote: 'Continue from checkpoint B.',
        });

        expect(api.listTasks).toHaveBeenCalledWith('team-1', {
            assigneeId: 'sess-1',
            status: 'in-progress',
        });
        expect(api.addTaskComment).toHaveBeenNthCalledWith(1, 'team-1', 'task-1', {
            sessionId: 'sess-1',
            role: 'implementer',
            displayName: 'Implementer',
            type: 'handoff',
            content: 'Continue from checkpoint B.',
        });
        expect(api.addTaskComment).toHaveBeenNthCalledWith(2, 'team-1', 'task-2', {
            sessionId: 'sess-1',
            role: 'implementer',
            displayName: 'Implementer',
            type: 'handoff',
            content: 'Continue from checkpoint B.',
        });
        expect(result).toEqual(['task-1', 'task-2']);
    });

    it('continues writing handoff comments when one task write fails', async () => {
        const api: RetireHandoffTaskApi = {
            listTasks: vi.fn().mockResolvedValue({
                tasks: [{ id: 'task-1' }, { id: 'task-2' }],
                version: 1,
            }),
            addTaskComment: vi.fn()
                .mockRejectedValueOnce(new Error('task-1 unavailable'))
                .mockResolvedValueOnce({ success: true }),
        };

        const result = await writeRetireHandoffTaskComments({
            api,
            teamId: 'team-1',
            sessionId: 'sess-1',
            role: 'implementer',
            displayName: 'Implementer',
            handoffNote: 'Resume after test harness fix.',
        });

        expect(api.addTaskComment).toHaveBeenCalledTimes(2);
        expect(result).toEqual(['task-2']);
    });

    it('returns an empty list without touching the API when team context is missing', async () => {
        const api: RetireHandoffTaskApi = {
            listTasks: vi.fn(),
            addTaskComment: vi.fn(),
        };

        const result = await writeRetireHandoffTaskComments({
            api,
            teamId: undefined,
            sessionId: 'sess-1',
            handoffNote: 'No team context available.',
        });

        expect(result).toEqual([]);
        expect(api.listTasks).not.toHaveBeenCalled();
        expect(api.addTaskComment).not.toHaveBeenCalled();
    });
});
