type SharedOperatingRulesOptions = {
    roleKey: string;
    isCoordinator: boolean;
    isBypass: boolean;
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

export function buildSharedOperatingRulesSection(
    options: SharedOperatingRulesOptions
): string {
    const replacementInstruction = options.isCoordinator || options.isBypass
        ? 'If the team decides to replace an owner, call `replace_agent` to hot-swap the session. You may switch runtime between `claude` and `codex`, and the tool will carry unfinished tasks forward.'
        : 'If the team decides a peer should be replaced, recommend it via `challenge` / `vote`, then wait for Master, Supervisor, or Help Agent to execute `replace_agent`.';

    const rules: SharedOperatingRule[] = [
        {
            title: 'Help Lane',
            body: [
                'If you are blocked for roughly 30 minutes, or you hit environment, team-state, routing, connection, or ownership problems, call `request_help` immediately with concrete evidence.',
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
            title: 'Shared File Broadcast',
            body: [
                'Before touching shared or high-conflict files, broadcast your intent in team chat so peers can avoid collisions and challenge the plan early if needed.',
            ],
        },
    ];

    return [
        '<Shared_Operating_Rules>',
        '## Always Injected Team Operating Rules',
        '',
        ...rules.map(formatRule),
        '',
        '</Shared_Operating_Rules>',
    ].join('\n');
}
