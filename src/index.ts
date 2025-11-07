#!/usr/bin/env node

/**
 * CLI entry point for happy command
 *
 * Simple argument parsing without any CLI framework dependencies
 */

import chalk from 'chalk';
import { runClaude, StartOptions } from '@/claude/runClaude';
import { logger } from './ui/logger';
import { readCredentials } from './persistence';
import { authAndSetupMachineIfNeeded } from './ui/auth';
import packageJson from '../package.json';
import { z } from 'zod';
import { startDaemon } from './daemon/run';
import {
  checkIfDaemonRunningAndCleanupStaleState,
  isDaemonRunningCurrentlyInstalledHappyVersion,
  stopDaemon,
} from './daemon/controlClient';
import { getLatestDaemonLog } from './ui/logger';
import { killRunawayHappyProcesses } from './daemon/doctor';
import { install } from './daemon/install';
import { uninstall } from './daemon/uninstall';
import { ApiClient } from './api/api';
import { runDoctorCommand } from './ui/doctor';
import { listDaemonSessions, stopDaemonSession } from './daemon/controlClient';
import { handleAuthCommand } from './commands/auth';
import { handleConnectCommand } from './commands/connect';
import { handleTokenStatsCli } from './commands/token-stats-cli';
import { handleModelSwitchCli } from './commands/model-switch-cli';
import { handleDashboardCli } from './commands/dashboard-cli';
import { handleSessionMonitorCli } from './commands/session-monitor-cli';
import { spawnHappyCLI } from './utils/spawnHappyCLI';
import { claudeCliPath } from './claude/claudeLocal';
import { execFileSync } from 'node:child_process';

(async () => {
  let args = process.argv.slice(2);

  // If --version is passed - do not log, its likely daemon inquiring about our version
  if (!args.includes('--version')) {
    logger.debug('Starting happy CLI with args: ', process.argv);
  }

  // Handle ccglm, ccmm, cckimi commands (passed as first argument by bin/happy.mjs)
  const firstArg = args[0];
  if (firstArg === 'ccglm' || firstArg === 'ccmm' || firstArg === 'cckimi') {
    // Remove the command name from args and process as ultra-simple command
    const commandArgs = args.slice(1);
    await handleUltraSimpleCommand(firstArg, commandArgs);
    return;
  } else if (firstArg === 'happy') {
    // If first arg is 'happy', remove it (it's the command wrapper)
    args = args.slice(1);
  }

  // Check for --yolo --to combination (in any order) - before other command handlers
  const hasYoloFlag = args.includes('--yolo');
  const hasToFlag = args.includes('--to');
  const toIndex = args.indexOf('--to');
  const yoloIndex = args.indexOf('--yolo');
  const yoloToCombo = hasYoloFlag && hasToFlag && toIndex > -1;

  // If --yolo --to combo is detected (in any order), switch model and continue to main flow
  if (yoloToCombo) {
    // Find the model name - it should be between --yolo and --to, or right after --to
    const getModelName = () => {
      if (toIndex > -1 && toIndex < args.length - 1) {
        const candidate = args[toIndex + 1];
        if (candidate && !candidate.startsWith('-')) {
          return candidate;
        }
      }
      if (yoloIndex > -1 && yoloIndex < args.length - 1) {
        const candidate = args[yoloIndex + 1];
        if (candidate && !candidate.startsWith('-')) {
          return candidate;
        }
      }
      return null;
    };

    const modelName = getModelName();
    if (!modelName) {
      console.error(chalk.red('Error: --to requires a model name'));
      process.exit(1);
    }

    const { getModelManager } = await import('./claude/sdk/modelManager');
    const modelManager = getModelManager();
    const success = modelManager.switchModel(modelName);

    if (!success) {
      console.error(chalk.red(`Error: Failed to switch to model "${modelName}"`));
      process.exit(1);
    }

    console.log(chalk.green(`✓ Switched to model "${modelName}" and starting session...`));
    // Don't return here - continue to main flow to start Claude
  }

  // Check for top-level model and token commands first
  const hasModelCommand =
    args.includes('--toadd') ||
    args.includes('--toadd') ||
    args.includes('--seeall') ||
    args.includes('--see') ||
    args.includes('--del') ||
    args.includes('--upd') ||
    args.includes('--auto') ||
    args.includes('--exp') ||
    args.includes('--imp') ||
    args.includes('--format') ||
    args.includes('--to');
  const hasTokenCommand =
    args.includes('--stats') ||
    args.includes('--f') ||
    args.includes('--since') ||
    args.includes('--until') ||
    args.includes('daily') ||
    args.includes('weekly') ||
    args.includes('monthly') ||
    args.includes('session') ||
    args.includes('--watch');
  const hasDashboardCommand = args.includes('--dashboard');

  // Handle top-level model-switch commands
  if (hasModelCommand) {
    try {
      // Special case: --to without a model name - show current/default model
      if (args.includes('--to') && !args.some((arg, i) => arg === '--to' && i + 1 < args.length)) {
        const { getModelManager } = await import('./claude/sdk/modelManager');
        const modelManager = getModelManager();
        const active = modelManager.getActiveProfile();

        if (active) {
          console.log(`${chalk.bold('Current Active Model:')}`);
          console.log(`  ${chalk.cyan(active.displayName || active.name)}`);
          console.log(`  Model ID: ${active.modelId}`);
          console.log(`  Provider: ${active.provider}`);
          console.log(
            `  Cost: $${active.costPer1KInput}/1K input, $${active.costPer1KOutput}/1K output`
          );
        } else {
          // Show Claude's default environment
          const defaultModel =
            process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ||
            process.env.ANTHROPIC_MODEL ||
            'claude-3-5-sonnet-20241022';
          const baseUrl = process.env.ANTHROPIC_BASE_URL || 'default Anthropic API';

          console.log(`${chalk.bold('Claude Default Configuration:')}`);
          console.log(`  Model: ${chalk.cyan(defaultModel)}`);
          console.log(`  API Base: ${baseUrl}`);
          console.log(
            `  Auth Token: ${process.env.ANTHROPIC_AUTH_TOKEN ? '✓ Configured' : '✗ Not configured'}`
          );
        }
        console.log(`\n${chalk.gray('Use "happy --seeall" to see all available models')}`);
        return;
      }

      await handleModelSwitchCli(args);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  }

  // Handle top-level token-stats commands
  if (hasTokenCommand) {
    try {
      await handleTokenStatsCli(args);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  }

  // Handle dashboard command
  if (hasDashboardCommand) {
    try {
      await handleDashboardCli(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  }

  // Check if first argument is a subcommand
  const subcommand = args[0];

  if (subcommand === 'doctor') {
    // Check for clean subcommand
    if (args[1] === 'clean') {
      const result = await killRunawayHappyProcesses();
      console.log(`Cleaned up ${result.killed} runaway processes`);
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors);
      }
      process.exit(0);
    }
    await runDoctorCommand();
    return;
  } else if (subcommand === 'auth') {
    // Handle auth subcommands
    try {
      await handleAuthCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'connect') {
    // Handle connect subcommands
    try {
      await handleConnectCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'codex') {
    // Handle codex command
    try {
      const { runCodex } = await import('@/codex/runCodex');

      // Parse startedBy argument
      let startedBy: 'daemon' | 'terminal' | undefined = undefined;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--started-by') {
          startedBy = args[++i] as 'daemon' | 'terminal';
        }
      }

      const { credentials } = await authAndSetupMachineIfNeeded();
      await runCodex({ credentials, startedBy });
      // Do not force exit here; allow instrumentation to show lingering handles
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'logout') {
    // Keep for backward compatibility - redirect to auth logout
    console.log(
      chalk.yellow('Note: "happy logout" is deprecated. Use "happy auth logout" instead.\n')
    );
    try {
      await handleAuthCommand(['logout']);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'notify') {
    // Handle notification command
    try {
      await handleNotifyCommand(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'token-stats') {
    // Handle token-stats command
    try {
      await handleTokenStatsCli(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'model-switch') {
    // Handle model-switch command
    try {
      await handleModelSwitchCli(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'dashboard') {
    // Handle dashboard command
    try {
      await handleDashboardCli(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'session-monitor') {
    // Handle session-monitor command
    try {
      await handleSessionMonitorCli(args.slice(1));
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
    return;
  } else if (subcommand === 'daemon') {
    // Show daemon management help
    const daemonSubcommand = args[1];

    if (daemonSubcommand === 'list') {
      try {
        const sessions = await listDaemonSessions();

        if (sessions.length === 0) {
          console.log(
            'No active sessions this daemon is aware of (they might have been started by a previous version of the daemon)'
          );
        } else {
          console.log('Active sessions:');
          console.log(JSON.stringify(sessions, null, 2));
        }
      } catch (error) {
        console.log('No daemon running');
      }
      return;
    } else if (daemonSubcommand === 'stop-session') {
      const sessionId = args[2];
      if (!sessionId) {
        console.error('Session ID required');
        process.exit(1);
      }

      try {
        const success = await stopDaemonSession(sessionId);
        console.log(success ? 'Session stopped' : 'Failed to stop session');
      } catch (error) {
        console.log('No daemon running');
      }
      return;
    } else if (daemonSubcommand === 'start') {
      // Spawn detached daemon process
      const child = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      child.unref();

      // Wait for daemon to write state file (up to 5 seconds)
      let started = false;
      for (let i = 0; i < 50; i++) {
        if (await checkIfDaemonRunningAndCleanupStaleState()) {
          started = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      if (started) {
        console.log('Daemon started successfully');
      } else {
        console.error('Failed to start daemon');
        process.exit(1);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'start-sync') {
      await startDaemon();
      process.exit(0);
    } else if (daemonSubcommand === 'stop') {
      await stopDaemon();
      process.exit(0);
    } else if (daemonSubcommand === 'status') {
      // Show daemon-specific doctor output
      await runDoctorCommand('daemon');
      process.exit(0);
    } else if (daemonSubcommand === 'logs') {
      // Simply print the path to the latest daemon log file
      const latest = await getLatestDaemonLog();
      if (!latest) {
        console.log('No daemon logs found');
      } else {
        console.log(latest.path);
      }
      process.exit(0);
    } else if (daemonSubcommand === 'install') {
      try {
        await install();
      } catch (error) {
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(1);
      }
    } else if (daemonSubcommand === 'uninstall') {
      try {
        await uninstall();
      } catch (error) {
        console.error(
          chalk.red('Error:'),
          error instanceof Error ? error.message : 'Unknown error'
        );
        process.exit(1);
      }
    } else {
      console.log(`
${chalk.bold('happy daemon')} - Daemon management

${chalk.bold('Usage:')}
  happy daemon start              Start the daemon (detached)
  happy daemon stop               Stop the daemon (sessions stay alive)
  happy daemon status             Show daemon status
  happy daemon list               List active sessions

  If you want to kill all happy related processes run
  ${chalk.cyan('happy doctor clean')}

${chalk.bold('Note:')} The daemon runs in the background and manages Claude sessions.

${chalk.bold('To clean up runaway processes:')} Use ${chalk.cyan('happy doctor clean')}
`);
    }
    return;
  } else {
    // If the first argument is claude, remove it
    if (args.length > 0 && args[0] === 'claude') {
      args.shift();
    }

    // Parse command line arguments for main command
    const options: StartOptions = {};
    let showHelp = false;
    let showVersion = false;
    const unknownArgs: string[] = []; // Collect unknown args to pass through to claude

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];

      if (arg === '-h' || arg === '--help') {
        showHelp = true;
        // Also pass through to claude
        unknownArgs.push(arg);
      } else if (arg === '-v' || arg === '--version') {
        showVersion = true;
        // Also pass through to claude (will show after our version)
        unknownArgs.push(arg);
      } else if (arg === '--happy-starting-mode') {
        options.startingMode = z.enum(['local', 'remote']).parse(args[++i]);
      } else if (arg === '--to') {
        // Pass through to claude
      } else if (arg === '--started-by') {
        options.startedBy = args[++i] as 'daemon' | 'terminal';
      } else {
        // Pass unknown arguments through to claude
        unknownArgs.push(arg);
        // Check if this arg expects a value (simplified check for common patterns)
        if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
          unknownArgs.push(args[++i]);
        }
      }
    }

    // Add unknown args to claudeArgs
    if (unknownArgs.length > 0) {
      options.claudeArgs = [...(options.claudeArgs || []), ...unknownArgs];
    }

    // Show help
    if (showHelp) {
      console.log(`
${chalk.bold('happy')} - Claude Code On the Go

${chalk.bold('Ultra-Simple Commands (Recommended):')}
  ${chalk.cyan('ccglm')}               Start GLM model session (yolo mode)
  ${chalk.cyan('ccmm')}                Start MiniMax model session (yolo mode)
  ${chalk.cyan('cckimi')}              Start Kimi model session (yolo mode)
  ${chalk.cyan('ccglm --no')}          Start GLM model session (normal mode)
  ${chalk.cyan('ccmm --no')}           Start MiniMax model session (normal mode)
  ${chalk.cyan('cckimi --no')}         Start Kimi model session (normal mode)

${chalk.bold('Full-Featured Commands:')}
  happy [options]         Start Claude with mobile control
  happy --yolo --to <model>    Switch model and start session (yolo mode)
  happy --to <model>      Switch to a different model
  happy --seeall          List all available models
  happy --stats           View token usage statistics
  happy --dashboard       Real-time token dashboard
  happy auth              Manage authentication
  happy codex             Start Codex mode
  happy connect           Connect AI vendor API keys
  happy notify            Send push notification
  happy daemon            Manage background service
  happy doctor            System diagnostics & troubleshooting

${chalk.bold('Model Management:')}
  --to <name>             Switch to model (e.g., claude-3-5-haiku)
  --seeall, -a            List all models
  --toadd <name>          Add a new model
  --del <name>            Remove a model
  --upd <name>            Update a model
  --auto <pattern>        Auto-switch (expensive|cheap|balanced)
  --exp <file>            Export model config
  --imp <file>            Import model config

${chalk.bold('Token Statistics:')}
  --stats                 Show daily token usage
  -f, --format <fmt>      Output format (table|json|compact)
  --since <date>          Filter from date (YYYYMMDD)
  --until <date>          Filter until date (YYYYMMDD)
  daily|weekly|monthly    Group by time period
  --watch                 Real-time monitoring

${chalk.bold('Examples:')}
  ${chalk.cyan('ccglm')}                   Start GLM session (yolo mode)
  ${chalk.cyan('ccmm --no')}               Start MiniMax session (normal mode)
  ${chalk.cyan('cckimi')}                  Start Kimi session (yolo mode)
  happy --yolo --to GLM          Switch to GLM and start session (yolo mode)
  happy --to claude-3-5-haiku    Switch to Haiku model
  happy --seeall                 List all models
  happy --stats -f compact       Show token stats (compact)
  happy --dashboard              Start real-time dashboard
  happy auth login --force       Authenticate
  happy doctor                   Run diagnostics

${chalk.bold('Happy supports ALL Claude options!')}
  Use any claude flag with happy as you would with claude. Our favorite:

  happy --resume

${chalk.gray('─'.repeat(60))}
${chalk.bold.cyan('Claude Code Options (from `claude --help`):')}
`);

      // Run claude --help and display its output
      // Use execFileSync with the current Node executable for cross-platform compatibility
      try {
        const claudeHelp = execFileSync(process.execPath, [claudeCliPath, '--help'], {
          encoding: 'utf8',
        });
        console.log(claudeHelp);
      } catch (e) {
        console.log(chalk.yellow('Could not retrieve claude help. Make sure claude is installed.'));
      }

      process.exit(0);
    }

    // Show version
    if (showVersion) {
      console.log(`happy version: ${packageJson.version}`);
      // Don't exit - continue to pass --version to Claude Code
    }

    // Normal flow - auth and machine setup
    const { credentials } = await authAndSetupMachineIfNeeded();

    // Get active model from model manager and set it in options
    const { getModelManager } = await import('./claude/sdk/modelManager');
    const modelManager = getModelManager();
    const activeProfile = modelManager.getActiveProfile();
    if (activeProfile) {
      // Set the model in options so runClaude uses it
      options.model = activeProfile.modelId;
      logger.debug(
        `Using active model from model manager: ${activeProfile.name} (${activeProfile.modelId})`
      );
    } else {
      logger.debug('No active model set, will use Claude default');
    }

    // Always auto-start daemon for simplicity
    logger.debug('Ensuring Happy background service is running & matches our version...');

    if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
      logger.debug('Starting Happy background service...');

      // Use the built binary to spawn daemon
      const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env,
      });
      daemonProcess.unref();

      // Give daemon a moment to write PID & port file
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    // Start the CLI
    try {
      await runClaude(credentials, options);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    }
  }
})();

/**
 * Handle notification command
 */
async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = '';
  let title = '';
  let showHelp = false;

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i];
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i];
    } else if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`));
      process.exit(1);
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happy notify')} - Send notification

${chalk.bold('Usage:')}
  happy notify -p <message> [-t <title>]    Send notification with custom message and optional title
  happy notify -h, --help                   Show this help

${chalk.bold('Options:')}
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Happy")

${chalk.bold('Examples:')}
  happy notify -p "Deployment complete!"
  happy notify -p "System update complete" -t "Server Status"
  happy notify -t "Alert" -p "Database connection restored"
`);
    return;
  }

  if (!message) {
    console.error(
      chalk.red(
        'Error: Message is required. Use -p "your message" to specify the notification text.'
      )
    );
    console.log(chalk.gray('Run "happy notify --help" for usage information.'));
    process.exit(1);
  }

  // Load credentials
  let credentials = await readCredentials();
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "happy auth login" first.'));
    process.exit(1);
  }

  console.log(chalk.blue('📱 Sending push notification...'));

  try {
    // Create API client and send push notification
    const api = await ApiClient.create(credentials);

    // Use custom title or default to "Happy"
    const notificationTitle = title || 'Happy';

    // Send the push notification
    api.push().sendToAllDevices(notificationTitle, message, {
      source: 'cli',
      timestamp: Date.now(),
    });

    console.log(chalk.green('✓ Push notification sent successfully!'));
    console.log(chalk.gray(`  Title: ${notificationTitle}`));
    console.log(chalk.gray(`  Message: ${message}`));
    console.log(chalk.gray('  Check your mobile device for the notification.'));

    // Give a moment for the async operation to start
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(chalk.red('✗ Failed to send push notification'));
    throw error;
  }
}

/**
 * Handle ultra-simple commands (ccglm, ccmm, cckimi)
 */
async function handleUltraSimpleCommand(commandName: string, args: string[]): Promise<void> {
  // Determine model name
  let modelName: string;
  let modelDisplay: string;

  if (commandName === 'ccglm') {
    modelName = 'GLM';
    modelDisplay = 'GLM';
  } else if (commandName === 'ccmm') {
    modelName = 'MM';
    modelDisplay = 'MM (MiniMax)';
  } else {
    modelName = 'KIMI';
    modelDisplay = 'KIMI (Kimi)';
  }

  // Check for --no flag (disable yolo mode)
  const hasNoFlag = args.includes('--no');

  // Switch model
  const { getModelManager } = await import('./claude/sdk/modelManager');
  const modelManager = getModelManager();
  const success = modelManager.switchModel(modelName);

  if (!success) {
    console.error(chalk.red(`Error: Failed to switch to model "${modelDisplay}"`));
    process.exit(1);
  }

  // Prepare to start Claude
  const { credentials } = await authAndSetupMachineIfNeeded();

  // Set up options
  const options: StartOptions = {};

  // If --no flag is present, don't add --dangerously-skip-permissions
  if (!hasNoFlag) {
    options.claudeArgs = ['--dangerously-skip-permissions'];
  }

  // Get active model
  const activeProfile = modelManager.getActiveProfile();
  if (activeProfile) {
    options.model = activeProfile.modelId;
  }

  // Ensure daemon is running
  logger.debug('Ensuring Happy background service is running & matches our version...');

  if (!(await isDaemonRunningCurrentlyInstalledHappyVersion())) {
    logger.debug('Starting Happy background service...');

    const daemonProcess = spawnHappyCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    daemonProcess.unref();

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // Start the CLI
  const modeText = hasNoFlag ? 'normal mode' : 'yolo mode';
  console.log(
    chalk.green(`✓ Switched to model "${modelDisplay}" and starting session (${modeText})...`)
  );

  try {
    await runClaude(credentials, options);
  } catch (error) {
    console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error');
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}
