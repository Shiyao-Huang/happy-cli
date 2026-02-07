/**
 * Global configuration for aha CLI
 *
 * Centralizes all configuration including environment variables and paths
 * Environment files should be loaded using Node's --env-file flag
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json'
import { z } from 'zod'
import chalk from 'chalk'

/**
 * Zod schema for environment variable validation
 * Provides runtime type checking and friendly error messages
 */
const envSchema = z.object({
  // Server URLs (optional, with defaults)
  AHA_SERVER_URL: z.string().url().optional().describe('Server API endpoint URL'),
  AHA_WEBAPP_URL: z.string().url().optional().describe('Web application URL'),

  // Directory configuration
  AHA_HOME_DIR: z.string().optional().describe('Aha home directory path'),

  // Feature flags
  AHA_EXPERIMENTAL: z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional().describe('Enable experimental features'),
  AHA_DISABLE_CAFFEINATE: z.enum(['true', 'false', '1', '0', 'yes', 'no']).optional().describe('Disable caffeinate command'),

  // Debug flags
  DEBUG: z.enum(['true', 'false', '1', '0']).optional().describe('Enable debug logging'),
  DANGEROUSLY_LOG_TO_SERVER_FOR_AI_AUTO_DEBUGGING: z.enum(['true', 'false', '1', '0']).optional().describe('Enable server-side debug logging'),

  // Permission mode
  AHA_PERMISSION_MODE: z.enum(['default', 'acceptEdits', 'bypassPermissions']).optional().describe('Permission mode for Claude Code'),

  // Team collaboration
  AHA_ROOM_ID: z.string().optional().describe('Team room ID for collaboration'),
  AHA_AGENT_ROLE: z.string().optional().describe('Agent role for team collaboration'),
  AHA_PROJECT_ROOT: z.string().optional().describe('Project root directory'),
}).passthrough() // Allow additional env vars without error

/**
 * Validate environment variables and provide friendly error messages
 */
function validateConfiguration(): void {
  try {
    // Validate known environment variables
    envSchema.parse(process.env)

    // Validate URL formats if provided
    if (process.env.AHA_SERVER_URL) {
      try {
        new URL(process.env.AHA_SERVER_URL)
      } catch {
        console.error(chalk.red('Error: AHA_SERVER_URL is not a valid URL'))
        console.error(chalk.gray(`  Provided: ${process.env.AHA_SERVER_URL}`))
        console.error(chalk.gray('  Expected format: https://api.example.com'))
        process.exit(1)
      }
    }

    if (process.env.AHA_WEBAPP_URL) {
      try {
        new URL(process.env.AHA_WEBAPP_URL)
      } catch {
        console.error(chalk.red('Error: AHA_WEBAPP_URL is not a valid URL'))
        console.error(chalk.gray(`  Provided: ${process.env.AHA_WEBAPP_URL}`))
        console.error(chalk.gray('  Expected format: https://app.example.com'))
        process.exit(1)
      }
    }

    // Validate permission mode
    if (process.env.AHA_PERMISSION_MODE && !['default', 'acceptEdits', 'bypassPermissions'].includes(process.env.AHA_PERMISSION_MODE)) {
      console.error(chalk.red('Error: Invalid AHA_PERMISSION_MODE'))
      console.error(chalk.gray(`  Provided: ${process.env.AHA_PERMISSION_MODE}`))
      console.error(chalk.gray('  Valid options: default, acceptEdits, bypassPermissions'))
      process.exit(1)
    }

  } catch (error) {
    if (error instanceof z.ZodError) {
      console.error(chalk.red('❌ Configuration Error:'))
      console.error(chalk.gray('─'.repeat(60)))

      error.errors.forEach((err) => {
        const path = err.path.join('.')
        const message = err.message
        const description = (err as any).description || ''

        console.error(chalk.yellow(`\n  • ${chalk.bold(path)}`))
        if (description) {
          console.error(chalk.gray(`    ${description}`))
        }
        console.error(chalk.gray(`    Error: ${message}`))
      })

      console.error(chalk.gray('\n─'.repeat(60)))
      console.error(chalk.cyan('\n💡 To fix this issue:'))
      console.error(chalk.gray('  1. Check your .env file or environment variables'))
      console.error(chalk.gray('  2. Run "aha doctor" for system diagnostics'))
      console.error(chalk.gray('  3. See documentation at https://github.com/slopus/aha'))

      process.exit(1)
    } else {
      console.error(chalk.red('Unexpected configuration error:'), error)
      process.exit(1)
    }
  }
}

class Configuration {
  public readonly serverUrl: string
  public readonly webappUrl: string
  public readonly isDaemonProcess: boolean

  // Directories and paths (from persistence)
  public readonly ahaHomeDir: string
  public readonly logsDir: string
  public readonly settingsFile: string
  public readonly privateKeyFile: string
  public readonly daemonStateFile: string
  public readonly daemonLockFile: string
  public readonly currentCliVersion: string

  public readonly isExperimentalEnabled: boolean
  public readonly disableCaffeinate: boolean

  constructor() {
    // Validate configuration before initializing
    validateConfiguration()

    // Server configuration - priority: parameter > environment > default
    this.serverUrl = process.env.AHA_SERVER_URL || 'https://top1vibe.com'
    this.webappUrl = process.env.AHA_WEBAPP_URL || 'https://app.aha.engineering'

    // Check if we're running as daemon based on process args
    const args = process.argv.slice(2)
    this.isDaemonProcess = args.length >= 2 && args[0] === 'daemon' && (args[1] === 'start-sync')

    // Directory configuration - Priority: AHA_HOME_DIR env > default home dir
    if (process.env.AHA_HOME_DIR) {
      // Expand ~ to home directory if present
      const expandedPath = process.env.AHA_HOME_DIR.replace(/^~/, homedir())
      this.ahaHomeDir = expandedPath
    } else {
      this.ahaHomeDir = join(homedir(), '.aha')
    }

    this.logsDir = join(this.ahaHomeDir, 'logs')
    this.settingsFile = join(this.ahaHomeDir, 'settings.json')
    this.privateKeyFile = join(this.ahaHomeDir, 'access.key')
    this.daemonStateFile = join(this.ahaHomeDir, 'daemon.state.json')
    this.daemonLockFile = join(this.ahaHomeDir, 'daemon.state.json.lock')

    this.isExperimentalEnabled = ['true', '1', 'yes'].includes(process.env.AHA_EXPERIMENTAL?.toLowerCase() || '');
    this.disableCaffeinate = ['true', '1', 'yes'].includes(process.env.AHA_DISABLE_CAFFEINATE?.toLowerCase() || '');

    this.currentCliVersion = packageJson.version

    if (!existsSync(this.ahaHomeDir)) {
      mkdirSync(this.ahaHomeDir, { recursive: true })
    }
    // Ensure directories exist
    if (!existsSync(this.logsDir)) {
      mkdirSync(this.logsDir, { recursive: true })
    }
  }
}

export const configuration: Configuration = new Configuration()
