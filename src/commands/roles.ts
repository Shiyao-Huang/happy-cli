/**
 * Role pool and public review commands for Aha CLI.
 */

import chalk from 'chalk';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';

type ReviewSource = 'user' | 'master' | 'system';

function getOption(args: string[], name: string): string | undefined {
  const flag = `--${name}`;
  const index = args.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

function getPositionalArgs(args: string[]): string[] {
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value.startsWith('--')) {
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        i += 1;
      }
      continue;
    }
    positional.push(value);
  }

  return positional;
}

function parseNumberOption(args: string[], name: string, fallback?: number): number | undefined {
  const raw = getOption(args, name);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`--${name} must be a valid number`);
  }
  return parsed;
}

function parseSourceOption(args: string[]): ReviewSource | undefined {
  const raw = getOption(args, 'source');
  if (!raw) {
    return undefined;
  }
  if (raw === 'user' || raw === 'master' || raw === 'system') {
    return raw;
  }
  throw new Error(`--source must be one of: user, master, system`);
}

function validateRating(value: number): void {
  if (value < 1 || value > 5) {
    throw new Error('rating must be between 1 and 5');
  }
}

function validateScore(value: number | undefined, field: string): void {
  if (value === undefined) return;
  if (value < 0 || value > 100) {
    throw new Error(`${field} must be between 0 and 100`);
  }
}

export function showRolesHelp() {
  console.log(`
${chalk.bold.cyan('Aha Roles')} - Role pool and review commands

${chalk.bold('Usage:')}
  ${chalk.green('aha roles')} <command> [options]

${chalk.bold('Commands:')}
  ${chalk.yellow('defaults')}                       List default role templates from server
  ${chalk.yellow('list')}                           List my custom roles
  ${chalk.yellow('pool')} [--search <query>]       List public role pool
  ${chalk.yellow('reviews')} <roleId>               List public reviews for one role
  ${chalk.yellow('review')} <roleId> --rating <n>  Submit a role review
  ${chalk.yellow('team-reviews')} <teamId>          List public reviews for one team
  ${chalk.yellow('team-review')} <teamId> --rating <n> Submit a team review
  ${chalk.yellow('team-score')} <teamId>            Show team cumulative scorecard
  ${chalk.yellow('recommend')} [--tech-stack <skills>] [--type <webapp|api|mobile|fullstack>] [--size <n>]  Get AI role recommendations

${chalk.bold('Review options:')}
  ${chalk.cyan('--rating <1-5>')}                  Required for review/team-review
  ${chalk.cyan('--code <0-100>')}                  Optional code score
  ${chalk.cyan('--quality <0-100>')}               Optional quality score
  ${chalk.cyan('--source <user|master|system>')}   Optional score source
  ${chalk.cyan('--comment "<text>"')}              Optional review text
  ${chalk.cyan('--team <teamId>')}                 Optional team id for role review context
  ${chalk.cyan('--roles <id1,id2>')}               Optional role ids for team-review
  ${chalk.cyan('--limit <n>')}                     Limit results (default 20/50 depending command)

${chalk.bold('Recommendation options:')}
  ${chalk.cyan('--tech-stack <skills>')}           Comma-separated tech stack (e.g., "React,TypeScript,Node.js")
  ${chalk.cyan('--type <webapp|api|mobile|fullstack>')}  Project type (default: webapp)
  ${chalk.cyan('--size <n>')}                      Team size (default: 3)
  ${chalk.cyan('--description <text>')}            Project description
  ${chalk.cyan('--timeline <text>')}               Project timeline (e.g., "1个月")
  ${chalk.cyan('--limit <n>')}                     Max recommendations (default: 5)

${chalk.bold('Examples:')}
  ${chalk.green('aha roles defaults')}
  ${chalk.green('aha roles pool --search qa --limit 20')}
  ${chalk.green('aha roles review custom-abcd1234 --rating 4.7 --code 88 --quality 91 --source user')}
  ${chalk.green('aha roles team-review team_123 --rating 4.5 --source master --comment "Solid collaboration"')}
  ${chalk.green('aha roles recommend --tech-stack "React,TypeScript,Node.js" --type fullstack --size 5')}
`);
}

export async function handleRolesCommand(args: string[]) {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showRolesHelp();
    return;
  }

  const credentials = readCredentials();
  if (!credentials) {
    console.log(chalk.yellow('Not authenticated. Please run:'), chalk.green('aha auth login'));
    process.exit(1);
  }

  const { credentials: authCredentials } = await authAndSetupMachineIfNeeded();
  const api = await ApiClient.create(authCredentials);
  const positional = getPositionalArgs(args);

  try {
    switch (subcommand) {
      case 'defaults':
        await listDefaults(api);
        break;
      case 'list':
        await listMyRoles(api, parseNumberOption(args, 'limit', 50) || 50);
        break;
      case 'pool':
        await listRolePool(api, {
          limit: parseNumberOption(args, 'limit', 50) || 50,
          search: getOption(args, 'search'),
        });
        break;
      case 'reviews':
        if (positional.length < 2) {
          throw new Error('Usage: aha roles reviews <roleId> [--limit 50]');
        }
        await listRoleReviews(api, positional[1], parseNumberOption(args, 'limit', 50) || 50);
        break;
      case 'review':
        if (positional.length < 2) {
          throw new Error('Usage: aha roles review <roleId> --rating <1-5>');
        }
        await reviewRole(api, positional[1], args);
        break;
      case 'team-reviews':
        if (positional.length < 2) {
          throw new Error('Usage: aha roles team-reviews <teamId> [--limit 50]');
        }
        await listTeamReviews(api, positional[1], parseNumberOption(args, 'limit', 50) || 50);
        break;
      case 'team-review':
        if (positional.length < 2) {
          throw new Error('Usage: aha roles team-review <teamId> --rating <1-5>');
        }
        await reviewTeam(api, positional[1], args);
        break;
      case 'team-score':
        if (positional.length < 2) {
          throw new Error('Usage: aha roles team-score <teamId>');
        }
        await showTeamScore(api, positional[1]);
        break;
      case 'recommend':
        await getRoleRecommendations(api, args);
        break;
      default:
        throw new Error(`Unknown roles command: ${subcommand}`);
    }
  } catch (error) {
    logger.debug('[RolesCommand] Error:', error);
    console.log(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function listDefaults(api: ApiClient) {
  const data = await api.listDefaultRoles();
  if (!data.roles.length) {
    console.log(chalk.yellow('No default roles returned by server.'));
    return;
  }

  console.log(chalk.bold(`\nDefault Roles (${data.roles.length})\n`));
  for (const role of data.roles) {
    const icon = role.icon ? `${role.icon} ` : '';
    console.log(`${chalk.green('-')} ${icon}${chalk.bold(role.title)} ${chalk.gray(`(${role.id})`)}`);
    console.log(chalk.gray(`  ${role.summary}`));
  }
  console.log();
}

async function listMyRoles(api: ApiClient, limit: number) {
  const data = await api.listRoles(limit);
  if (!data.roles.length) {
    console.log(chalk.yellow('No custom roles found.'));
    return;
  }

  console.log(chalk.bold(`\nMy Roles (${data.roles.length}/${data.total})\n`));
  for (const role of data.roles) {
    const visibility = role.visibility || 'public';
    const rating = role.stats?.averageRating ?? 0;
    const reviews = role.stats?.reviewCount ?? 0;
    console.log(`${chalk.green('-')} ${chalk.bold(role.title)} ${chalk.gray(`(${role.id})`)} ${chalk.cyan(`[${visibility}]`)}`);
    console.log(chalk.gray(`  rating=${rating.toFixed(2)} reviews=${reviews}`));
  }
  console.log();
}

async function listRolePool(api: ApiClient, opts: { limit: number; search?: string }) {
  const data = await api.listRolePool(opts.limit, opts.search);
  if (!data.roles.length) {
    console.log(chalk.yellow('No public roles found in pool.'));
    return;
  }

  console.log(chalk.bold(`\nPublic Role Pool (${data.roles.length}/${data.total})\n`));
  for (const role of data.roles) {
    const rating = role.stats?.averageRating ?? 0;
    const reviews = role.stats?.reviewCount ?? 0;
    const owner = role.ownerId ? role.ownerId.slice(0, 8) : 'unknown';
    console.log(`${chalk.green('-')} ${chalk.bold(role.title)} ${chalk.gray(`(${role.id})`)}`);
    console.log(chalk.gray(`  rating=${rating.toFixed(2)} reviews=${reviews} owner=${owner}`));
  }
  console.log();
}

async function listRoleReviews(api: ApiClient, roleId: string, limit: number) {
  const data = await api.listRoleReviews(roleId, limit);
  if (!data.reviews.length) {
    console.log(chalk.yellow('No reviews found for this role.'));
    return;
  }

  console.log(chalk.bold(`\nRole Reviews (${data.reviews.length}/${data.total}) for ${roleId}\n`));
  for (const review of data.reviews) {
    const when = new Date(review.createdAt).toLocaleString();
    console.log(`${chalk.green('-')} rating=${review.rating} source=${review.source || 'user'} code=${review.codeScore || 0} quality=${review.qualityScore || 0}`);
    if (review.comment) {
      console.log(chalk.gray(`  "${review.comment}"`));
    }
    console.log(chalk.gray(`  by=${review.reviewerId?.slice(0, 8) || 'unknown'} at=${when}`));
  }
  console.log();
}

async function reviewRole(api: ApiClient, roleId: string, args: string[]) {
  const rating = parseNumberOption(args, 'rating');
  if (rating === undefined) {
    throw new Error('--rating is required');
  }
  validateRating(rating);

  const code = parseNumberOption(args, 'code');
  const quality = parseNumberOption(args, 'quality');
  validateScore(code, 'code');
  validateScore(quality, 'quality');

  const source = parseSourceOption(args);
  const comment = getOption(args, 'comment');
  const teamId = getOption(args, 'team');

  const response = await api.reviewRole(roleId, {
    rating,
    codeScore: code,
    qualityScore: quality,
    source,
    comment,
    teamId,
  });

  console.log(chalk.green('Role review submitted.'));
  console.log(chalk.gray(`rating=${response.stats.averageRating.toFixed(2)} reviews=${response.stats.reviewCount} codeTotal=${response.stats.cumulativeCode} qualityTotal=${response.stats.cumulativeQuality}`));
}

async function listTeamReviews(api: ApiClient, teamId: string, limit: number) {
  const data = await api.listTeamReviews(teamId, limit);
  if (!data.reviews.length) {
    console.log(chalk.yellow('No reviews found for this team.'));
    return;
  }

  console.log(chalk.bold(`\nTeam Reviews (${data.reviews.length}/${data.total}) for ${teamId}\n`));
  for (const review of data.reviews) {
    const when = new Date(review.createdAt).toLocaleString();
    console.log(`${chalk.green('-')} rating=${review.rating} source=${review.source || 'user'} code=${review.codeScore || 0} quality=${review.qualityScore || 0}`);
    if (review.comment) {
      console.log(chalk.gray(`  "${review.comment}"`));
    }
    console.log(chalk.gray(`  by=${review.reviewerId?.slice(0, 8) || 'unknown'} at=${when}`));
  }
  console.log();
}

async function reviewTeam(api: ApiClient, teamId: string, args: string[]) {
  const rating = parseNumberOption(args, 'rating');
  if (rating === undefined) {
    throw new Error('--rating is required');
  }
  validateRating(rating);

  const code = parseNumberOption(args, 'code');
  const quality = parseNumberOption(args, 'quality');
  validateScore(code, 'code');
  validateScore(quality, 'quality');

  const source = parseSourceOption(args);
  const comment = getOption(args, 'comment');
  const roleIdsRaw = getOption(args, 'roles');
  const roleIds = roleIdsRaw
    ? roleIdsRaw.split(',').map((value) => value.trim()).filter(Boolean)
    : undefined;

  const response = await api.reviewTeam(teamId, {
    rating,
    codeScore: code,
    qualityScore: quality,
    source,
    comment,
    roleIds,
  });

  console.log(chalk.green('Team review submitted.'));
  console.log(chalk.gray(`rating=${response.scorecard.averageRating.toFixed(2)} reviews=${response.scorecard.reviewCount} codeTotal=${response.scorecard.cumulativeCode} qualityTotal=${response.scorecard.cumulativeQuality}`));
}

async function showTeamScore(api: ApiClient, teamId: string) {
  const score = await api.getTeamScore(teamId);
  console.log(chalk.bold(`\nTeam Scorecard: ${teamId}\n`));
  console.log(`${chalk.green('Average Rating:')} ${score.averageRating?.toFixed ? score.averageRating.toFixed(2) : score.averageRating}`);
  console.log(`${chalk.green('Reviews:')} ${score.reviewCount}`);
  console.log(`${chalk.green('Cumulative Code:')} ${score.cumulativeCode}`);
  console.log(`${chalk.green('Cumulative Quality:')} ${score.cumulativeQuality}`);
  console.log(`${chalk.green('Source Totals:')} user=${score.sourceScoreTotals?.user || 0}, master=${score.sourceScoreTotals?.master || 0}, system=${score.sourceScoreTotals?.system || 0}`);
  if (score.lastReviewedAt) {
    console.log(`${chalk.green('Last Reviewed:')} ${new Date(score.lastReviewedAt).toLocaleString()}`);
  }
  console.log();
}

// === V5-AI-001: Smart Role Recommendation ===

async function getRoleRecommendations(api: ApiClient, args: string[]) {
  const techStackRaw = getOption(args, 'tech-stack');
  const projectType = getOption(args, 'type') as 'webapp' | 'api' | 'mobile' | 'fullstack' | undefined;
  const teamSize = parseNumberOption(args, 'size', 3) || 3;
  const description = getOption(args, 'description');
  const timeline = getOption(args, 'timeline');
  const limit = parseNumberOption(args, 'limit', 5) || 5;

  if (!techStackRaw) {
    throw new Error('--tech-stack is required. Example: --tech-stack "React,TypeScript,Node.js"');
  }

  const techStack = techStackRaw.split(',').map(s => s.trim()).filter(Boolean);
  const validTypes = ['webapp', 'api', 'mobile', 'fullstack'];
  const finalProjectType = projectType && validTypes.includes(projectType) ? projectType : 'webapp';

  console.log(chalk.bold('\n🧠 AI Role Recommendations\n'));
  console.log(chalk.gray(`Project: ${finalProjectType} | Team Size: ${teamSize}`));
  console.log(chalk.gray(`Tech Stack: ${techStack.join(', ')}`));
  if (description) console.log(chalk.gray(`Description: ${description}`));
  if (timeline) console.log(chalk.gray(`Timeline: ${timeline}`));
  console.log();

  try {
    const response = await api.getRoleRecommendations({
      techStack,
      teamSize,
      projectType: finalProjectType,
      description,
      timeline,
      maxRecommendations: limit
    });

    if (!response.success || !response.recommendations.length) {
      console.log(chalk.yellow('No recommendations found.'));
      return;
    }

    console.log(chalk.bold(`Found ${response.recommendations.length} recommended roles:\n`));

    for (let i = 0; i < response.recommendations.length; i++) {
      const rec = response.recommendations[i];
      const rank = i + 1;
      const scoreColor = rec.matchScore >= 80 ? chalk.green : rec.matchScore >= 60 ? chalk.yellow : chalk.red;

      console.log(`${chalk.bold.cyan(`#${rank}`)} ${chalk.bold(rec.role.name)} ${chalk.gray(`(${rec.role.category})`)}`);
      console.log(`   ${chalk.green('Match:')} ${scoreColor(`${rec.matchScore}%`)}`);

      if (rec.role.rating) {
        console.log(`   ${chalk.green('Rating:')} ${chalk.cyan(`${rec.role.rating}/5`)}`);
      }
      if (rec.role.completedTasks) {
        console.log(`   ${chalk.green('Tasks:')} ${rec.role.completedTasks}`);
      }

      console.log(`   ${chalk.green('Skills:')} ${rec.role.assignedSkills.join(', ')}`);

      if (rec.reasons.length > 0) {
        console.log(`   ${chalk.green('Reasons:')} ${rec.reasons.join('; ')}`);
      }

      if (rec.skillMatch.matched.length > 0) {
        console.log(`   ${chalk.green('Matched:')} ${chalk.green(rec.skillMatch.matched.join(', '))}`);
      }
      if (rec.skillMatch.missing.length > 0) {
        console.log(`   ${chalk.yellow('Missing:')} ${chalk.yellow(rec.skillMatch.missing.join(', '))}`);
      }

      console.log();
    }

    console.log(chalk.gray('Tip: Use these recommendations to build your team composition.'));
    console.log();
  } catch (error) {
    console.log(chalk.red('Failed to get recommendations:'), error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}
