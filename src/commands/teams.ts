/**
 * Team management commands for Aha CLI
 * Provides commands for archiving, deleting, and managing teams
 */

import chalk from 'chalk';
import { ApiClient } from '@/api/api';
import { logger } from '@/ui/logger';
import { readCredentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { stopDaemonTeamSessions } from '@/daemon/controlClient';
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient';

interface TeamCommandOptions {
    force?: boolean;
    verbose?: boolean;
}

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

${chalk.bold('Options:')}
  ${chalk.cyan('--force, -f')}                Skip confirmation prompts
  ${chalk.cyan('--verbose, -v')}              Show detailed output
  ${chalk.cyan('--help, -h')}                 Show this help message

${chalk.bold('Examples:')}
  ${chalk.gray('# List all teams')}
  ${chalk.green('aha teams list')}

  ${chalk.gray('# Archive a team (with confirmation)')}
  ${chalk.green('aha teams archive team_abc123')}

  ${chalk.gray('# Delete a team (skip confirmation)')}
  ${chalk.green('aha teams delete team_abc123 --force')}

  ${chalk.gray('# Rename a team')}
  ${chalk.green('aha teams rename team_abc123 "New Team Name"')}

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
