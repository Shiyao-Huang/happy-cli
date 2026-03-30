/**
 * Tests for tokenPricing module — pricing resolution and cost calculation
 */

import { describe, it, expect } from 'vitest';
import {
    MODEL_PRICING,
    DEFAULT_PRICING,
    resolvePricing,
    calculateCost,
} from './tokenPricing';
import type { TokenUsage, CostBreakdown } from './tokenPricing';

describe('tokenPricing', () => {
    describe('resolvePricing', () => {
        it('returns exact match for known model', () => {
            const pricing = resolvePricing('claude-sonnet-4-6');
            expect(pricing).toBe(MODEL_PRICING['claude-sonnet-4-6']);
        });

        it('returns exact match for opus model', () => {
            const pricing = resolvePricing('claude-opus-4-6');
            expect(pricing.inputPer1M).toBe(15);
            expect(pricing.outputPer1M).toBe(75);
        });

        it('returns exact match for haiku model', () => {
            const pricing = resolvePricing('claude-haiku-4-6');
            expect(pricing.inputPer1M).toBe(0.80);
            expect(pricing.outputPer1M).toBe(4);
        });

        it('resolves prefix match for dated model IDs', () => {
            const pricing = resolvePricing('claude-sonnet-4-20250514');
            expect(pricing.inputPer1M).toBe(3);
            expect(pricing.outputPer1M).toBe(15);
        });

        it('resolves prefix match for opus dated model IDs', () => {
            const pricing = resolvePricing('claude-opus-4-20250514');
            expect(pricing.inputPer1M).toBe(15);
        });

        it('returns DEFAULT_PRICING for unknown model', () => {
            const pricing = resolvePricing('gpt-4o');
            expect(pricing).toBe(DEFAULT_PRICING);
        });

        it('returns DEFAULT_PRICING for null', () => {
            expect(resolvePricing(null)).toBe(DEFAULT_PRICING);
        });

        it('returns DEFAULT_PRICING for undefined', () => {
            expect(resolvePricing(undefined)).toBe(DEFAULT_PRICING);
        });

        it('returns DEFAULT_PRICING for empty string', () => {
            expect(resolvePricing('')).toBe(DEFAULT_PRICING);
        });

        it('returns DEFAULT_PRICING for whitespace-only string', () => {
            expect(resolvePricing('   ')).toBe(DEFAULT_PRICING);
        });

        it('trims whitespace before matching', () => {
            const pricing = resolvePricing('  claude-sonnet-4-6  ');
            expect(pricing).toBe(MODEL_PRICING['claude-sonnet-4-6']);
        });
    });

    describe('calculateCost', () => {
        it('calculates basic input + output cost for sonnet', () => {
            const usage: TokenUsage = {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
            };
            const cost = calculateCost(usage, 'claude-sonnet-4-6');
            // 1M * $3/1M + 1M * $15/1M = $18
            expect(cost.input).toBe(3);
            expect(cost.output).toBe(15);
            expect(cost.total).toBe(18);
            expect(cost.cacheCreation).toBe(0);
            expect(cost.cacheRead).toBe(0);
        });

        it('calculates cost for opus', () => {
            const usage: TokenUsage = {
                input_tokens: 500_000,
                output_tokens: 100_000,
            };
            const cost = calculateCost(usage, 'claude-opus-4-6');
            // 0.5M * $15/1M + 0.1M * $75/1M = $7.5 + $7.5 = $15
            expect(cost.input).toBe(7.5);
            expect(cost.output).toBe(7.5);
            expect(cost.total).toBe(15);
        });

        it('calculates cost for haiku', () => {
            const usage: TokenUsage = {
                input_tokens: 2_000_000,
                output_tokens: 500_000,
            };
            const cost = calculateCost(usage, 'claude-haiku-4-6');
            // 2M * $0.80/1M + 0.5M * $4/1M = $1.60 + $2 = $3.60
            expect(cost.input).toBe(1.6);
            expect(cost.output).toBe(2);
            expect(cost.total).toBe(3.6);
        });

        it('includes cache creation and read costs', () => {
            const usage: TokenUsage = {
                input_tokens: 100_000,
                output_tokens: 50_000,
                cache_creation_input_tokens: 200_000,
                cache_read_input_tokens: 300_000,
            };
            const cost = calculateCost(usage, 'claude-sonnet-4-6');
            // input: 0.1M * $3 = $0.30
            // output: 0.05M * $15 = $0.75
            // cache_creation: 0.2M * $3.75 = $0.75
            // cache_read: 0.3M * $0.3 = $0.09
            expect(cost.input).toBe(0.3);
            expect(cost.output).toBe(0.75);
            expect(cost.cacheCreation).toBe(0.75);
            expect(cost.cacheRead).toBe(0.09);
            expect(cost.total).toBe(1.89);
        });

        it('handles zero tokens', () => {
            const usage: TokenUsage = {
                input_tokens: 0,
                output_tokens: 0,
            };
            const cost = calculateCost(usage, 'claude-sonnet-4-6');
            expect(cost.total).toBe(0);
            expect(cost.input).toBe(0);
            expect(cost.output).toBe(0);
            expect(cost.cacheCreation).toBe(0);
            expect(cost.cacheRead).toBe(0);
        });

        it('uses DEFAULT_PRICING when model is unknown', () => {
            const usage: TokenUsage = {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
            };
            const cost = calculateCost(usage);
            // Default is Sonnet pricing: $3 + $15 = $18
            expect(cost.total).toBe(18);
        });

        it('handles small token counts without floating point issues', () => {
            const usage: TokenUsage = {
                input_tokens: 1,
                output_tokens: 1,
            };
            const cost = calculateCost(usage, 'claude-sonnet-4-6');
            // 1 / 1M * $3 = $0.000003
            // 1 / 1M * $15 = $0.000015
            expect(cost.input).toBe(0.000003);
            expect(cost.output).toBe(0.000015);
            expect(cost.total).toBe(0.000018);
        });

        it('returns CostBreakdown with all required fields', () => {
            const usage: TokenUsage = {
                input_tokens: 100,
                output_tokens: 200,
            };
            const cost = calculateCost(usage, 'claude-sonnet-4-6');
            expect(cost).toHaveProperty('total');
            expect(cost).toHaveProperty('input');
            expect(cost).toHaveProperty('output');
            expect(cost).toHaveProperty('cacheCreation');
            expect(cost).toHaveProperty('cacheRead');
        });
    });
});
