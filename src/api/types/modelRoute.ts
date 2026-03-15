/**
 * ModelRouteConfig — task-aware model routing configuration.
 *
 * Stored in server KV: key = "config.model-routes"
 * Users can override each rule via UI without CLI release.
 *
 * Routing priority (high → low):
 *   1. GenomeSpec.modelId (most specific, genome-level override)
 *   2. KV config.model-routes rules (user-defined)
 *   3. Built-in default rules (bypass=opus, mainline-worker=sonnet)
 */

export interface ModelRouteRule {
    /** Match conditions (AND relationship; empty object = match all) */
    match: {
        role?: string;               // e.g. "supervisor", "org-manager"
        executionPlane?: 'bypass' | 'mainline';
        taskType?: 'plan' | 'execute' | 'review' | 'support';
        category?: string;           // genome category
    };
    /** Target provider */
    provider: 'anthropic' | 'zhipu' | 'openai' | 'local';
    /** Provider-specific model ID */
    modelId: string;
    /** Priority (lower number = higher priority) */
    priority: number;
}

export interface ModelRouteConfig {
    version: number;
    rules: ModelRouteRule[];
}

/** Resolved routing result */
export interface ResolvedModel {
    provider: 'anthropic' | 'zhipu' | 'openai' | 'local';
    modelId: string;
    /** Whether the provider is currently fully supported */
    isSupported: boolean;
    /** Fallback model if provider is unsupported */
    fallbackModelId?: string;
}

/** Context passed to the router for resolution */
export interface ModelRouteContext {
    role?: string;
    executionPlane?: 'bypass' | 'mainline';
    taskType?: 'plan' | 'execute' | 'review' | 'support';
    category?: string;
    /** modelId specified in GenomeSpec (highest priority) */
    genomeModelId?: string;
    /** provider specified in GenomeSpec */
    genomeModelProvider?: string;
}

/** Built-in default rules (used when KV has no configuration) */
export const DEFAULT_MODEL_RULES: ModelRouteRule[] = [
    // bypass roles (supervisor/help-agent) → opus
    {
        match: { executionPlane: 'bypass' },
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        priority: 10,
    },
    // org-manager / architect / orchestrator → opus (high-quality planning)
    {
        match: { role: 'org-manager' },
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        priority: 10,
    },
    {
        match: { role: 'orchestrator' },
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        priority: 10,
    },
    // other mainline roles (implementer/worker) → sonnet (cost-effective)
    {
        match: { executionPlane: 'mainline' },
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        priority: 20,
    },
    // ultimate fallback
    {
        match: {},
        provider: 'anthropic',
        modelId: 'claude-sonnet-4-6',
        priority: 100,
    },
];
