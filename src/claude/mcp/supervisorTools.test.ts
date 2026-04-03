import { describe, expect, it } from 'vitest';
import { resolveEntityNsName, buildVerdictContent } from './supervisorTools';

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
