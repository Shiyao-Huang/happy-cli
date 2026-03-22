import type { GenomeSpec } from '@/api/types/genome';

type SharedOperatingRulesOptions = {
    roleKey: string;
    isCoordinator: boolean;
    isBypass: boolean;
    genomeSpec?: GenomeSpec | null;
};

type SharedOperatingRule = {
    title: string;
    body: string[];
};

function formatRule(rule: SharedOperatingRule): string {
    return [
        `### ${rule.title}`,
        ...rule.body.map((line) => `- ${line}`),
    ].join('\n');
}

/**
 * Build behavioral DNA instructions from GenomeSpec Tier 7 fields.
 * Translates messaging/behavior fields into natural language prompts
 * so the agent's personality is driven by its genome, not hardcode.
 */
function buildBehaviorDnaRules(genomeSpec: GenomeSpec | null | undefined): SharedOperatingRule[] {
    if (!genomeSpec) return [];
    const rules: SharedOperatingRule[] = [];

    // messaging.replyMode → agent personality
    const replyMode = genomeSpec.messaging?.replyMode;
    if (replyMode === 'proactive') {
        rules.push({
            title: 'Communication Style (Proactive)',
            body: [
                'You are proactive. When you see an opportunity to help or an unassigned task that matches your capabilities, take initiative.',
                'Communicate progress and findings without waiting to be asked.',
            ],
        });
    } else if (replyMode === 'passive') {
        rules.push({
            title: 'Communication Style (Silent Worker)',
            body: [
                'You work silently. Only send team messages when reporting a blocker or completing a task.',
                'Do not participate in discussions unless directly mentioned.',
            ],
        });
    }

    // behavior.onIdle → what to do when no tasks
    const onIdle = genomeSpec.behavior?.onIdle;
    if (onIdle === 'self-assign') {
        rules.push({
            title: 'Idle Behavior',
            body: [
                'When you have no assigned tasks, call `list_tasks` and `start_task` on the highest priority unassigned task that matches your capabilities.',
                'Do not wait for explicit assignment.',
            ],
        });
    } else if (onIdle === 'ask') {
        rules.push({
            title: 'Idle Behavior',
            body: [
                'When you have no assigned tasks, proactively ask @master for your next assignment.',
            ],
        });
    }

    // behavior.onBlocked → escalation behavior
    const onBlocked = genomeSpec.behavior?.onBlocked;
    if (onBlocked === 'escalate') {
        rules.push({
            title: 'Blocked Behavior',
            body: [
                'When blocked, immediately call `request_help` to escalate. Do not wait for the master to notice.',
            ],
        });
    } else if (onBlocked === 'retry') {
        rules.push({
            title: 'Blocked Behavior',
            body: [
                'When blocked, attempt at least one alternative approach before escalating. If the retry fails, call `request_help`.',
            ],
        });
    }

    // scopeOfResponsibility → file ownership from genome
    const scope = (genomeSpec as any).scopeOfResponsibility;
    if (scope?.ownedPaths?.length) {
        rules.push({
            title: 'File Ownership (from genome)',
            body: [
                `Your owned paths: ${scope.ownedPaths.join(', ')}`,
                ...(scope.forbiddenPaths?.length ? [`Forbidden paths: ${scope.forbiddenPaths.join(', ')}`] : []),
                'Broadcast intent before touching any file outside your owned paths.',
            ],
        });
    }

    return rules;
}

function buildRuntimeBoundaryAndContextMirrorRules(): SharedOperatingRule[] {
    const rules: SharedOperatingRule[] = [];
    const launchBoundary = process.env.AHA_AGENT_SCOPE_SUMMARY?.trim();

    if (launchBoundary) {
        rules.push({
            title: 'Launch Boundary',
            body: [
                launchBoundary,
                'Treat this launch boundary as your default write scope unless Master or the user explicitly expands it.',
            ],
        });
    }

    rules.push({
        title: 'Context Mirror',
        body: [
            'Call `get_context_status` when you start a large task, after loading many files/logs, and before long summaries.',
            'If `usedPercent >= 70`, finish the current subtask and then `/compact`.',
            'If `usedPercent >= 85`, output `/compact` immediately to preserve performance.',
            'If a `/context-mirror` skill is available in your runtime, prefer it instead of reinventing the workflow.',
        ],
    });

    rules.push({
        title: 'Lifecycle Control',
        body: [
            'You control your own lifecycle. The runtime must not retire you just because you casually mention a completion word.',
            'If you intentionally want to retire, emit `<AHA_LIFECYCLE action="retire" reason="short_reason" />` on its own line.',
            'If you want to stay alive but become quiet, emit `<AHA_LIFECYCLE action="standby" reason="short_reason" />` on its own line.',
            'If you emit no lifecycle directive, you remain alive.',
            'Legacy plain-text sentinels such as HELP_COMPLETE, SUPERVISOR_COMPLETE, BOOTSTRAP_COMPLETE, and ORG_MANAGER_COMPLETE are documentation only. Do not use them as lifecycle commands.',
        ],
    });

    return rules;
}

export function buildSharedOperatingRulesSection(
    options: SharedOperatingRulesOptions
): string {
    const replacementInstruction = options.isCoordinator || options.isBypass
        ? 'If the team decides to replace an owner, call `replace_agent` to hot-swap the session. You may switch runtime between `claude` and `codex`, and the tool will carry unfinished tasks forward.'
        : 'If the team decides a peer should be replaced, recommend it via `challenge` / `vote`, then wait for Master, Supervisor, or Help Agent to execute `replace_agent`.';

    const rules: SharedOperatingRule[] = [
        {
            title: 'Kanban Source of Truth',
            body: options.isBypass
                ? [
                    'The Kanban board is visible shared context for the whole team, including system agents.',
                    'Use `get_team_info` and `list_tasks` to understand current team state before intervening.',
                    'You usually do not own routine delivery tasks, but you must stay aware of board state.',
                ]
                : [
                    'The Kanban board is the default work surface for the team.',
                    'Use `get_team_info` and `list_tasks` as your first source of truth before inferring work from files or chat.',
                    'If a task is assigned to you, move it through the task lifecycle visibly instead of working only in discussion threads.',
                    'When you review, hand off, reject, or send work back for rework, leave a task comment so the task carries memory across agents.',
                ],
        },
        {
            title: 'Help Lane',
            body: [
                'If you are blocked for roughly 30 minutes, or you hit environment, team-state, routing, connection, or ownership problems, call `request_help` immediately with concrete evidence.',
                'Use `@help` in team chat when you need live intervention; it is the same escalation lane as `request_help`, auto-triggers help-agent spawn, and should include the blocker plus what you already tried.',
                'Treat user `@help`, supervisor escalation, and teammate help requests as the same help lane: describe what is broken, what you already tried, and what outcome you need.',
            ],
        },
        {
            title: 'Challenge Lane',
            body: [
                'If you believe another agent, a team object, or a session-to-task mapping is wrong, call `send_team_message` with `type: "challenge"` and include evidence, risk, and your recommended next step.',
                'Mention Master when possible so the dispute has a visible owner and can move to review quickly.',
            ],
        },
        {
            title: 'Vote Lane',
            body: [
                'When Master or Supervisor asks for a vote, reply with `send_team_message` using `type: "vote"` and state one of: keep, replace, or unsure.',
                'Votes must include one short evidence sentence. Do not vote from vibes alone.',
            ],
        },
        {
            title: 'Replacement Lane',
            body: [
                replacementInstruction,
                'Replacement is for bad ownership, repeated blockage, or wrong runtime fit. Keep the scope focused: replace the owner, not the whole plan.',
            ],
        },
        {
            title: 'End-of-Round Checklist',
            body: [
                'After calling `complete_task` or finishing any unit of work, ALWAYS call `list_tasks` immediately to check for new or updated tasks.',
                'Required workflow: `complete_task` → `list_tasks` → read available tasks → call `get_task(taskId)` on any task you plan to start → `start_task`.',
                '`list_tasks` only shows the last 20 comments per task. Use `get_task(taskId)` to read the full comment history before starting work on a task with many comments.',
                'Do not assume you have seen all context — always fetch fresh board state before claiming the next task.',
            ],
        },
        {
            title: 'Shared File Broadcast',
            body: [
                'Before touching shared or high-conflict files, broadcast your intent in team chat so peers can avoid collisions and challenge the plan early if needed.',
            ],
        },
    ];

    // Inject behavior DNA from genome (Tier 7)
    const behaviorRules = buildBehaviorDnaRules(options.genomeSpec);
    rules.push(...behaviorRules);
    rules.push(...buildRuntimeBoundaryAndContextMirrorRules());

    // Inject genome-specific protocol rules (from GenomeSpec.protocol[])
    const genomeProtocol = options.genomeSpec?.protocol;
    if (genomeProtocol?.length) {
        rules.push({
            title: 'Genome Protocol',
            body: genomeProtocol,
        });
    }

    return [
        '<Shared_Operating_Rules>',
        '## Team Operating Rules',
        '',
        ...rules.map(formatRule),
        '',
        '</Shared_Operating_Rules>',
    ].join('\n');
}
