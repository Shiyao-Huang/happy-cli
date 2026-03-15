/**
 * GenomeSpec — the schema that fully describes a reusable agent.
 *
 * A Genome stored on the server contains a JSON-serialised GenomeSpec in its
 * `spec` field.  When the daemon spawns an agent with a `specId`, the CLI
 * fetches the corresponding Genome, deserialises GenomeSpec, and uses it to
 * configure the Claude session — overriding the compile-time defaults that
 * live in roles.config.ts and runClaude.ts.
 *
 * Think of this as the "Dockerfile" for an agent:
 *   Genome (server record)  =  Docker image
 *   Running session         =  Docker container
 *   /v1/genomes (public)    =  Docker Hub
 */
export interface GenomeSpec {
    // ── Identity ──────────────────────────────────────────────────────────────
    /** Human-readable label shown in UI / logs */
    displayName?: string;
    /** One-liner purpose description */
    description?: string;
    /**
     * Built-in role ID to extend (e.g. "supervisor", "implementer").
     * When set, the genome *overrides* the built-in role rather than replacing it.
     * Fields present in GenomeSpec take precedence; missing fields fall back to
     * the built-in role defaults.
     */
    baseRoleId?: string;

    // ── Prompt ────────────────────────────────────────────────────────────────
    /** Full system / instruction prompt for the agent. Replaces compiled prompt. */
    systemPrompt?: string;
    /**
     * Extra context appended AFTER the main system prompt.
     * Useful for injecting domain knowledge without rewriting the full prompt.
     */
    systemPromptSuffix?: string;

    // ── Model ─────────────────────────────────────────────────────────────────
    /** Claude model ID, e.g. "claude-sonnet-4-6" or "claude-opus-4-6" */
    modelId?: string;
    /** Sampling temperature (0–1) */
    temperature?: number;

    // ── Tool access ───────────────────────────────────────────────────────────
    /**
     * Explicit allowlist.  When set, the agent may ONLY use these tools.
     * Takes precedence over disallowedTools.
     */
    allowedTools?: string[];
    /** Tools the agent must NOT use even if otherwise accessible. */
    disallowedTools?: string[];

    // ── Permissions ───────────────────────────────────────────────────────────
    /** Claude Code permission mode */
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions';
    /** Simplified access tier (drives default tool restrictions) */
    accessLevel?: 'read-only' | 'full-access';

    // ── Execution ─────────────────────────────────────────────────────────────
    /** Hard cap on turns before the agent auto-stops */
    maxTurns?: number;
    /** Which execution plane the agent runs in */
    executionPlane?: 'mainline' | 'bypass';

    // ── Capabilities (declarative, for display / routing) ────────────────────
    /**
     * Free-text list of what this agent can do.
     * Used for UI display and for org-manager routing decisions.
     */
    capabilities?: string[];
}

/** Full Genome record as returned by the server */
export interface Genome {
    id: string;
    accountId: string;
    name: string;
    description?: string | null;
    spec: string;           // JSON-serialised GenomeSpec
    parentSessionId: string;
    teamId?: string | null;
    spawnCount: number;
    lastSpawnedAt?: string | null;
    isPublic: boolean;
    createdAt: string;
    updatedAt: string;
}

/** Parse and validate the spec field of a Genome record. */
export function parseGenomeSpec(genome: Genome): GenomeSpec {
    return JSON.parse(genome.spec) as GenomeSpec;
}
