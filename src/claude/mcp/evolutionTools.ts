/**
 * @module evolutionTools
 * @description MCP tool registrations for help request and genome creation (evolution system).
 *
 * ```mermaid
 * graph LR
 *   A[evolutionTools] -->|ctx.mcp| B[McpServer]
 *   A -->|ctx.api| C[ApiClient]
 *   A -->|ctx.client| D[ApiSessionClient]
 *   A -->|ctx.triggerHelpLane| E[helpLane]
 * ```
 *
 * ## Tools registered
 * - request_help, create_genome, create_corps, update_genome
 *
 * ## Design
 * - All tools share McpToolContext (see mcpContext.ts)
 * - request_help is available to ALL agents and directly calls triggerHelpLane
 * - create_genome validates and sanitizes spec before delegating to api.createGenome
 * - create_corps publishes a CorpsSpec team template directly to genome-hub /corps
 * - update_genome patches marketing metadata (description/tags/category) for an owned genome
 * - Non-@official genomes have hooks/permissionMode/executionPlane stripped at write time
 */

import { z } from "zod";
import { emitTraceEvent, emitTraceLink } from '@/trace/traceEmitter';
import { TraceEventKind } from '@/trace/traceTypes';
import { McpToolContext } from './mcpContext';
import { normalizeGenomeSpecForPublication } from '@/utils/genomePublication';

export function registerEvolutionTools(ctx: McpToolContext): void {
    const {
        mcp,
        api,
        client,
        triggerHelpLane,
    } = ctx;

    // ========== Request Help Tool (ALL agents) ==========

    mcp.registerTool('request_help', {
        description: `Request help from the supervisor system. Call this when you are stuck, encountering errors, running low on context, or need a collaborator.

The help request will be logged and may trigger a help-agent to assist you. Common scenarios:
- You've been stuck on a task for multiple attempts
- You're getting repeated errors you can't resolve
- Your context window is getting full (you notice degraded performance)
- You need a role/skill that doesn't exist on the team yet

The supervisor will see your request and may: send you guidance, compact your context, restart your session, or spawn a helper agent.`,
        title: 'Request Help',
        inputSchema: {
            type: z.enum(['stuck', 'context_overflow', 'need_collaborator', 'error', 'custom']).describe('Type of help needed'),
            description: z.string().describe('Detailed description of the problem and what you have tried'),
            severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium').describe('Urgency level'),
            taskId: z.string().optional().describe('Related task ID if applicable'),
        },
    }, async (args) => {
        try {
            const metadata = client.getMetadata();
            const teamId = metadata?.teamId || metadata?.roomId;
            const role = metadata?.role;
            const sessionId = client.sessionId;

            if (!teamId) {
                return {
                    content: [{ type: 'text', text: 'Error: You are not part of a team.' }],
                    isError: true,
                };
            }

            // ── Trace: help_requested ───────────────────────────────────
            let helpRequestedEventId: string | null = null;
            try {
                helpRequestedEventId = emitTraceEvent(
                    TraceEventKind.help_requested,
                    'mcp',
                    {
                        team_id: teamId,
                        task_id: args.taskId,
                        session_id: sessionId,
                    },
                    `${role || 'unknown'} requested help (${args.type}, severity=${args.severity}): ${args.description.slice(0, 200)}`,
                    { attrs: { helpType: args.type, severity: args.severity } },
                );
            } catch { /* trace must never break main flow */ }

            const { helpSpawned, error } = await triggerHelpLane({
                teamId,
                sessionId,
                role,
                type: args.type,
                description: args.description,
                severity: args.severity,
                taskId: args.taskId,
                sendNotification: true,
            });

            // ── Trace: help_agent_spawned (if spawn confirmed) ──────────
            if (helpSpawned && helpRequestedEventId) {
                try {
                    const spawnedId = emitTraceEvent(
                        TraceEventKind.help_agent_spawned,
                        'mcp',
                        {
                            team_id: teamId,
                            task_id: args.taskId,
                            session_id: sessionId,
                        },
                        `Help-agent spawned for ${role || 'unknown'} (${args.type}, severity=${args.severity})`,
                    );
                    if (spawnedId && helpRequestedEventId) {
                        emitTraceLink(spawnedId, helpRequestedEventId, 'caused_by');
                    }
                } catch { /* trace must never break main flow */ }
            }

            return {
                content: [{
                    type: 'text',
                    text: helpSpawned
                        ? `Help request logged and help-agent spawned (${args.type}, severity: ${args.severity}). A help-agent is joining the team to assist you.`
                        : `Help request logged (${args.type}, severity: ${args.severity}). The supervisor has been notified, but help-agent spawn was not confirmed${error ? `: ${error}` : ''}. If no help-agent appears within a few minutes, try again or ask @master for coordination.`,
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error requesting help: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // ========== Create Genome Tool (Evolution System, M3) ==========
    mcp.registerTool('create_genome', {
        description: `Save or update a reusable agent specification (genome) in the team evolution store.
A genome captures everything needed to reproduce a high-performing agent: system prompt,
tool access list, model, permission mode, and any domain knowledge to seed the agent's context.

IMPORTANT: Every genome MUST include team collaboration capabilities.
The system auto-injects core team tools (kanban lifecycle, messaging, help) into allowedTools,
and adds team protocol if missing. But you should STILL explicitly include:
- responsibilities mentioning task management
- protocol mentioning kanban board usage (list_tasks, start_task, complete_task)
- capabilities including 'kanban-task-lifecycle' and 'team-collaboration'
Without these, the agent becomes an isolated island that can't coordinate with the team.

Genomes can be instantiated later via the \`specId\` parameter of \`create_agent\`.

Use this tool when:
- You have refined an agent's behavior and want to preserve it for future spawns
- You want to share an agent specification with team members
- You are evolving an existing genome after observing performance

On genome-hub, repeated saves of the same namespace/name go through version promotion:
- first save creates v1
- later saves create vN+1 only if the latest version has enough supervisor score
- otherwise the call fails with validation details instead of silently overwriting history

Namespace conventions:
- "@official" — curated by the platform team
- "@<org-name>" — scoped to an organization (e.g. "@acme")
- omit or leave empty — personal genome (default)`,
        title: 'Create / Update Genome',
        inputSchema: {
            name: z.string().describe('Short human-readable name for this genome, e.g. "Senior TypeScript Implementer"'),
            spec: z.string().describe('JSON-serialized GenomeSpec: { systemPrompt, tools?, modelId?, permissionMode?, seedContext? }'),
            description: z.string().optional().describe('Longer explanation of what this genome is optimized for'),
            teamId: z.string().optional().describe('Scope the genome to a specific team (null = personal/public)'),
            isPublic: z.boolean().default(false).describe('Whether other users can discover and use this genome'),
            id: z.string().optional().describe('Existing genome ID to update. Omit to create a new genome.'),
            namespace: z.string().optional().describe('Namespace scope: "@official", "@<org-name>", or omit for personal'),
            tags: z.string().optional().describe('JSON-serialized string array of discovery tags, e.g. \'["typescript","backend","testing"]\''),
            category: z.string().optional().describe('Genome category for browsing, e.g. "coding", "research", "devops", "writing"'),
            parentId: z.string().optional().describe('ID of the parent genome this was forked/mutated from. Set when evolving an existing genome.'),
            mutationNote: z.string().optional().describe('Brief description of what changed from the parent genome.'),
            origin: z.enum(['original', 'forked', 'mutated']).optional().describe('Provenance origin type. Defaults to "original".'),
        },
    }, async (args) => {
        try {
            const sessionId = client.sessionId;
            if (!sessionId) {
                return {
                    content: [{ type: 'text', text: 'Error: No session ID available.' }],
                    isError: true,
                };
            }

            // ── Spec validation & sanitization ──────────────────────────
            let specStr = args.spec;

            // Size guard: reject oversized specs
            if (specStr.length > 64000) {
                return {
                    content: [{ type: 'text', text: 'Error: spec exceeds 64KB size limit.' }],
                    isError: true,
                };
            }

            let normalized;
            try {
                normalized = normalizeGenomeSpecForPublication({
                    specJson: specStr,
                    namespace: args.namespace,
                    parentId: args.parentId,
                    mutationNote: args.mutationNote,
                    origin: args.origin,
                });
            } catch {
                return {
                    content: [{ type: 'text', text: 'Error: spec is not valid JSON.' }],
                    isError: true,
                };
            }

            specStr = normalized.specJson;
            const warnings = [...normalized.warnings];
            if (!args.namespace) {
                warnings.push('namespace omitted: api.createGenome currently routes unnamed publications to the default marketplace namespace. Set namespace explicitly if you need deterministic scope.');
            }

            const result = await api.createGenome({
                id: args.id,
                name: args.name,
                description: args.description,
                spec: specStr,
                parentSessionId: sessionId,
                teamId: args.teamId,
                isPublic: args.isPublic,
                namespace: args.namespace,
                tags: args.tags,
                category: args.category,
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        genome: result.genome,
                        warnings,
                    }),
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error creating genome: ${String(error)}` }],
                isError: true,
            };
        }
    });

    mcp.registerTool('create_corps', {
        description: `Publish a CorpsSpec team template directly to the marketplace.

Use this for 3/5/7-person team templates and other reusable roster presets.
This routes to genome-hub \`POST /corps\`, which is the public marketplace source of truth
for team templates. Unlike \`create_genome\`, this is for \`CorpsSpec\`, not \`GenomeSpec\`.

Best practice:
- publish member genomes first
- then publish the corps template that references them
- keep team execution task-driven via bootContext.taskPolicy`,
        title: 'Create / Update Corps Template',
        inputSchema: {
            name: z.string().describe('Template name, e.g. "gstack-squad"'),
            spec: z.string().describe('JSON-serialized CorpsSpec'),
            description: z.string().optional().describe('Optional marketplace description override'),
            namespace: z.string().optional().describe('Namespace scope, e.g. "@official", "@acme", or omit for @public'),
            version: z.number().int().min(1).optional().describe('Template version override; defaults to the spec version or 1'),
            tags: z.string().optional().describe('JSON-serialized string array of discovery tags'),
            isPublic: z.boolean().default(true).describe('Whether the template is public in the marketplace'),
        },
    }, async (args) => {
        try {
            const sessionId = client.sessionId;
            if (!sessionId) {
                return {
                    content: [{ type: 'text', text: 'Error: No session ID available.' }],
                    isError: true,
                };
            }

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(args.spec) as Record<string, unknown>;
            } catch {
                return {
                    content: [{ type: 'text', text: 'Error: spec is not valid JSON.' }],
                    isError: true,
                };
            }

            if (!Array.isArray(parsed.members) || parsed.members.length === 0) {
                return {
                    content: [{ type: 'text', text: 'Error: spec must be a valid CorpsSpec with at least one member.' }],
                    isError: true,
                };
            }

            const normalized = {
                ...parsed,
                namespace: args.namespace ?? (typeof parsed.namespace === 'string' ? parsed.namespace : '@public'),
                name: args.name,
                version: args.version ?? (typeof parsed.version === 'number' ? parsed.version : 1),
                description: args.description ?? (typeof parsed.description === 'string' ? parsed.description : ''),
                category: 'corps',
            };

            if (!normalized.description) {
                return {
                    content: [{ type: 'text', text: 'Error: description is required either in args.description or CorpsSpec.description.' }],
                    isError: true,
                };
            }

            const result = await api.createCorpsTemplate({
                name: normalized.name,
                description: normalized.description,
                spec: JSON.stringify(normalized),
                namespace: normalized.namespace,
                version: normalized.version,
                tags: args.tags,
                isPublic: args.isPublic,
                publisherId: sessionId,
            });

            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        genome: result.genome,
                        corps: result.corps,
                    }),
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error creating corps template: ${String(error)}` }],
                isError: true,
            };
        }
    });

    // ========== Update Genome Tool (genome owners) ==========

    mcp.registerTool('update_genome', {
        description: [
            'Update the marketing metadata of an existing genome you own: description, tags, category, or isPublic.',
            'Does NOT change the genome spec or create a new version.',
            'Use this to improve how your genome appears in the marketplace without bumping its version.',
            'Requires genomeId (get it from get_self_view specId or from the create_genome response).',
            'Cannot update @official genomes unless you own them.',
        ].join(' '),
        title: 'Update Genome',
        inputSchema: {
            genomeId: z.string().describe('Immutable genome ID to update (from get_self_view specId or create_genome response)'),
            description: z.string().nullable().optional().describe('New marketing description for the genome'),
            tags: z.string().nullable().optional().describe('Comma-separated tags, e.g. "fullstack,typescript,agent"'),
            category: z.string().nullable().optional().describe('Category, e.g. "implementation", "coordination", "review"'),
            isPublic: z.boolean().optional().describe('Whether the genome should be visible in the public marketplace'),
        },
    }, async (args) => {
        if (!args.description && args.tags === undefined && args.category === undefined && args.isPublic === undefined) {
            return {
                content: [{ type: 'text', text: 'Error: Provide at least one field to update (description, tags, category, or isPublic).' }],
                isError: true,
            };
        }

        try {
            const updates: Record<string, unknown> = {};
            if (args.description !== undefined) updates.description = args.description;
            if (args.tags !== undefined) updates.tags = args.tags;
            if (args.category !== undefined) updates.category = args.category;
            if (args.isPublic !== undefined) updates.isPublic = args.isPublic;

            const result = await api.updateGenome(args.genomeId, updates as Parameters<typeof api.updateGenome>[1]);
            return {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        success: true,
                        genome: result.genome,
                    }),
                }],
                isError: false,
            };
        } catch (error) {
            return {
                content: [{ type: 'text', text: `Error updating genome: ${String(error)}` }],
                isError: true,
            };
        }
    });
}
