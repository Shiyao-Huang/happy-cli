/**
 * Team management commands for Aha CLI
 * Provides commands for archiving, deleting, and managing teams
 */

import chalk from 'chalk';
import { ApiClient, TeamCompositionRequest, TeamCompositionSignals, TeamCompositionPlan } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stopDaemonTeamSessions } from '@/daemon/controlClient';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';

interface TeamCommandOptions {
    force?: boolean;
    verbose?: boolean;
}

interface PrdUserStory {
    id?: string;
    title?: string;
    priority?: number;
    passes?: boolean;
}

interface PrdDocument {
    project?: string;
    branchName?: string;
    description?: string;
    userStories?: PrdUserStory[];
    tasks?: PrdUserStory[];
}

interface PrdComposeContext {
    sourcePath: string;
    context: string;
    goalSuggestion: string;
    pendingStories: PrdUserStory[];
    completedCount: number;
    totalStories: number;
}

interface AskInterviewContext {
    goal: string;
    target: 'wow' | 'uv1' | 'uv2' | 'local' | 'generic';
    plan: TeamCompositionPlan;
    signals: TeamCompositionSignals;
    prdContext?: PrdComposeContext;
}

interface SpecContext extends AskInterviewContext {}

/**
 * Stop all daemon-managed sessions for a team
 */
async function stopTeamSessionsInDaemon(teamId: string): Promise<void> {
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        if (!isRunning) {
            logger.debug('[Teams] Daemon not running, no local sessions to stop');
            return;
        }

        console.log(chalk.gray(`Stopping local daemon sessions for team ${teamId}...`));
        const result = await stopDaemonTeamSessions(teamId);

        if (result.stopped > 0) {
            console.log(chalk.gray(`Stopped ${result.stopped} local session(s)`));
        }
        if (result.errors.length > 0) {
            logger.debug('[Teams] Errors stopping sessions:', result.errors);
        }
    } catch (error) {
        // Non-fatal: daemon may not be running
        logger.debug('[Teams] Failed to stop daemon sessions (non-fatal):', error);
    }
}

/**
 * Show help for teams command
 */
export function showTeamsHelp() {
    console.log(`
${chalk.bold.cyan('Aha Teams')} - Team management commands

${chalk.bold('Usage:')}
  ${chalk.green('aha teams')} <command> [options]

${chalk.bold('Available Commands:')}
  ${chalk.yellow('list')}                      List all teams
  ${chalk.yellow('archive')} <teamId>          Archive a team (preserves data)
  ${chalk.yellow('delete')} <teamId>           Delete a team permanently
  ${chalk.yellow('rename')} <teamId> <name>    Rename a team
  ${chalk.yellow('compose')} [options]         Auto-compose single/multi team plan (V1/V2 aware)

${chalk.bold('Options:')}
  ${chalk.cyan('--force, -f')}                Skip confirmation prompts
  ${chalk.cyan('--verbose, -v')}              Show detailed output
  ${chalk.cyan('--help, -h')}                 Show this help message

${chalk.bold('Compose Options:')}
  ${chalk.cyan('--goal, -g')} <text>           目标描述（可选，未传时可自动从 PRD 生成）
  ${chalk.cyan('--context')} <text>            额外上下文（会与 PRD 上下文合并）
  ${chalk.cyan('--prd')} <path>                指定 PRD JSON（未传时自动探测 ralph/prd.json 或 .aha/prd.json）
  ${chalk.cyan('--prd-top')} <n>               从 PRD 提取前 n 个待办（默认 6）
  ${chalk.cyan('--ask-output')} <path>         生成《ASK》用户旅程访谈 Markdown
  ${chalk.cyan('--spec-output')} <path>        生成《SPEC》技术规格 Markdown（含 EvoMap + 版本门禁）
  ${chalk.cyan('--version')} <v1|v2|dual>      强制版本策略
  ${chalk.cyan('--mode')} <single|multi>       强制编组模式
  ${chalk.cyan('--max-teams')} <n>             限制返回团队数（1-5）
  ${chalk.cyan('--history')} <path1,path2>     历史消息根目录（默认 .aha + ~/work/opc/.aha）
  ${chalk.cyan('--target')} <wow|uv1|uv2|local|generic> 部署目标（默认 wow）
  ${chalk.cyan('--json')}                      仅输出 JSON 结果

${chalk.bold('Examples:')}
  ${chalk.gray('# List all teams')}
  ${chalk.green('aha teams list')}

  ${chalk.gray('# Archive a team (with confirmation)')}
  ${chalk.green('aha teams archive team_abc123')}

  ${chalk.gray('# Delete a team (skip confirmation)')}
  ${chalk.green('aha teams delete team_abc123 --force')}

  ${chalk.gray('# Rename a team')}
  ${chalk.green('aha teams rename team_abc123 "New Team Name"')}

  ${chalk.gray('# Compose a dual-track plan for wow deployment')}
  ${chalk.green('aha teams compose --goal "拆分多团队并迭代 v1/v2 部署" --version dual --mode multi')}

  ${chalk.gray('# Compose from PRD + .aha history')}
  ${chalk.green('aha teams compose --prd ./ralph/prd.json --target wow --mode multi')}

  ${chalk.gray('# Compose + generate ASK interview report')}
  ${chalk.green('aha teams compose --prd ./ralph/prd.json --ask-output ./用户访谈/ASK_V1V2.md')}

  ${chalk.gray('# Compose + generate SPEC report')}
  ${chalk.green('aha teams compose --prd ./ralph/prd.json --spec-output ./DOC/v6-spec.md')}

${chalk.bold('Notes:')}
  - Archive preserves all data but deactivates sessions
  - Delete permanently removes the team and all sessions
  - Use ${chalk.cyan('--force')} flag to skip confirmation prompts
`);
}

/**
 * Handle teams command routing
 */
export async function handleTeamsCommand(args: string[]) {
    const subcommand = args[0];

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showTeamsHelp();
        return;
    }

    // Parse options
    const options: TeamCommandOptions = {
        force: args.includes('--force') || args.includes('-f'),
        verbose: args.includes('--verbose') || args.includes('-v')
    };

    // Remove flags from args
    const cleanArgs = args.filter(arg => !arg.startsWith('-'));

    // Authenticate first
    const credentials = readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('Not authenticated. Please run:'), chalk.green('aha auth login'));
        process.exit(1);
    }

    const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
    const api = await ApiClient.create(authCredentials);

    try {
        switch (subcommand) {
            case 'list':
                await listTeams(api, options);
                break;

            case 'archive':
                if (cleanArgs.length < 2) {
                    console.log(chalk.red('Error: Team ID required'));
                    console.log(chalk.yellow('Usage:'), chalk.green('aha teams archive <teamId>'));
                    process.exit(1);
                }
                await archiveTeam(api, cleanArgs[1], options);
                break;

            case 'delete':
                if (cleanArgs.length < 2) {
                    console.log(chalk.red('Error: Team ID required'));
                    console.log(chalk.yellow('Usage:'), chalk.green('aha teams delete <teamId>'));
                    process.exit(1);
                }
                await deleteTeam(api, cleanArgs[1], options);
                break;

            case 'rename':
                if (cleanArgs.length < 3) {
                    console.log(chalk.red('Error: Team ID and new name required'));
                    console.log(chalk.yellow('Usage:'), chalk.green('aha teams rename <teamId> <name>'));
                    process.exit(1);
                }
                await renameTeam(api, cleanArgs[1], cleanArgs.slice(2).join(' '), options);
                break;

            case 'compose':
                await composeTeams(api, args.slice(1), options);
                break;

            default:
                console.log(chalk.red(`Unknown command: ${subcommand}`));
                console.log(chalk.yellow('Run'), chalk.green('aha teams --help'), chalk.yellow('for usage'));
                process.exit(1);
        }
    } catch (error) {
        logger.debug('[TeamsCommand] Error:', error);
        console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
        process.exit(1);
    }
}

/**
 * List all teams
 * Note: Implements direct API call since ApiClient doesn't have listArtifacts yet
 */
async function listTeams(api: any, options: TeamCommandOptions) {
    try {
        console.log(chalk.cyan('Fetching teams...'));

        // Direct API call to GET /v1/artifacts since ApiClient doesn't expose this yet
        // TODO: Add listArtifacts() method to ApiClient
        const axios = (await import('axios')).default;
        const configuration = (await import('@/configuration')).configuration;
        const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();

        const response = await axios.get(
            `${configuration.serverUrl}/v1/artifacts`,
            {
                headers: {
                    'Authorization': `Bearer ${authCredentials.token}`
                },
                timeout: 10000
            }
        );

        const artifacts = response.data.artifacts || [];
        const teams = artifacts.filter((a: any) => a.type === 'team');

        if (teams.length === 0) {
            console.log(chalk.yellow('No teams found'));
            return;
        }

        console.log(chalk.bold(`\nFound ${teams.length} team(s):\n`));

        for (const team of teams) {
            console.log(chalk.green('━'.repeat(60)));
            console.log(chalk.bold.white(`Team: ${team.header?.name || team.id}`));
            console.log(chalk.gray(`ID: ${team.id}`));
            console.log(chalk.gray(`Created: ${new Date(team.createdAt).toLocaleString()}`));
            console.log(chalk.gray(`Updated: ${new Date(team.updatedAt).toLocaleString()}`));

            if (options.verbose && team.body) {
                try {
                    // Try to get more details via getArtifact if needed
                    const fullTeam = await api.getArtifact(team.id);
                    const body = fullTeam.body;

                    if (body && typeof body === 'object') {
                        const teamData = (body as any).team || {};
                        const memberCount = teamData.members?.length || 0;
                        const taskCount = (body as any).tasks?.length || 0;
                        console.log(chalk.gray(`Members: ${memberCount}`));
                        console.log(chalk.gray(`Tasks: ${taskCount}`));
                    }
                } catch {
                    // Ignore errors in verbose mode
                }
            }
        }

        console.log(chalk.green('━'.repeat(60)));
        console.log();

    } catch (error) {
        throw new Error(`Failed to list teams: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Archive a team
 */
async function archiveTeam(api: ApiClient, teamId: string, options: TeamCommandOptions) {
    try {
        // Confirm unless --force is used
        if (!options.force) {
            console.log(chalk.yellow(`\nAre you sure you want to archive team ${teamId}?`));
            console.log(chalk.gray('This will deactivate all sessions but preserve data.'));
            console.log(chalk.gray('Use --force to skip this confirmation.\n'));

            // Simple confirmation - in production you'd use a proper prompt library
            const { default: readline } = await import('node:readline/promises');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const answer = await rl.question(chalk.cyan('Continue? (y/N): '));
            rl.close();

            if (answer.toLowerCase() !== 'y') {
                console.log(chalk.yellow('Operation cancelled'));
                return;
            }
        }

        console.log(chalk.cyan(`Archiving team ${teamId}...`));

        // Stop daemon-managed sessions for this team first
        await stopTeamSessionsInDaemon(teamId);

        const result = await api.archiveTeam(teamId);

        if (result.success) {
            console.log(chalk.green('✓ Team archived successfully'));
            console.log(chalk.gray(`Archived ${result.archivedSessions} session(s)`));
        } else {
            throw new Error('Archive operation failed');
        }

    } catch (error) {
        throw new Error(`Failed to archive team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Delete a team
 */
async function deleteTeam(api: ApiClient, teamId: string, options: TeamCommandOptions) {
    try {
        // Confirm unless --force is used
        if (!options.force) {
            console.log(chalk.red.bold(`\n⚠️  WARNING: This will permanently delete team ${teamId}`));
            console.log(chalk.gray('This action cannot be undone. All sessions and data will be lost.'));
            console.log(chalk.gray('Use --force to skip this confirmation.\n'));

            const { default: readline } = await import('node:readline/promises');
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            const answer = await rl.question(chalk.cyan('Type "DELETE" to confirm: '));
            rl.close();

            if (answer !== 'DELETE') {
                console.log(chalk.yellow('Operation cancelled'));
                return;
            }
        }

        console.log(chalk.cyan(`Deleting team ${teamId}...`));

        // Stop daemon-managed sessions for this team first
        await stopTeamSessionsInDaemon(teamId);

        const result = await api.deleteTeam(teamId);

        if (result.success) {
            console.log(chalk.green('✓ Team deleted successfully'));
            console.log(chalk.gray(`Deleted ${result.deletedSessions} session(s)`));
        } else {
            throw new Error('Delete operation failed');
        }

    } catch (error) {
        throw new Error(`Failed to delete team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Rename a team
 */
async function renameTeam(api: ApiClient, teamId: string, newName: string, options: TeamCommandOptions) {
    try {
        console.log(chalk.cyan(`Renaming team ${teamId} to "${newName}"...`));

        const result = await api.renameTeam(teamId, newName);

        if (result.success) {
            console.log(chalk.green('✓ Team renamed successfully'));
            if (options.verbose) {
                console.log(chalk.gray(`New name: ${newName}`));
            }
        } else {
            throw new Error('Rename operation failed');
        }

    } catch (error) {
        throw new Error(`Failed to rename team: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

function getOptionValue(args: string[], ...flags: string[]): string | undefined {
    for (const flag of flags) {
        const index = args.indexOf(flag);
        if (index >= 0 && index + 1 < args.length) {
            return args[index + 1];
        }
    }
    return undefined;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
    return flags.some((flag) => args.includes(flag));
}

function extractComposeGoal(args: string[]): string {
    const explicit = getOptionValue(args, '--goal', '-g');
    if (explicit) {
        return explicit.trim();
    }

    const valueFlags = new Set([
        '--goal',
        '-g',
        '--version',
        '--mode',
        '--max-teams',
        '--history',
        '--target',
        '--prd',
        '--prd-top',
        '--context',
        '--ask-output',
        '--spec-output',
    ]);
    const positional: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const token = args[i];
        if (token.startsWith('-')) {
            if (valueFlags.has(token)) {
                i += 1;
            }
            continue;
        }
        positional.push(token);
    }

    return positional.join(' ').trim();
}

function normalizeTopN(input?: string): number {
    const parsed = input ? Number(input) : 6;
    if (!Number.isFinite(parsed)) {
        return 6;
    }
    return Math.min(20, Math.max(1, Math.floor(parsed)));
}

function resolveDefaultPrdPath(): string | undefined {
    const candidates = [
        path.resolve(process.cwd(), 'ralph/prd.json'),
        path.resolve(process.cwd(), '.aha/prd.json'),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    return undefined;
}

function loadPrdComposeContext(prdPathInput: string, topN: number): PrdComposeContext {
    const resolvedPath = path.isAbsolute(prdPathInput)
        ? prdPathInput
        : path.resolve(process.cwd(), prdPathInput);

    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`PRD file not found: ${resolvedPath}`);
    }

    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const prd = JSON.parse(raw) as PrdDocument;
    const stories = Array.isArray(prd.userStories) && prd.userStories.length > 0
        ? prd.userStories
        : (Array.isArray(prd.tasks) ? prd.tasks : []);

    const pendingStories = stories
        .filter((story) => story && story.passes !== true)
        .sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER));

    const topPending = pendingStories.slice(0, topN);
    const completedCount = stories.length - pendingStories.length;

    const ids = topPending.map((story) => story.id || 'UNKNOWN');
    const frontend = ids.filter((id) => id.includes('KANBAN'));
    const backend = ids.filter((id) => id.includes('SERVER') || id.includes('SYSTEM'));
    const cli = ids.filter((id) => id.includes('CLI'));

    const summary = topPending
        .map((story) => `${story.id || 'UNKNOWN'}(${story.priority ?? '-'}) ${story.title || 'untitled'}`)
        .join(' | ');

    const contextLines = [
        `PRD来源: ${resolvedPath}`,
        `项目: ${prd.project || 'unknown'}`,
        `分支建议: ${prd.branchName || 'unknown'}`,
        `待办Top${topPending.length}: ${summary || 'none'}`,
        frontend.length > 0 ? `前端焦点: ${frontend.join(', ')}` : '',
        backend.length > 0 ? `后端焦点: ${backend.join(', ')}` : '',
        cli.length > 0 ? `CLI焦点: ${cli.join(', ')}` : '',
        `已通过: ${completedCount}/${stories.length}`,
    ].filter(Boolean);

    const goalSuggestion = topPending.length > 0
        ? `按 PRD 优先级推进 ${topPending.slice(0, 3).map((story) => story.id || 'UNKNOWN').join('、')}，并兼顾 wow 的 V1/V2 双轨部署`
        : `基于 PRD ${prd.project || '目标'} 规划团队编组并推进 wow V1/V2 迭代`;

    return {
        sourcePath: resolvedPath,
        context: contextLines.join('\n'),
        goalSuggestion,
        pendingStories: topPending,
        completedCount,
        totalStories: stories.length,
    };
}

function collectHistoryFiles(historyRoots: string[]): string[] {
    const files = new Set<string>();

    for (const root of historyRoots) {
        const trimmed = root.trim();
        if (!trimmed) {
            continue;
        }

        if (!fs.existsSync(trimmed)) {
            continue;
        }

        const stats = fs.statSync(trimmed);
        if (stats.isFile() && trimmed.endsWith('messages.jsonl')) {
            files.add(trimmed);
            continue;
        }

        if (!stats.isDirectory()) {
            continue;
        }

        const teamDir = path.join(trimmed, 'teams');
        if (!fs.existsSync(teamDir) || !fs.statSync(teamDir).isDirectory()) {
            continue;
        }

        for (const teamId of fs.readdirSync(teamDir)) {
            const messagesPath = path.join(teamDir, teamId, 'messages.jsonl');
            if (fs.existsSync(messagesPath) && fs.statSync(messagesPath).isFile()) {
                files.add(messagesPath);
            }
        }
    }

    return Array.from(files);
}

function collectEvolutionSignals(historyRoots: string[]): TeamCompositionSignals {
    const files = collectHistoryFiles(historyRoots);

    let total = 0;
    let readyLike = 0;
    let idleLike = 0;
    let coordinatorMsgs = 0;
    let deploymentIncidents = 0;
    let cliFocus = 0;
    let serverFocus = 0;
    let kanbanFocus = 0;

    const readyPatterns = ['online and ready', 'standing by', 'awaiting task assignment', '待命', 'ready for assignment'];
    const idlePatterns = [...readyPatterns, 'silence', 'silent', 'acknowledged', 'stand by', 'waiting for @mention'];
    const incidentPatterns = ['404', 'blocked', 'failed', 'error', 'nginx', 'pm2', '部署失败', '回滚'];
    const cliPatterns = ['aha-cli', 'aha teams', 'cli', 'command', 'terminal'];
    const serverPatterns = ['happy-server', 'api', 'backend', 'route', 'prisma', 'pm2', 'nginx'];
    const kanbanPatterns = ['kanban', 'webapp', 'ui', 'frontend', 'expo', '看板'];
    const coordinatorRoles = new Set(['master', 'orchestrator', 'project-manager', 'product-owner']);

    for (const filePath of files) {
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }

            try {
                const payload = JSON.parse(line) as { fromRole?: string; content?: string };
                const content = (payload.content || '').toLowerCase();
                total += 1;

                if (readyPatterns.some((pattern) => content.includes(pattern))) {
                    readyLike += 1;
                }
                if (idlePatterns.some((pattern) => content.includes(pattern))) {
                    idleLike += 1;
                }
                if (incidentPatterns.some((pattern) => content.includes(pattern))) {
                    deploymentIncidents += 1;
                }
                if (cliPatterns.some((pattern) => content.includes(pattern))) {
                    cliFocus += 1;
                }
                if (serverPatterns.some((pattern) => content.includes(pattern))) {
                    serverFocus += 1;
                }
                if (kanbanPatterns.some((pattern) => content.includes(pattern))) {
                    kanbanFocus += 1;
                }
                if (payload.fromRole && coordinatorRoles.has(payload.fromRole)) {
                    coordinatorMsgs += 1;
                }
            } catch {
                // Ignore malformed lines.
            }
        }
    }

    if (total === 0) {
        return {
            readyPingRatio: 0,
            coordinatorMessageRatio: 0,
            deploymentIncidentRatio: 0,
            idleStatusRatio: 0,
            cliFocusRatio: 0,
            serverFocusRatio: 0,
            kanbanFocusRatio: 0,
            historySampleSize: 0,
        };
    }

    return {
        readyPingRatio: Number((readyLike / total).toFixed(4)),
        coordinatorMessageRatio: Number((coordinatorMsgs / total).toFixed(4)),
        deploymentIncidentRatio: Number((deploymentIncidents / total).toFixed(4)),
        idleStatusRatio: Number((idleLike / total).toFixed(4)),
        cliFocusRatio: Number((cliFocus / total).toFixed(4)),
        serverFocusRatio: Number((serverFocus / total).toFixed(4)),
        kanbanFocusRatio: Number((kanbanFocus / total).toFixed(4)),
        historySampleSize: total,
    };
}

function printTeamCompositionPlan(plan: TeamCompositionPlan): void {
    console.log(chalk.bold.cyan('\n🧠 自适应团队编组建议'));
    console.log(chalk.gray('─'.repeat(72)));
    console.log(`${chalk.white('模式')}: ${plan.mode} | ${chalk.white('版本策略')}: ${plan.versionTrack} | ${chalk.white('部署目标')}: ${plan.deploymentTarget}`);
    console.log(`${chalk.white('推断焦点')}: ${plan.inferredFocus.join(', ') || 'delivery'}`);
    console.log(`${chalk.white('建议团队数')}: ${plan.teams.length}`);

    for (const team of plan.teams) {
        console.log(chalk.green(`\n• ${team.name} (${team.versionTrack})`));
        console.log(`  目标: ${team.objective}`);
        console.log(`  分支: ${team.branchSuggestion || `feat/${team.versionTrack}-${team.key}`}`);
        console.log(`  角色: ${Object.entries(team.roleCounts).map(([role, count]) => `${role}×${count}`).join(', ')}`);
        console.log(`  EvoMap: ${team.evoMap.tier} (${team.evoMap.score}/5, ${team.evoMap.trend})`);
        if (team.evoMap.highlights.length > 0) {
            console.log(`  亮点: ${team.evoMap.highlights.join('；')}`);
        }
        if (team.rationale.length > 0) {
            console.log(`  依据: ${team.rationale.join('；')}`);
        }
        if (team.risks.length > 0) {
            console.log(`  风险: ${team.risks.join('；')}`);
        }
    }

    if (plan.releaseGates.length > 0) {
        console.log(chalk.cyan('\n版本门禁:'));
        for (const gate of plan.releaseGates) {
            console.log(`  - ${gate.versionTrack} | ${gate.branch}`);
            console.log(`    规则: ${gate.completionRule}`);
            for (const check of gate.requiredChecks) {
                console.log(`    • ${check.component}: ${check.environments.join(' -> ')} [${check.status}]`);
            }
        }
    }

    if (plan.constraints.length > 0) {
        console.log(chalk.yellow('\n约束:'));
        for (const item of plan.constraints) {
            console.log(`  - ${item}`);
        }
    }

    if (plan.recommendations.length > 0) {
        console.log(chalk.magenta('\n建议:'));
        for (const item of plan.recommendations) {
            console.log(`  - ${item}`);
        }
    }

    console.log(chalk.gray('─'.repeat(72)));
}

function toPercent(value: number | undefined): string {
    const resolved = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return `${(resolved * 100).toFixed(1)}%`;
}

function buildAskInterviewMarkdown(input: AskInterviewContext): string {
    const now = new Date().toISOString();
    const pendingTop = input.prdContext?.pendingStories || [];
    const pendingLine = pendingTop.length > 0
        ? pendingTop.map((story) => `${story.id || 'UNKNOWN'}(${story.priority ?? '-'})`).join('、')
        : '暂无未完成故事';

    const journey = [
        '发现阶段：用户先在 PRD 中确认未完成目标，再触发 team compose 自动拆分团队。',
        `编组阶段：系统按 ${input.plan.versionTrack.toUpperCase()} 策略返回 ${input.plan.teams.length} 个建议团队，并结合历史噪声信号自动收敛角色。`,
        `执行阶段：在 ${input.target} 部署场景下并行推进 V1/V2（或单轨）任务，并通过评分/看板持续反馈。`,
        '验证阶段：QA 与发布联调组执行自动化检查，确认 API 与 Web 路由闭环。',
        '进化阶段：回填消息历史与评分数据，下一轮 compose 自动调整角色配比与风险护栏。',
    ];

    return `# ASK 用户旅程访谈（自动生成）

## 基本信息
- 生成时间: ${now}
- 目标: ${input.goal}
- 部署目标: ${input.target}
- 版本策略: ${input.plan.versionTrack}
- 编组模式: ${input.plan.mode}

## A - Assess（现状评估）
- PRD 进度: ${input.prdContext ? `${input.prdContext.completedCount}/${input.prdContext.totalStories}` : '未知'}
- 待办 Top: ${pendingLine}
- 历史信号: ready=${toPercent(input.signals.readyPingRatio)} | coordinator=${toPercent(input.signals.coordinatorMessageRatio)} | incident=${toPercent(input.signals.deploymentIncidentRatio)} | idle=${toPercent(input.signals.idleStatusRatio)} | cli=${toPercent(input.signals.cliFocusRatio)} | server=${toPercent(input.signals.serverFocusRatio)} | kanban=${toPercent(input.signals.kanbanFocusRatio)} | sample=${input.signals.historySampleSize ?? 0}
- 推断焦点: ${input.plan.inferredFocus.join(', ') || 'delivery'}

## S - Story（用户旅程）
${journey.map((item, index) => `${index + 1}. ${item}`).join('\n')}

## K - Keep Improving（迭代问答）
### Q1: 为什么要拆分多团队？
A1: 当前任务同时覆盖 aha-cli、happy-server、kanban，且存在 V1/V2 双轨发布，单团队会导致上下文切换与等待噪声放大。

### Q2: 本轮最关键的闭环是什么？
A2: 以“PRD 待办 -> 编组 -> 开发 -> 测试 -> 部署验证 -> 评分回填”为主链路，确保每一步有可追踪产物。

### Q3: 下一轮如何自动进化？
A3: 继续回填 .aha 历史与评分数据，复用 team compose 信号输入，让角色配比与风险建议动态调整。

## 建议团队拆分
${input.plan.teams.map((team, index) => `### ${index + 1}. ${team.name} (${team.versionTrack})
- 目标: ${team.objective}
- 分支建议: ${team.branchSuggestion || `feat/${team.versionTrack}-${team.key}`}
- 角色配比: ${Object.entries(team.roleCounts).map(([role, count]) => `${role}×${count}`).join('、')}
- EvoMap: ${team.evoMap.tier} / ${team.evoMap.score} (${team.evoMap.trend})
- Evo亮点: ${team.evoMap.highlights.join('；') || '无'}
- 依据: ${team.rationale.join('；') || '无'}
- 风险: ${team.risks.join('；') || '无'}
`).join('\n')}

## 版本门禁（Release Gates）
${(input.plan.releaseGates || []).map((gate, index) => `### Gate ${index + 1} - ${gate.versionTrack}
- 分支: ${gate.branch}
- 规则: ${gate.completionRule}
${gate.requiredChecks.map((check) => `  - ${check.component}: ${check.environments.join(' -> ')} [${check.status}]`).join('\n')}
`).join('\n')}

## 系统建议
${(input.plan.recommendations.length > 0 ? input.plan.recommendations : ['暂无']).map((item) => `- ${item}`).join('\n')}
`;
}

function writeAskInterviewReport(outputPathInput: string, input: AskInterviewContext): string {
    const outputPath = path.isAbsolute(outputPathInput)
        ? outputPathInput
        : path.resolve(process.cwd(), outputPathInput);

    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, buildAskInterviewMarkdown(input), 'utf8');
    return outputPath;
}

function buildSpecMarkdown(input: SpecContext): string {
    const now = new Date().toISOString();

    return `# 多团队自适应 SPEC（自动生成）

## 元信息
- 生成时间: ${now}
- 目标: ${input.goal}
- 部署目标: ${input.target}
- 版本策略: ${input.plan.versionTrack}
- 编组模式: ${input.plan.mode}

## 现状信号
- readyPingRatio: ${toPercent(input.signals.readyPingRatio)}
- coordinatorMessageRatio: ${toPercent(input.signals.coordinatorMessageRatio)}
- deploymentIncidentRatio: ${toPercent(input.signals.deploymentIncidentRatio)}
- idleStatusRatio: ${toPercent(input.signals.idleStatusRatio)}
- cliFocusRatio: ${toPercent(input.signals.cliFocusRatio)}
- serverFocusRatio: ${toPercent(input.signals.serverFocusRatio)}
- kanbanFocusRatio: ${toPercent(input.signals.kanbanFocusRatio)}
- historySampleSize: ${input.signals.historySampleSize ?? 0}

## 团队建议（EvoMap）
${input.plan.teams.map((team, index) => `### ${index + 1}. ${team.name} (${team.versionTrack})
- 目标: ${team.objective}
- 分支建议: ${team.branchSuggestion || `feat/${team.versionTrack}-${team.key}`}
- 角色配比: ${Object.entries(team.roleCounts).map(([role, count]) => `${role}×${count}`).join('、')}
- EvoMap: ${team.evoMap.tier} / ${team.evoMap.score} (${team.evoMap.trend})
- Evo亮点: ${team.evoMap.highlights.join('；') || '无'}
- 依据: ${team.rationale.join('；') || '无'}
- 风险: ${team.risks.join('；') || '无'}
`).join('\n')}

## 版本门禁
${(input.plan.releaseGates || []).map((gate, index) => `### Gate ${index + 1} - ${gate.versionTrack}
- 分支: ${gate.branch}
- 规则: ${gate.completionRule}
${gate.requiredChecks.map((check) => `  - ${check.component}: ${check.environments.join(' -> ')} [${check.status}]`).join('\n')}
`).join('\n')}

## 约束与建议
${(input.plan.constraints || []).map((item) => `- 约束: ${item}`).join('\n')}
${(input.plan.recommendations || []).map((item) => `- 建议: ${item}`).join('\n')}
`;
}

function writeSpecReport(outputPathInput: string, input: SpecContext): string {
    const outputPath = path.isAbsolute(outputPathInput)
        ? outputPathInput
        : path.resolve(process.cwd(), outputPathInput);
    const outputDir = path.dirname(outputPath);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(outputPath, buildSpecMarkdown(input), 'utf8');
    return outputPath;
}

async function composeTeams(api: ApiClient, args: string[], options: TeamCommandOptions) {
    const explicitGoal = extractComposeGoal(args);
    const versionRaw = getOptionValue(args, '--version');
    const modeRaw = getOptionValue(args, '--mode');
    const targetRaw = getOptionValue(args, '--target');
    const maxTeamsRaw = getOptionValue(args, '--max-teams');
    const historyRaw = getOptionValue(args, '--history');
    const contextRaw = getOptionValue(args, '--context');
    const prdRaw = getOptionValue(args, '--prd');
    const prdTopRaw = getOptionValue(args, '--prd-top');
    const askOutputRaw = getOptionValue(args, '--ask-output');
    const specOutputRaw = getOptionValue(args, '--spec-output');
    const outputJson = hasFlag(args, '--json');

    const allowedVersions = new Set(['v1', 'v2', 'dual']);
    const allowedModes = new Set(['single', 'multi']);
    const allowedTargets = new Set(['wow', 'uv1', 'uv2', 'local', 'generic']);

    const historyRoots = historyRaw
        ? historyRaw.split(',').map((item) => item.trim()).filter(Boolean)
        : [path.join(process.cwd(), '.aha'), path.join(process.env.HOME || '', 'work/opc/.aha')];

    const evolutionSignals = collectEvolutionSignals(historyRoots);
    const parsedMaxTeams = maxTeamsRaw ? Number(maxTeamsRaw) : undefined;
    const effectivePrdPath = prdRaw || resolveDefaultPrdPath();
    const prdContext = effectivePrdPath ? loadPrdComposeContext(effectivePrdPath, normalizeTopN(prdTopRaw)) : undefined;
    const goal = explicitGoal || prdContext?.goalSuggestion || '';

    if (!goal) {
        console.log(chalk.red('Error: 缺少目标描述'));
        console.log(chalk.yellow('Usage:'), chalk.green('aha teams compose --goal \"拆分多团队并自动编组\"'));
        console.log(chalk.yellow('Tip  :'), chalk.green('aha teams compose --prd ./ralph/prd.json'));
        process.exit(1);
    }

    const mergedContext = [contextRaw?.trim(), prdContext?.context].filter(Boolean).join('\n\n') || undefined;

    const requestPayload: TeamCompositionRequest = {
        goal,
        context: mergedContext,
        versionTrack: versionRaw && allowedVersions.has(versionRaw) ? (versionRaw as TeamCompositionRequest['versionTrack']) : undefined,
        mode: modeRaw && allowedModes.has(modeRaw) ? (modeRaw as TeamCompositionRequest['mode']) : undefined,
        deploymentTarget: targetRaw && allowedTargets.has(targetRaw) ? (targetRaw as TeamCompositionRequest['deploymentTarget']) : 'wow',
        maxTeams: typeof parsedMaxTeams === 'number' && Number.isFinite(parsedMaxTeams) ? parsedMaxTeams : undefined,
        evolutionSignals,
    };

    if (options.verbose) {
        console.log(chalk.gray(`History roots: ${historyRoots.join(', ')}`));
        console.log(chalk.gray(`Evolution signals: ${JSON.stringify(evolutionSignals)}`));
        if (prdContext) {
            console.log(chalk.gray(`PRD source: ${prdContext.sourcePath}`));
            console.log(chalk.gray(`PRD pending stories: ${prdContext.pendingStories.map((story) => story.id || 'UNKNOWN').join(', ') || 'none'}`));
            console.log(chalk.gray(`PRD progress: ${prdContext.completedCount}/${prdContext.totalStories}`));
        }
    }

    const plan = await api.composeTeams(requestPayload);

    if (askOutputRaw) {
        const reportPath = writeAskInterviewReport(askOutputRaw, {
            goal,
            target: requestPayload.deploymentTarget || 'wow',
            plan,
            signals: evolutionSignals,
            prdContext,
        });
        console.log(chalk.green(`ASK 访谈已生成: ${reportPath}`));
    }

    if (specOutputRaw) {
        const reportPath = writeSpecReport(specOutputRaw, {
            goal,
            target: requestPayload.deploymentTarget || 'wow',
            plan,
            signals: evolutionSignals,
            prdContext,
        });
        console.log(chalk.green(`SPEC 文档已生成: ${reportPath}`));
    }

    if (outputJson) {
        console.log(JSON.stringify(plan, null, 2));
        return;
    }

    printTeamCompositionPlan(plan);
}

export const __teamsComposeTestables = {
    normalizeTopN,
    extractComposeGoal,
    loadPrdComposeContext,
    collectEvolutionSignals,
    buildAskInterviewMarkdown,
    buildSpecMarkdown,
};
