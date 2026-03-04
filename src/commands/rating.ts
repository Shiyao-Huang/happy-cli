import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';

function getOption(args: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function parseNumberOption(args: string[], name: string): number | undefined {
  const raw = getOption(args, name);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a valid number`);
  }
  return parsed;
}

function parseSourceOption(args: string[]): 'user' | 'master' | 'system' | undefined {
  const raw = getOption(args, 'source');
  if (!raw) {
    return undefined;
  }
  if (raw === 'user' || raw === 'master' || raw === 'system') {
    return raw;
  }
  throw new Error('--source must be one of: user, master, system');
}

function validateRating(value: number | undefined, name: string): void {
  if (value === undefined) {
    return;
  }
  if (value < 1 || value > 5) {
    throw new Error(`${name} must be between 1 and 5`);
  }
}

// ── Visual helpers ─────────────────────────────────────────────────────────────

/**
 * Renders a filled progress bar for a value against a maximum.
 * Example output: ████████░░  80%
 */
function renderBar(value: number, maxValue: number, width = 10): string {
  const pct = maxValue > 0 ? Math.min(1, value / maxValue) : 0;
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
  return `${bar}  ${Math.round(pct * 100)}%`;
}

/**
 * Returns a colored arrow string showing score delta direction.
 */
function trendArrow(delta: number): string {
  if (delta > 0) return chalk.green(`↑${delta}`);
  if (delta < 0) return chalk.red(`↓${Math.abs(delta)}`);
  return chalk.gray('→0');
}

// ── Help ──────────────────────────────────────────────────────────────────────

export function showRatingHelp(): void {
  console.log(`
${chalk.bold.cyan('Aha Rating')} - Team/role rating workflows

${chalk.bold('Usage:')}
  ${chalk.green('aha rating')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('performance')} [--team <id>] [--period 7d]    Show AI team performance score
  ${chalk.yellow('leaderboard')} [--window 7d|30d|all]           Team performance leaderboard
  ${chalk.yellow('team')} <teamId>                               Show team scorecard (legacy)
  ${chalk.yellow('role')} <roleId>                               Show role rating summary
  ${chalk.yellow('submit')} --team <id> --role <id>              Submit rating record
  ${chalk.yellow('auto')} --role <id>                            Run system auto-rating

${chalk.bold('Examples:')}
  ${chalk.green('aha rating performance --team team_123')}
  ${chalk.green('aha rating performance --team team_123 --period 30d')}
  ${chalk.green('aha rating leaderboard --window 30d')}
  ${chalk.green('aha rating team team_123 --analytics')}
  ${chalk.green('aha rating role implementer --team team_123')}
  ${chalk.green('aha rating submit --team team_123 --role implementer --user 4 --master 5 --code-lines 240 --commits 6')}
  ${chalk.green('aha rating auto --role implementer --team team_123 --code-lines 180 --commits 4 --bugs 1 --persist')}
`);
}

// ── Command dispatcher ─────────────────────────────────────────────────────────

export async function handleRatingCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showRatingHelp();
    return;
  }

  const credentials = readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not authenticated. Please run:'), chalk.green('aha auth login'));
    process.exit(1);
  }

  const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
  const api = await ApiClient.create(authCredentials);

  try {
    switch (subcommand) {
      case 'performance':
        await showPerformance(api, args);
        break;
      case 'leaderboard':
        await showLeaderboard(api, args);
        break;
      case 'team':
        await showTeamRating(api, args);
        break;
      case 'role':
        await showRoleRating(api, args);
        break;
      case 'submit':
        await submitRating(api, args);
        break;
      case 'auto':
        await runAutoRating(api, args);
        break;
      default:
        throw new Error(`Unknown rating command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[RatingCommand] Error:', error);
    console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

// ── performance subcommand ─────────────────────────────────────────────────────

/**
 * Displays a visual auto-rating dashboard for a team.
 *
 * Usage: aha rating performance --team <teamId> [--period 7d|30d]
 *
 * Fetches the server-computed auto-rating and renders a progress-bar dashboard
 * showing the four scoring dimensions plus trend information.
 */
async function showPerformance(api: ApiClient, args: string[]): Promise<void> {
  const teamId = getOption(args, 'team');
  if (!teamId) {
    throw new Error('Usage: aha rating performance --team <teamId> [--period 7d|30d]');
  }

  const periodRaw = getOption(args, 'period') ?? '7d';
  const daysMatch = periodRaw.match(/^(\d+)d$/);
  const days = daysMatch ? parseInt(daysMatch[1], 10) : 7;

  const result = await api.getAutoRating(teamId, days);

  // Attempt to compute period-over-period delta from history
  let prevScore: number | undefined;
  try {
    const hist = await api.getAutoRatingHistory(teamId, 2);
    if (Array.isArray(hist?.history) && hist.history.length >= 2) {
      const prev = hist.history[hist.history.length - 2] as { overallScore?: number };
      prevScore = typeof prev.overallScore === 'number' ? prev.overallScore : undefined;
    }
  } catch {
    // delta not available; silently skip
  }

  const overall: number = result?.overallScore ?? 0;
  const confidence: number = Math.round((result?.confidence ?? 0) * 100);
  const dims = result?.dimensions ?? {};

  const taskScore: number = dims?.taskCompletionRate?.score ?? 0;
  const qualityScore: number = dims?.responseQuality?.score ?? 0;
  const effScore: number = dims?.efficiencyScore?.score ?? 0;
  const relScore: number = dims?.reliability?.score ?? 0;

  const deltaStr =
    prevScore !== undefined
      ? `  (${trendArrow(Math.round(overall - prevScore))} from last period)`
      : '';

  // Trend label: based on average confidence across all four dims
  const avgConfidence =
    ((dims?.taskCompletionRate?.confidence ?? 0) +
      (dims?.responseQuality?.confidence ?? 0) +
      (dims?.efficiencyScore?.confidence ?? 0) +
      (dims?.reliability?.confidence ?? 0)) /
    4;

  const trendLabel =
    avgConfidence >= 0.7
      ? chalk.green('Improving')
      : avgConfidence >= 0.4
      ? chalk.yellow('Stabilizing')
      : chalk.gray('Insufficient data');

  console.log('');
  console.log(chalk.bold.cyan('Team Performance'));
  console.log(chalk.gray('═══════════════════════════════════'));
  console.log('');
  console.log(`${chalk.bold('Overall Score:')} ${chalk.bold.white(Math.round(overall))}/100${deltaStr}`);
  console.log(`${chalk.bold('Confidence:')}    ${confidence}%`);
  console.log('');
  console.log(`${chalk.yellow('Task Completion: ')} ${renderBar(taskScore, 25)}`);
  console.log(`${chalk.yellow('Response Quality:')} ${renderBar(qualityScore, 25)}`);
  console.log(`${chalk.yellow('Efficiency:      ')} ${renderBar(effScore, 25)}`);
  console.log(`${chalk.yellow('Reliability:     ')} ${renderBar(relScore, 25)}`);
  console.log('');
  console.log(`Trend: ${trendLabel} (${days} day avg)`);
  console.log('');
}

// ── leaderboard subcommand ─────────────────────────────────────────────────────

/**
 * Displays the team performance leaderboard sorted by overall score.
 *
 * Usage: aha rating leaderboard [--window 7d|30d|all] [--limit N]
 */
async function showLeaderboard(api: ApiClient, args: string[]): Promise<void> {
  const windowRaw = getOption(args, 'window') ?? '7d';
  const timeWindow: '7d' | '30d' | 'all' =
    windowRaw === '30d' ? '30d' : windowRaw === 'all' ? 'all' : '7d';
  const limit = parseNumberOption(args, 'limit') ?? 20;

  const result = await api.getAutoRatingLeaderboard(timeWindow, limit);
  const entries: Array<{
    teamId: string;
    overallScore: number;
    confidence: number;
    sampleSize: number;
  }> = result?.entries ?? [];

  console.log('');
  console.log(chalk.bold.cyan(`Team Performance Leaderboard (${timeWindow})`));
  console.log(chalk.gray('════════════════════════════════════════════════'));
  console.log('');

  if (entries.length === 0) {
    console.log(chalk.gray('No teams with rating data in this time window.'));
    console.log('');
    return;
  }

  entries.forEach((entry, idx) => {
    const rank = String(idx + 1).padStart(2, '0');
    const score = Math.round(entry.overallScore);
    const conf = Math.round((entry.confidence ?? 0) * 100);
    console.log(
      `${chalk.cyan(rank)}. ${chalk.bold(entry.teamId.slice(0, 16).padEnd(16))}  ` +
      `Score: ${chalk.bold.white(String(score).padStart(3))}/100  ` +
      `Confidence: ${conf}%  ` +
      `Samples: ${entry.sampleSize}`
    );
  });

  console.log('');
}

// ── Legacy subcommands ─────────────────────────────────────────────────────────

async function showTeamRating(api: ApiClient, args: string[]): Promise<void> {
  const teamId = args[1];
  if (!teamId) {
    throw new Error('Usage: aha rating team <teamId> [--analytics] [--limit 20]');
  }

  const score = await api.getTeamScore(teamId);
  console.log(chalk.bold(`\nTeam Rating: ${teamId}\n`));
  console.log(`${chalk.green('Average:')} ${score.averageRating?.toFixed ? score.averageRating.toFixed(2) : score.averageRating}`);
  console.log(`${chalk.green('Reviews:')} ${score.reviewCount}`);
  console.log(`${chalk.green('Code Σ:')} ${score.cumulativeCode}`);
  console.log(`${chalk.green('Quality Σ:')} ${score.cumulativeQuality}`);
  console.log(`${chalk.green('Source Totals:')} user=${score.sourceScoreTotals?.user || 0}, master=${score.sourceScoreTotals?.master || 0}, system=${score.sourceScoreTotals?.system || 0}`);

  const limit = parseNumberOption(args, 'limit') || 20;
  const history = await api.getRatingHistory(teamId, limit);
  console.log(chalk.bold(`\nRecent Ratings (${history.ratings.length}/${history.total})`));
  for (const item of history.ratings.slice(0, limit)) {
    const when = new Date(item.createdAt).toLocaleString();
    console.log(`${chalk.green('-')} ${item.roleId} rating=${item.rating} code=${item.codeLines} commits=${item.commits} bugs=${item.bugsCount} @ ${when}`);
  }

  if (hasFlag(args, 'analytics')) {
    const analytics = await api.getRatingAnalytics(teamId);
    console.log(chalk.bold('\nAnalytics'));
    console.log(`${chalk.green('Total Ratings:')} ${analytics.totalRatings}`);
    console.log(`${chalk.green('Avg Quality:')} ${analytics.averageQualityScore}`);
    for (const role of analytics.roleBreakdown || []) {
      console.log(`  ${chalk.cyan(role.roleId)} avg=${role.averageRating} count=${role.totalRatings}`);
    }
  }
  console.log();
}

async function showRoleRating(api: ApiClient, args: string[]): Promise<void> {
  const roleId = args[1];
  if (!roleId) {
    throw new Error('Usage: aha rating role <roleId> [--team <teamId>] [--limit 50]');
  }

  const teamId = getOption(args, 'team');
  const limit = parseNumberOption(args, 'limit') || 50;

  if (teamId) {
    const history = await api.getRoleRatingHistory(teamId, roleId, limit);
    const avg =
      history.total > 0
        ? history.ratings.reduce((sum: number, item: { rating: number }) => sum + item.rating, 0) /
          history.total
        : 0;
    console.log(chalk.bold(`\nRole Rating: ${roleId} (team=${teamId})\n`));
    console.log(`${chalk.green('Average:')} ${avg.toFixed(2)} (${history.total} ratings)`);
    for (const item of history.ratings.slice(0, limit)) {
      const when = new Date(item.createdAt).toLocaleString();
      console.log(`${chalk.green('-')} rating=${item.rating} source=${item.source || 'system'} quality=${item.qualityScore} @ ${when}`);
    }
    console.log();
    return;
  }

  const reviews = await api.listRoleReviews(roleId, limit);
  const avg =
    reviews.total > 0
      ? reviews.reviews.reduce((sum: number, review: { rating: number }) => sum + review.rating, 0) /
        reviews.total
      : 0;

  console.log(chalk.bold(`\nRole Rating: ${roleId}\n`));
  console.log(`${chalk.green('Average:')} ${avg.toFixed(2)} (${reviews.total} reviews)`);
  for (const review of reviews.reviews.slice(0, limit)) {
    const when = new Date(review.createdAt).toLocaleString();
    console.log(`${chalk.green('-')} rating=${review.rating} source=${review.source || 'user'} code=${review.codeScore || 0} quality=${review.qualityScore || 0} @ ${when}`);
  }
  console.log();
}

async function submitRating(api: ApiClient, args: string[]): Promise<void> {
  const teamId = getOption(args, 'team');
  const roleId = getOption(args, 'role');
  if (!teamId || !roleId) {
    throw new Error('Usage: aha rating submit --team <teamId> --role <roleId> [--user <1-5>] [--master <1-5>] [--system <1-5>] [--rating <1-5>]');
  }

  const rating = parseNumberOption(args, 'rating');
  const userRating = parseNumberOption(args, 'user');
  const masterRating = parseNumberOption(args, 'master');
  const systemRating = parseNumberOption(args, 'system');
  validateRating(rating, 'rating');
  validateRating(userRating, 'user');
  validateRating(masterRating, 'master');
  validateRating(systemRating, 'system');

  const response = await api.createRatingRecord({
    teamId,
    roleId,
    taskId: getOption(args, 'task'),
    rating,
    userRating,
    masterRating,
    systemRating,
    codeLines: parseNumberOption(args, 'code-lines') || 0,
    commits: parseNumberOption(args, 'commits') || 0,
    bugsCount: parseNumberOption(args, 'bugs') || 0,
    qualityScore: parseNumberOption(args, 'quality') || 0,
    source: parseSourceOption(args) || 'system',
    comment: getOption(args, 'comment'),
  });

  console.log(chalk.green('Rating record submitted.'));
  console.log(chalk.gray(`id=${response.rating.id} role=${response.rating.roleId} rating=${response.rating.rating}`));
}

async function runAutoRating(api: ApiClient, args: string[]): Promise<void> {
  const roleId = getOption(args, 'role');
  if (!roleId) {
    throw new Error('Usage: aha rating auto --role <roleId> [--team <teamId>] --code-lines <n> --commits <n> [--bugs <n>] [--persist]');
  }

  const response = await api.calculateSystemRating({
    roleId,
    teamId: getOption(args, 'team'),
    taskId: getOption(args, 'task'),
    codeLines: parseNumberOption(args, 'code-lines') || 0,
    commits: parseNumberOption(args, 'commits') || 0,
    bugsCount: parseNumberOption(args, 'bugs') || 0,
    filesChanged: parseNumberOption(args, 'files-changed') || 0,
    reviewComments: parseNumberOption(args, 'review-comments') || 0,
    testCoverage: parseNumberOption(args, 'coverage'),
    persist: hasFlag(args, 'persist'),
  });

  console.log(chalk.green('System rating calculated.'));
  console.log(chalk.gray(`rating=${response.result.rating} codeScore=${response.result.codeScore} qualityScore=${response.result.qualityScore} persisted=${response.persisted}`));
}

export const __ratingTestables = {
  getOption,
  hasFlag,
  parseNumberOption,
  parseSourceOption,
  validateRating,
  renderBar,
  trendArrow,
  showTeamRating,
  showRoleRating,
  showLeaderboard,
  showPerformance,
  submitRating,
  runAutoRating,
};
