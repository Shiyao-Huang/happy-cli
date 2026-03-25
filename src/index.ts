#!/usr/bin/env node

/**
 * CLI entry point for aha command
 *
 * Simple argument parsing without any CLI framework dependencies
 */


import chalk from 'chalk'
import { runClaude, StartOptions } from '@/claude/runClaude'
import { logger } from './ui/logger'
import { readCredentials } from './persistence'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import packageJson from '../package.json'
import { z } from 'zod'
import { startDaemon } from './daemon/run'
import { checkIfDaemonRunningAndCleanupStaleState, isDaemonRunningCurrentlyInstalledAhaVersion, stopDaemon } from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayAhaProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { ApiClient } from './api/api'
import { runDoctorCommand } from './ui/doctor'
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { spawnAhaCLI } from './utils/spawnAhaCLI'
import { claudeCliPath } from './claude/claudeLocal'
import { execFileSync } from 'node:child_process'

/**
 * Show general CLI help
 * Displays all available commands with descriptions
 */
function showGeneralHelp() {
  const version = packageJson.version

  console.log(`
${chalk.bold.cyan('Aha CLI')} - Claude Code wrapper with team collaboration
${chalk.gray(`Version ${version}`)}

${chalk.bold('Usage:')}
  ${chalk.green('aha')} <command> [options]
  ${chalk.green('aha')} <command> --help     Show command-specific help
  ${chalk.green('aha')} --help              Show this help message
  ${chalk.green('aha')} --version           Show version number

${chalk.bold('Available Commands:')}
  ${chalk.yellow('doctor')} [clean]           Run diagnostics or cleanup stray processes
  ${chalk.yellow('auth')} [login|logout]      Authentication management
  ${chalk.yellow('connect')} [list|remove|<vendor>] AI vendor API key management
  ${chalk.yellow('channels')} [status|weixin] WeChat channel management
  ${chalk.yellow('task(s)')} [list|create|update|delete|start|complete|done] Task management
  ${chalk.yellow('team(s)')} [list|show|status|create|members|archive|delete|spawn] Team management
  ${chalk.yellow('agent(s)')} [list|show|create|kill|update|archive|delete|spawn] Agent session management
  ${chalk.yellow('sessions')} [list|show|archive|delete] Direct session management
  ${chalk.yellow('trace')} [team|session|task|member|run|errors] Unified trace timeline
  ${chalk.yellow('usage')} [session|team]      Token usage and cost analysis
  ${chalk.yellow('channels')} [status|weixin]  WeChat / IM channel bridge management
  ${chalk.yellow('role(s)')} [defaults|list|pool|review|team-score] Role pool and public review
  ${chalk.yellow('codex')}                   Start team collaboration mode
  ${chalk.yellow('ralph')} [start|status|stop] Ralph autonomous loop
  ${chalk.yellow('notify')} -p <msg> [-t <t>] Send push notification
  ${chalk.yellow('daemon')} [list|stop]      Background service management

${chalk.bold('Options:')}
  ${chalk.cyan('-h, --help')}              Show help information
  ${chalk.cyan('-v, --version')}           Show version number
  ${chalk.cyan('--debug')}                 Enable debug logging

${chalk.bold('Documentation:')}
  GitHub: ${chalk.blue.underline('https://github.com/slopus/aha')}
  Docs:  ${chalk.blue.underline('https://github.com/slopus/aha/blob/main/README.md')}

${chalk.bold('Examples:')}
  ${chalk.gray('# Diagnose and clean up')}
  ${chalk.green('aha doctor')}
  ${chalk.green('aha doctor clean')}

  ${chalk.gray('# Authentication')}
  ${chalk.green('aha auth login')}
  ${chalk.green('aha auth logout')}

  ${chalk.gray('# WeChat channel')}
  ${chalk.green('aha channels status')}
  ${chalk.green('aha channels weixin login')}

  ${chalk.gray('# Team collaboration')}
  ${chalk.green('aha codex')}

  ${chalk.gray('# Team CRUD')}
  ${chalk.green('aha team create --name \"Sprint Crew\"')}
  ${chalk.green('aha team status team_123')}
  ${chalk.green('aha agent list --active')}
  ${chalk.green('aha task done task_123 --team team_123')}
  ${chalk.green('aha sessions list --active')}

  ${chalk.gray('# Notifications')}
  ${chalk.green('aha notify -p "Build complete!"')}

  ${chalk.gray('# Claude Code with custom message')}
  ${chalk.green('aha')} "Implement a feature" ${chalk.cyan('--message')}

For command-specific help, run:
  ${chalk.green('aha <command> --help')}
`)
  process.exit(0)
}


(async () => {
  const args = process.argv.slice(2)

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting aha CLI with args: ', process.argv)
  }

  // Check if first argument is a subcommand
  const subcommand = args[0]

  // Show general help if no arguments or --help
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    showGeneralHelp();
    return;
  }

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayAhaProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
      process.exit(0)
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'channels' || subcommand === 'channel') {
    try {
      const { handleChannelsCommand } = await import('./commands/channels');
      await handleChannelsCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'tasks' || subcommand === 'task') {
    // Handle task management commands
    try {
      const { handleTasksCommand } = await import('./commands/tasks');
      await handleTasksCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'teams' || subcommand === 'team') {
    // Handle teams management commands
    try {
      const { handleTeamsCommand } = await import('./commands/teams');
      await handleTeamsCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'agents' || subcommand === 'agent') {
    try {
      const { handleAgentsCommand } = await import('./commands/agents');
      await handleAgentsCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'sessions' || subcommand === 'session') {
    try {
      const { handleSessionsCommand } = await import('./commands/sessions');
      await handleSessionsCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'roles' || subcommand === 'role') {
    // Handle role pool and review commands
    try {
      const { handleRolesCommand } = await import('./commands/roles');
      await handleRolesCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'trace') {
    try {
      const { handleTraceCommand } = await import('./commands/trace');
      await handleTraceCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'usage') {
    try {
      const { handleUsageCommand } = await import('./commands/usage');
      await handleUsageCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'channels' || subcommand === 'channel') {
    try {
      const { channelsCommand } = await import('./commands/channels');
      await channelsCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'reflexivity') {
    try {
      const { handleReflexivityCommand } = await import('./reflexivity/command');
      await handleReflexivityCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      const { runCodex } = await import('@/codex/runCodex');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      let sessionTag: string | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        } else if (args[i] === '--session-tag') {
          sessionTag = args[++i];
        }
      }

      const {
        credentials
      } = await authAndSetupMachineIfNeeded();
      await runCodex({ credentials, startedBy, sessionTag });
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'ralph') {
    // Handle ralph autonomous loop command
    try {
      const { handleRalphCommand } = await import('./ralph/command.js');
      await handleRalphCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(chalk.yellow('Note: "aha logout" is deprecated. Use "aha auth logout" instead.\n'));
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1]

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions()

        if (sessions.length === 0) {
          console.log('No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)')
        } else {
          console.log('Active sessions:')
          console.log(JSON.stringify(sessions, null, 2))
        }
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2]
      if (!sessionId) {
        console.error('Session ID required')
        process.exit(1)
      }

      try {
        const success = await stopDaemonSession(sessionId)
        console.log(success ? 'Session stopped' : 'Failed to stop session')
      } catch (error) {
        console.log('No daemon running')
      }
      return

    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnAhaCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await startDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon()
      process.exit(0)
    } else if (daemonSubcommand === 'status') {
      // Show daemon-specific doctor output
      await runDoctorCommand('daemon')
      process.exit(0)
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog()
      if (!latest) {
        console.log('No daemon logs found')
      } else {
        console.log(latest.path)
      }
      process.exit(0)
    } else if (daemonSubcommand === 'install') {
      try {
        await install()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall()
      } catch (error) {
        console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
        process.exit(1)
      }
    } else {
      console.log(`
${chalk.bold('aha daemon')} - Daemon management

${chalk.bold('Usage:')}
  aha daemon start              Start the daemon (detached)
  aha daemon stop               Stop the daemon (sessions stay alive)
  aha daemon status             Show daemon status
  aha daemon list               List active sessions

  If you want to kill all aha related processes run
  ${chalk.cyan('aha doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('aha doctor clean')}
`)
    }
    return;
  } else {

    // If the first argument is claude or cli, remove it
    if (args.length > 0 && (args[0] === 'claude' || args[0] === 'cli')) {
      args.shift()
    }

    // Parse command line arguments for main command
    const options: StartOptions = {}
    let showHelp = false
    let showVersion = false
    const unknownArgs: string[] = [] // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i]

      if (arg === '-h' || arg === '--help') {
        showHelp = true
        // Also pass through to claude
        unknownArgs.push(arg)
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg)
      } else if (arg === '--aha-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i])
      } else if (arg === '--yolo') {
        // Shortcut for --dangerously-skip-permissions
        unknownArgs.push('--dangerously-skip-permissions')
        options.permissionMode = 'bypassPermissions'
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal'
      } else if (arg === '--session-tag') {
        options.sessionTag = args[++i]
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg)
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i])
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs]
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('aha')} - Claude Code On the Go

${chalk.bold('Usage:')}
  aha [options]         Start Claude with mobile control
  aha auth              Manage authentication
  aha codex             Start Codex mode
  aha connect           Connect AI vendor API keys
  aha channels          Manage WeChat / IM channel bridge
  aha tasks             Manage team tasks from the CLI
  aha notify            Send push notification
  aha daemon            Manage background service that allows
                            to spawn new sessions away from your computer
  aha doctor            System diagnostics & troubleshooting

${chalk.bold('Examples:')}
  aha                    Start session
  aha --yolo             Start with bypassing permissions
                            aha sugar for --dangerously-skip-permissions
  aha auth login --force Authenticate
  aha doctor             Run diagnostics

${chalk.bold('Aha supports ALL Claude options!')}
  Use any claude flag with aha as you would with claude. Our favorite:

  aha --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`)

      // Run claude --help and display its output
      // Use execFileSync with the current Node executable for cross-platform compatibility
      try {
        const claudeHelp = execFileSync(process.execPath, [claudeCliPath, '--help'], { encoding: 'utf8' })
        console.log(claudeHelp)
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'))
      }

      process.exit(0)
    }

    // Show version
    if (showVersion) {
      console.log(`aha version: ${packageJson.version}`)
      process.exit(0)
    }

    // Normal flow - auth and machine setup
    const {
      credentials
    } = await authAndSetupMachineIfNeeded();

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring Aha background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledAhaVersion())) {
      logger.debug('Starting Aha background service...');

      try {
        // Use the built binary to spawn daemon
        const daemonProcess = spawnAhaCLI(['daemon', 'start-sync'], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        })
        daemonProcess.unref();

        // Give daemon a moment to write PID & port file
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        logger.debug('Failed to start daemon (non-fatal):', error);
        console.log(chalk.yellow('Warning: Could not start background service. Some features may be limited.'));
      }
    }

    // Start the CLI
    try {
      await runClaude(credentials, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }
})();


/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''
  let showHelp = false

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(1)
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('aha notify')} - Send notification

${chalk.bold('Usage:')}
  aha notify -p <message> [-t <title>]    Send notification with custom message and optional title
  aha notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Aha")

${chalk.bold('Examples:')}
  aha notify -p "Deployment complete!"
  aha notify -p "System update complete" -t "Server Status"
  aha notify -t "Alert" -p "Database connection restored"
`)
    return
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message" to specify the notification text.'))
    console.log(chalk.gray('Run "aha notify --help" for usage information.'))
    process.exit(1)
  }

  // Load credentials
  let credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "aha auth login" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('📱 Sending push notification...'))

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Aha"
    const notificationTitle = title || 'Aha'

    // Send the push notification
    api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('✓ Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))
    console.log(chalk.gray('  Check your mobile device for the notification.'))

    // Give a moment for the async operation to start
    await new Promise(resolve => setTimeout(resolve, 1000))

  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'))
    throw error
  }
}
