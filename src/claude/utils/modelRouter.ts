/**
 * modelRouter — resolves target model based on role/task type/genome config.
 *
 * Priority:
 *   1. genome spec modelId (most specific)
 *   2. user KV config rules
 *   3. built-in default rules
 */
import { logger } from '@/ui/logger';
import type {
    ModelRouteContext,
    ModelRouteRule,
    ResolvedModel,
    ModelRouteConfig,
} from '@/api/types/modelRoute';
import { DEFAULT_MODEL_RULES } from '@/api/types/modelRoute';

/** Process-level KV rule cache (loaded once at startup) */
let _cachedRules: ModelRouteRule[] | null = null;

/** Inject user-defined rules (called during runClaude startup) */
export function setModelRouteRules(config: ModelRouteConfig): void {
    _cachedRules = [...config.rules].sort((a, b) => a.priority - b.priority);
    logger.debug(`[modelRouter] Loaded ${_cachedRules.length} custom rules`);
}

/** Reset cache (for testing) */
export function resetModelRouteRules(): void {
    _cachedRules = null;
}

function ruleMatches(rule: ModelRouteRule, ctx: ModelRouteContext): boolean {
    const m = rule.match;
    if (m.role && m.role !== ctx.role) return false;
    if (m.executionPlane && m.executionPlane !== ctx.executionPlane) return false;
    if (m.taskType && m.taskType !== ctx.taskType) return false;
    if (m.category && m.category !== ctx.category) return false;
    return true;
}

const SUPPORTED_PROVIDERS = new Set(['anthropic']);
const FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Resolve the final model to use.
 *
 * When provider is not anthropic (e.g. zhipu/GLM):
 * - Logs a warning
 * - Falls back to anthropic + fallback model
 * - Sets ResolvedModel.isSupported=false for upstream decision-making
 */
export function resolveModel(ctx: ModelRouteContext): ResolvedModel {
    // 1. Genome spec directly specifies modelId
    if (ctx.genomeModelId) {
        const provider = (ctx.genomeModelProvider ?? 'anthropic') as ResolvedModel['provider'];
        const isSupported = SUPPORTED_PROVIDERS.has(provider);
        if (!isSupported) {
            logger.debug(
                `[modelRouter] Provider "${provider}" not yet supported. ` +
                `Falling back to anthropic/${FALLBACK_MODEL}. ` +
                `(genome requested: ${provider}/${ctx.genomeModelId})`
            );
        }
        return {
            provider: isSupported ? provider : 'anthropic',
            modelId: isSupported ? ctx.genomeModelId : FALLBACK_MODEL,
            isSupported,
            fallbackModelId: isSupported ? undefined : FALLBACK_MODEL,
        };
    }

    // 2. User KV rules (sorted by priority)
    const rules = _cachedRules ?? [...DEFAULT_MODEL_RULES].sort((a, b) => a.priority - b.priority);
    for (const rule of rules) {
        if (ruleMatches(rule, ctx)) {
            const isSupported = SUPPORTED_PROVIDERS.has(rule.provider);
            return {
                provider: isSupported ? rule.provider : 'anthropic',
                modelId: isSupported ? rule.modelId : FALLBACK_MODEL,
                isSupported,
                fallbackModelId: isSupported ? undefined : FALLBACK_MODEL,
            };
        }
    }

    // 3. Ultimate fallback
    return { provider: 'anthropic', modelId: FALLBACK_MODEL, isSupported: true };
}
