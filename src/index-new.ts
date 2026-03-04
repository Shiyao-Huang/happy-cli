#!/usr/bin/env node

/**
 * CLI entry point for aha command
 *
 * Built with commander.js for discoverable CLI with auto-help and shell completion
 */

import { Command } from 'commander'
import chalk from 'chalk'
import packageJson from '../../package.json'
import { logger } from './ui/logger'
import { handleAuthCommand } from './commands/auth'
import { handleConnectCommand } from './commands/connect'
import { handleInteractiveCommand } from './commands/interactive'
import { handleNotifyCommand } from './lib/handleNotifyCommand'
import { runDoctorCommand } from './ui/doctor'
import { runClaude, StartOptions } from './claude/runClaude'
import { authAndSetupMachineIfNeeded } from './ui/auth'
import { startDaemon } from './daemon/run'
import {
  checkIfDaemonRunningAndCleanupStaleState,
  isDaemonRunningCurrentlyInstalledAhaVersion,
  stopDaemon,
  listDaemonSessions,
  stopDaemonSession
} from './daemon/controlClient'
import { getLatestDaemonLog } from './ui/logger'
import { killRunawayAhaProcesses } from './daemon/doctor'
import { install } from './daemon/install'
import { uninstall } from './daemon/uninstall'
import { spawnAhaCLI } from './utils/spawnAhaCLI'
import { z } from 'zod'
import { execFileSync } from 'node:child_process'
import { claudeCliPath } from './claude/claudeLocal'

const program = new Command()

/**
 * Ensure daemon is running and matches current CLI version
 */
async function ensureDaemonRunning(): Promise<void> {
  try {
    const running = await isDaemonRunningCurrentlyInstalledAhaVersion()
    if (!running) {
      const daemonProcess = spawnAhaCLI(['daemon', 'start-sync'], {
        detached: true,
        stdio: 'ignore',
        env: process.env
      })
      daemonProcess.unref()
      await new Promise(resolve => setTimeout(resolve, 200))

      if (process.env.AHA_VERBOSE) {
        console.error('[aha] daemon started in background')
      }
    }
  } catch (error) {
    if (process.env.AHA_VERBOSE) {
      console.error('[aha] failed to start daemon:', error)
    }
  }
}

/**
 * Error boundary wrapper for command handlers
 */
function withErrorBoundary<T extends (...args: unknown[]) => Promise<void>>(handler: T): T {
  return (async (...args: unknown[]) => {
    try {
      await handler(...args)
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : 'Unknown error')
      if (process.env.DEBUG) {
        console.error(error)
      }
      process.exit(1)
    }
  }) as T
}

// Program configuration
program
  .name('aha')
  .description('Claude Code wrapper with team collaboration')
  .version(packageJson.version)

// ============================================
// Main command (default Claude session)
// ============================================
program
  .argument('[message]', 'Message to send to Claude')
  .option('--yolo', 'Shortcut for --dangerously-skip-permissions', false)
  .option('--aha-starting-mode <mode>', 'Starting mode: local or remote')
  .option('--started-by <source>', 'Who started this: daemon or terminal')
  .option('--session-tag <tag>', 'Tag for session identification')
  .option('--debug', 'Enable debug logging')
  .allowUnknownOption(true)
  .action(withErrorBoundary(async (message, options) => {
    await ensureDaemonRunning()

    const { credentials } = await authAndSetupMachineIfNeeded()

    const startOptions: StartOptions = {
      permissionMode: options.yolo ? 'bypassPermissions' : undefined,
      startingMode: options.ahaStartingMode as 'local' | 'remote' | undefined,
      startedBy: options.startedBy as 'daemon' | 'terminal' | undefined,
      sessionTag: options.sessionTag
    }

    // Collect unknown args for Claude
    const unknownArgs = program.args.filter(arg => !arg.startsWith('-'))
    if (message) {
      startOptions.claudeArgs = unknownArgs
    }

    await runClaude(credentials, startOptions)
  }))

// ============================================
// auth command
// ============================================
program
  .command('auth')
  .description('Authentication management')
  .argument('[action]', 'login or logout')
  .option('--force', 'Force re-authentication')
  .option('--headless', 'Headless authentication (no browser)')
  .action(withErrorBoundary(async (action, options) => {
    await handleAuthCommand([action, ...Object.entries(options).map(([k, v]) => v ? `--${k}` : '').filter(Boolean)])
  }))

// ============================================
// connect command
// ============================================
program
  .command('connect')
  .description('AI vendor API key management')
  .argument('[action]', 'list or add')
  .action(withErrorBoundary(async (action) => {
    await handleConnectCommand([action])
  }))

// ============================================
// teams command
// ============================================
program
  .command('teams')
  .description('Team management & adaptive composition')
  .argument('[action]', 'list, archive, delete, rename, or compose')
  .argument('[params...]', 'Additional parameters')
  .option('--prd <path>', 'PRD file for composition')
  .action(withErrorBoundary(async (action, params, options) => {
    const { handleTeamsCommand } = await import('./commands/teams')
    await handleTeamsCommand([action, ...params, ...options.prd ? ['--prd', options.prd] : []])
  }))

// ============================================
// roles command
// ============================================
program
  .command('roles')
  .description('Role pool and public review')
  .argument('[action]', 'pool, review, or team-score')
  .action(withErrorBoundary(async (action) => {
    const { handleRolesCommand } = await import('./commands/roles')
    await handleRolesCommand([action])
  }))

// ============================================
// rating command
// ============================================
program
  .command('rating')
  .description('Rating workflow commands')
  .argument('[action]', 'team, role, leaderboard, submit, or auto')
  .action(withErrorBoundary(async (action) => {
    const { handleRatingCommand } = await import('./commands/rating')
    await handleRatingCommand([action])
  }))

// ============================================
// codex command
// ============================================
program
  .command('codex')
  .description('Start team collaboration mode')
  .option('--started-by <source>', 'Who started this: daemon or terminal')
  .action(withErrorBoundary(async (options) => {
    await ensureDaemonRunning()
    const { runCodex } = await import('./codex/runCodex')
    const { credentials } = await authAndSetupMachineIfNeeded()
    await runCodex({ credentials, startedBy: options.startedBy })
  }))

// ============================================
// ralph command
// ============================================
program
  .command('ralph')
  .description('Ralph autonomous loop')
  .argument('[action]', 'start, status, stop, or interactive')
  .action(withErrorBoundary(async (action) => {
    const { handleRalphCommand } = await import('./ralph/command.js')
    await handleRalphCommand([action])
  }))

// ============================================
// interactive command
// ============================================
program
  .command('interactive')
  .description('Start interactive shell mode')
  .action(withErrorBoundary(async () => {
    await handleInteractiveCommand([])
  }))

// ============================================
// notify command
// ============================================
program
  .command('notify')
  .description('Send push notification')
  .requiredOption('-p, --message <text>', 'Notification message')
  .option('-t, --title <text>', 'Notification title', 'Aha')
  .action(withErrorBoundary(async (options) => {
    await handleNotifyCommand(['-p', options.message, '-t', options.title])
  }))

// ============================================
// doctor command
// ============================================
program
  .command('doctor')
  .description('Run diagnostics or cleanup stray processes')
  .argument('[action]', 'clean or daemon')
  .action(withErrorBoundary(async (action) => {
    if (action === 'clean') {
      const result = await killRunawayAhaProcesses()
      console.log(`Cleaned up ${result.killed} runaway processes`)
      if (result.errors.length > 0) {
        console.log('Errors:', result.errors)
      }
    } else {
      await runDoctorCommand(action)
    }
  }))

// ============================================
// daemon command (with subcommands)
// ============================================
const daemonCmd = program
  .command('daemon')
  .description('Background service management')

daemonCmd
  .command('start')
  .description('Start the daemon (detached)')
  .action(withErrorBoundary(async () => {
    const child = spawnAhaCLI(['daemon', 'start-sync'], {
      detached: true,
      stdio: 'ignore',
      env: process.env
    })
    child.unref()

    let started = false
    for (let i = 0; i < 50; i++) {
      if (await checkIfDaemonRunningAndCleanupStaleState()) {
        started = true
        break
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    if (started) {
      console.log('Daemon started successfully')
    } else {
      console.error('Failed to start daemon')
      process.exit(1)
    }
  }))

daemonCmd
  .command('stop')
  .description('Stop the daemon (sessions stay alive)')
  .action(withErrorBoundary(async () => {
    await stopDaemon()
    console.log('Daemon stopped')
  }))

daemonCmd
  .command('status')
  .description('Show daemon status')
  .action(withErrorBoundary(async () => {
    await runDoctorCommand('daemon')
  }))

daemonCmd
  .command('list')
  .description('List active sessions')
  .action(withErrorBoundary(async () => {
    try {
      const sessions = await listDaemonSessions()
      if (sessions.length === 0) {
        console.log('No active sessions this daemon is aware of')
      } else {
        console.log('Active sessions:')
        console.log(JSON.stringify(sessions, null, 2))
      }
    } catch {
      console.log('No daemon running')
    }
  }))

daemonCmd
  .command('stop-session <sessionId>')
  .description('Stop a specific session')
  .action(withErrorBoundary(async (sessionId) => {
    try {
      const success = await stopDaemonSession(sessionId)
      console.log(success ? 'Session stopped' : 'Failed to stop session')
    } catch {
      console.log('No daemon running')
    }
  }))

daemonCmd
  .command('logs')
  .description('Show path to daemon logs')
  .action(withErrorBoundary(async () => {
    const latest = await getLatestDaemonLog()
    if (!latest) {
      console.log('No daemon logs found')
    } else {
      console.log(latest.path)
    }
  }))

daemonCmd
  .command('install')
  .description('Install daemon as system service')
  .action(withErrorBoundary(async () => {
    await install()
  }))

daemonCmd
  .command('uninstall')
  .description('Uninstall daemon system service')
  .action(withErrorBoundary(async () => {
    await uninstall()
  }))

// ============================================
// Parse and run
// ============================================
;(async () => {
  const args = process.argv.slice(2)

  // Auto-start daemon for all commands except daemon management
  if (!args.includes('--version') && !args[0]?.startsWith('daemon')) {
    logger.debug('Starting aha CLI with args: ', process.argv)
    await ensureDaemonRunning()
  }

  await program.parseAsync()
})()