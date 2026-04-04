import packageJson from '../../package.json';

export type CliFlagSchema = {
  name: string;
  short?: string;
  value?: string;
  description: string;
  choices?: string[];
};

export type CliCommandSchema = {
  name: string;
  kind: 'root' | 'group' | 'command';
  description: string;
  usage: string;
  aliases?: string[];
  flags?: CliFlagSchema[];
  examples?: string[];
  supportsOutputFormats?: Array<'json' | 'table'>;
  supportsNoInteractive?: boolean;
  supportsDryRun?: boolean;
  children?: CliCommandSchema[];
};

const GLOBAL_FLAGS: CliFlagSchema[] = [
  {
    name: '--json',
    description: 'Emit machine-readable JSON to stdout.',
  },
  {
    name: '--format',
    value: '<json|table>',
    description: 'Select structured JSON or human/table output.',
    choices: ['json', 'table'],
  },
  {
    name: '--no-interactive',
    description: 'Fail fast instead of opening confirmation prompts.',
  },
  {
    name: '--debug',
    description: 'Enable debug logging.',
  },
  {
    name: '--help',
    short: '-h',
    description: 'Show help.',
  },
];

const DESTRUCTIVE_FLAGS: CliFlagSchema[] = [
  {
    name: '--force',
    short: '-f',
    description: 'Skip confirmation prompt for destructive actions.',
  },
  {
    name: '--dry-run',
    description: 'Preview a write action without executing it.',
  },
];

export const AHA_CLI_SCHEMA: CliCommandSchema = {
  name: 'aha',
  kind: 'root',
  description: 'Aha CLI command tree for human and agent use.',
  usage: 'aha <command> [options]',
  supportsOutputFormats: ['json', 'table'],
  supportsNoInteractive: true,
  flags: GLOBAL_FLAGS,
  examples: [
    'aha teams list --format json',
    'aha schema --all',
    'aha agents list --active --team <teamId> --json',
    'aha teams delete <teamId> --dry-run --format json',
  ],
  children: [
    {
      name: 'auth',
      kind: 'group',
      description: 'Authentication management.',
      usage: 'aha auth <login|reconnect|join|show-join-code|logout|status>',
      children: [
        { name: 'login', kind: 'command', description: 'Authenticate with Aha.', usage: 'aha auth login [--code <ticket>] [--force|--new|-n] [--mobile] [--email]' },
        { name: 'reconnect', kind: 'command', description: 'Refresh token for cached account.', usage: 'aha auth reconnect' },
        { name: 'join', kind: 'command', description: 'Join an existing account using a one-time ticket.', usage: 'aha auth join --ticket <ticket>' },
        { name: 'show-join-code', kind: 'command', description: 'Generate a one-time join command for another machine.', usage: 'aha auth show-join-code' },
        { name: 'logout', kind: 'command', description: 'Remove authentication and machine data.', usage: 'aha auth logout' },
        { name: 'status', kind: 'command', description: 'Show authentication status.', usage: 'aha auth status', supportsOutputFormats: ['table'] },
      ],
    },
    {
      name: 'connect',
      kind: 'group',
      description: 'Manage stored AI vendor credentials.',
      usage: 'aha connect <list|remove|codex|claude|gemini>',
      children: [
        { name: 'list', kind: 'command', description: 'List stored vendor connections.', usage: 'aha connect list', supportsOutputFormats: ['json', 'table'] },
        {
          name: 'remove',
          kind: 'command',
          description: 'Remove a stored vendor connection.',
          usage: 'aha connect remove <codex|claude|gemini> [--force]',
          flags: DESTRUCTIVE_FLAGS,
          supportsOutputFormats: ['json', 'table'],
          supportsNoInteractive: true,
          supportsDryRun: true,
        },
        { name: 'codex', kind: 'command', description: 'Store OpenAI credentials in Aha cloud.', usage: 'aha connect codex' },
        { name: 'claude', kind: 'command', description: 'Store Anthropic credentials in Aha cloud.', usage: 'aha connect claude' },
        { name: 'gemini', kind: 'command', description: 'Store Gemini credentials in Aha cloud.', usage: 'aha connect gemini' },
      ],
    },
    {
      name: 'channels',
      kind: 'group',
      aliases: ['channel'],
      description: 'Channel bridge management.',
      usage: 'aha channels <status|weixin>',
    },
    {
      name: 'tasks',
      kind: 'group',
      aliases: ['task'],
      description: 'Task management.',
      usage: 'aha tasks <list|show|create|update|delete|start|complete|done|lock|unlock>',
      supportsOutputFormats: ['json', 'table'],
      supportsNoInteractive: true,
      children: [
        { name: 'list', kind: 'command', description: 'List tasks for a team.', usage: 'aha tasks list --team <teamId> [--status <status>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'show', kind: 'command', description: 'Show one task.', usage: 'aha tasks show <taskId> --team <teamId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'create', kind: 'command', description: 'Create a task.', usage: 'aha tasks create --team <teamId> --title <title> [--description <text>] [--priority <low|medium|high>] [--assignee <sessionId>]', supportsOutputFormats: ['json', 'table'] },
        { name: 'update', kind: 'command', description: 'Update a task.', usage: 'aha tasks update <taskId> --team <teamId> [--status <status>] [--priority <priority>] [--assignee <sessionId>] [--description <text>]', supportsOutputFormats: ['json', 'table'] },
        { name: 'delete', kind: 'command', description: 'Delete a task.', usage: 'aha tasks delete <taskId> --team <teamId> [--force]', supportsNoInteractive: true, supportsDryRun: true, flags: DESTRUCTIVE_FLAGS, supportsOutputFormats: ['json', 'table'] },
        { name: 'start', kind: 'command', description: 'Start a task for a session.', usage: 'aha tasks start <taskId> --team <teamId> --session <sessionId> [--role <role>]', supportsOutputFormats: ['json', 'table'] },
        { name: 'complete', kind: 'command', description: 'Complete a task.', usage: 'aha tasks complete <taskId> --team <teamId> --session <sessionId>', supportsOutputFormats: ['json', 'table'] },
        { name: 'done', kind: 'command', description: 'Alias for complete.', usage: 'aha tasks done <taskId> --team <teamId> --session <sessionId>', supportsOutputFormats: ['json', 'table'] },
        { name: 'lock', kind: 'command', description: 'Lock task for human-only control.', usage: 'aha tasks lock <taskId> --team <teamId> [--session <sessionId>]', supportsOutputFormats: ['json', 'table'] },
        { name: 'unlock', kind: 'command', description: 'Unlock a task.', usage: 'aha tasks unlock <taskId> --team <teamId>', supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'teams',
      kind: 'group',
      aliases: ['team'],
      description: 'Team management.',
      usage: 'aha teams <list|show|status|create|spawn|publish-template|members|add-member|remove-member|rename|archive|unarchive|delete|batch-archive|batch-delete>',
      supportsOutputFormats: ['json', 'table'],
      supportsNoInteractive: true,
      children: [
        { name: 'list', kind: 'command', description: 'List teams.', usage: 'aha teams list [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'show', kind: 'command', description: 'Show a team artifact.', usage: 'aha teams show <teamId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'status', kind: 'command', description: 'Show team status, members, and task summary.', usage: 'aha teams status <teamId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'create', kind: 'command', description: 'Create a team.', usage: 'aha teams create --name <name> [--id <teamId>] [--goal <text>] [--sessions a,b] [--no-spawn]', supportsOutputFormats: ['json', 'table'] },
        { name: 'spawn', kind: 'command', description: 'Spawn a new team from corps/template inputs.', usage: 'aha teams spawn [options]', supportsOutputFormats: ['json', 'table'] },
        { name: 'publish-template', kind: 'command', description: 'Publish a team template / corps.', usage: 'aha teams publish-template <teamId> [options]', supportsOutputFormats: ['json', 'table'] },
        { name: 'members', kind: 'command', description: 'List team members.', usage: 'aha teams members <teamId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'add-member', kind: 'command', description: 'Add a session to a team.', usage: 'aha teams add-member <teamId> --session <sessionId> --role <roleId>', supportsOutputFormats: ['json', 'table'] },
        { name: 'remove-member', kind: 'command', description: 'Remove a session from a team.', usage: 'aha teams remove-member <teamId> --session <sessionId>', supportsOutputFormats: ['json', 'table'] },
        { name: 'rename', kind: 'command', description: 'Rename a team.', usage: 'aha teams rename <teamId> <newName>', supportsOutputFormats: ['json', 'table'] },
        { name: 'archive', kind: 'command', description: 'Archive a team.', usage: 'aha teams archive <teamId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'unarchive', kind: 'command', description: 'Restore an archived team.', usage: 'aha teams unarchive <teamId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'delete', kind: 'command', description: 'Delete a team.', usage: 'aha teams delete <teamId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'batch-archive', kind: 'command', description: 'Archive multiple teams.', usage: 'aha teams batch-archive <id...> [--ids a,b] [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'batch-delete', kind: 'command', description: 'Delete multiple teams.', usage: 'aha teams batch-delete <id...> [--ids a,b] [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'agents',
      kind: 'group',
      aliases: ['agent'],
      description: 'Agent session management.',
      usage: 'aha agents <list|show|create|update|rename|kill|archive|unarchive|delete|spawn>',
      supportsOutputFormats: ['json', 'table'],
      supportsNoInteractive: true,
      children: [
        { name: 'list', kind: 'command', description: 'List agent sessions.', usage: 'aha agents list [--active] [--team <teamId>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'show', kind: 'command', description: 'Show one agent session.', usage: 'aha agents show <sessionId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'create', kind: 'command', description: 'Create and spawn an agent.', usage: 'aha agents create [options]', supportsOutputFormats: ['json', 'table'] },
        { name: 'update', kind: 'command', description: 'Update agent metadata.', usage: 'aha agents update <sessionId> [--name <name>] [--role <role>] [--team <teamId>]', supportsOutputFormats: ['json', 'table'] },
        { name: 'rename', kind: 'command', description: 'Rename an agent.', usage: 'aha agents rename <sessionId> <name>', supportsOutputFormats: ['json', 'table'] },
        { name: 'kill', kind: 'command', description: 'Stop an agent session.', usage: 'aha agents kill <sessionId>', supportsOutputFormats: ['json', 'table'] },
        { name: 'archive', kind: 'command', description: 'Archive agent sessions.', usage: 'aha agents archive <id...> [--ids a,b] [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'unarchive', kind: 'command', description: 'Restore agent sessions.', usage: 'aha agents unarchive <id...> [--ids a,b] [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'delete', kind: 'command', description: 'Delete agent sessions.', usage: 'aha agents delete <id...> [--ids a,b] [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'spawn', kind: 'command', description: 'Spawn an agent into a running team.', usage: 'aha agents spawn [options]', supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'sessions',
      kind: 'group',
      aliases: ['session'],
      description: 'Direct session management.',
      usage: 'aha sessions <list|show|archive|unarchive|delete>',
      supportsOutputFormats: ['json', 'table'],
      supportsNoInteractive: true,
      children: [
        { name: 'list', kind: 'command', description: 'List sessions.', usage: 'aha sessions list [--active] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'show', kind: 'command', description: 'Show one session.', usage: 'aha sessions show <sessionId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'archive', kind: 'command', description: 'Archive a session.', usage: 'aha sessions archive <sessionId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'unarchive', kind: 'command', description: 'Restore a session.', usage: 'aha sessions unarchive <sessionId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
        { name: 'delete', kind: 'command', description: 'Delete a session.', usage: 'aha sessions delete <sessionId> [--force]', flags: DESTRUCTIVE_FLAGS, supportsNoInteractive: true, supportsDryRun: true, supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'trace',
      kind: 'group',
      description: 'Unified trace timeline inspection.',
      usage: 'aha trace <team|session|task|member|run|errors> [options]',
      supportsOutputFormats: ['json', 'table'],
      children: [
        { name: 'team', kind: 'command', description: 'Trace events for a team.', usage: 'aha trace team <teamId> [--limit <n>] [--full] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'session', kind: 'command', description: 'Trace events for a session.', usage: 'aha trace session <sessionId> [--limit <n>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'task', kind: 'command', description: 'Trace events for a task.', usage: 'aha trace task <taskId> [--limit <n>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'member', kind: 'command', description: 'Trace events for a team member.', usage: 'aha trace member <memberId> [--limit <n>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'run', kind: 'command', description: 'Trace events for a run.', usage: 'aha trace run <runId> [--limit <n>] [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'errors', kind: 'command', description: 'Show recent trace errors.', usage: 'aha trace errors [--since <duration>] [--json]', supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'usage',
      kind: 'group',
      description: 'Token usage and cost inspection.',
      usage: 'aha usage <session|team> [options]',
      supportsOutputFormats: ['json', 'table'],
      children: [
        { name: 'session', kind: 'command', description: 'Usage for one session.', usage: 'aha usage session <sessionId> [--json]', supportsOutputFormats: ['json', 'table'] },
        { name: 'team', kind: 'command', description: 'Usage summary for one team.', usage: 'aha usage team <teamId> [--json]', supportsOutputFormats: ['json', 'table'] },
      ],
    },
    {
      name: 'roles',
      kind: 'group',
      aliases: ['role'],
      description: 'Role pool and review inspection.',
      usage: 'aha roles <defaults|list|pool|reviews|review|team-reviews|team-review|team-score>',
    },
    { name: 'codex', kind: 'command', description: 'Start Codex mode.', usage: 'aha codex [options]' },
    { name: 'doctor', kind: 'command', description: 'Diagnostics and cleanup.', usage: 'aha doctor [clean]' },
    { name: 'notify', kind: 'command', description: 'Send a push notification.', usage: 'aha notify -p <message> [-t <title>]' },
    { name: 'daemon', kind: 'group', description: 'Background daemon management.', usage: 'aha daemon <start|stop|status|list|logs|install|uninstall|stop-session>' },
    { name: 'ralph', kind: 'group', description: 'Ralph autonomous loop control.', usage: 'aha ralph <start|status|stop|heartbeat>' },
    {
      name: 'schema',
      kind: 'command',
      description: 'Machine-readable CLI schema / command tree.',
      usage: 'aha schema [--all] [path...]',
      supportsOutputFormats: ['json'],
      examples: ['aha schema --all', 'aha schema teams status'],
    },
  ],
};

function matchesName(node: CliCommandSchema, token: string): boolean {
  return node.name === token || node.aliases?.includes(token) === true;
}

export function resolveCliSchema(pathTokens: string[]): CliCommandSchema | null {
  let current: CliCommandSchema = AHA_CLI_SCHEMA;

  for (const token of pathTokens) {
    const next = current.children?.find((child) => matchesName(child, token));
    if (!next) {
      return null;
    }
    current = next;
  }

  return current;
}

export function buildCliSchemaDocument(pathTokens: string[] = []): Record<string, unknown> {
  const node = resolveCliSchema(pathTokens);
  if (!node) {
    return {
      schemaVersion: 'aha-cli-schema-v1',
      version: packageJson.version,
      found: false,
      path: pathTokens,
    };
  }

  return {
    schemaVersion: 'aha-cli-schema-v1',
    version: packageJson.version,
    found: true,
    path: pathTokens,
    globalFlags: GLOBAL_FLAGS,
    command: node,
  };
}
