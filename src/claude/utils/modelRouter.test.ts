import { describe, it, expect, beforeEach } from 'vitest';
import { resolveModel, setModelRouteRules, resetModelRouteRules } from './modelRouter';

describe('modelRouter', () => {
    beforeEach(() => resetModelRouteRules());

    it('bypass role resolves to opus by default', () => {
        const result = resolveModel({ executionPlane: 'bypass' });
        expect(result.provider).toBe('anthropic');
        expect(result.modelId).toBe('claude-opus-4-6');
        expect(result.isSupported).toBe(true);
    });

    it('mainline worker resolves to sonnet by default', () => {
        const result = resolveModel({ executionPlane: 'mainline', role: 'implementer' });
        expect(result.provider).toBe('anthropic');
        expect(result.modelId).toBe('claude-sonnet-4-6');
    });

    it('org-manager resolves to opus', () => {
        const result = resolveModel({ role: 'org-manager', executionPlane: 'mainline' });
        expect(result.provider).toBe('anthropic');
        expect(result.modelId).toBe('claude-opus-4-6');
    });

    it('genome modelId takes highest priority', () => {
        const result = resolveModel({ executionPlane: 'bypass', genomeModelId: 'claude-haiku-4-6' });
        expect(result.modelId).toBe('claude-haiku-4-6');
        expect(result.isSupported).toBe(true);
    });

    it('unsupported provider falls back to anthropic', () => {
        const result = resolveModel({
            genomeModelId: 'glm-4',
            genomeModelProvider: 'zhipu',
        });
        expect(result.provider).toBe('anthropic');
        expect(result.modelId).toBe('claude-sonnet-4-6');
        expect(result.isSupported).toBe(false);
    });

    it('custom KV rules override defaults', () => {
        setModelRouteRules({
            version: 1,
            rules: [{ match: { role: 'implementer' }, provider: 'anthropic', modelId: 'claude-opus-4-6', priority: 1 }],
        });
        const result = resolveModel({ role: 'implementer', executionPlane: 'mainline' });
        expect(result.modelId).toBe('claude-opus-4-6');
    });
});
