/**
 * P0 Unified Command Framework — output rendering and lifecycle runner
 *
 * Core exports:
 *   renderResult()          — print CommandResult to stdout/stderr + handle --json
 *   renderSubcommandHelp()  — print command group help
 *   runSubcommand()         — full lifecycle: parse → dispatch → render → exit
 *   confirm()               — readline yes/no prompt (skippable via --yes)
 *   createApiClient()       — auth-guarded API client factory
 */

import chalk from 'chalk'
import { readCredentials } from '@/persistence'
import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { ApiClient } from '@/api/api'
import type { CommandResult, CommandContext, ParsedFlags, SubcommandEntry } from './types'
import { parseFlags } from './parseFlags'

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

/**
 * Render a CommandResult to stdout/stderr.
 *
 * --json mode (gh CLI convention):
 *   ok=true:   print result.data if present, else { ok: true, message }
 *   ok=false:  print { ok: false, error: { code, message, hint? } }
 *
 * Human mode:
 *   ok=true:   chalk.green ✓ + message (unless --quiet)
 *              chalk.gray detail line (only with --verbose)
 *   ok=false:  chalk.red ✗ + message to stderr
 *              hint line if present
 */
export function renderResult(result: CommandResult<unknown>, flags: ParsedFlags): void {
  if (flags.json) {
    if (result.ok) {
      const output =
        result.data !== undefined
          ? result.data
          : { ok: true, message: result.message }
      process.stdout.write(JSON.stringify(output, null, 2) + '\n')
    } else {
      const errorPayload = result.error ?? {
        code: 'ERROR',
        message: result.message,
      }
      process.stdout.write(
        JSON.stringify({ ok: false, error: errorPayload }, null, 2) + '\n',
      )
    }
    return
  }

  if (result.ok) {
    if (!flags.quiet && result.message) {
      console.log(chalk.green('✓'), result.message)
    }
    if (flags.verbose && result.detail) {
      console.log(chalk.gray(result.detail))
    }
  } else {
    console.error(chalk.red('✗'), result.message)
    if (result.error?.hint) {
      console.error(chalk.gray('  hint:'), result.error.hint)
    }
  }
}

/**
 * Print a help screen for a command group.
 *
 * @param groupLabel — display name, e.g. 'Aha Teams'
 * @param groupCmd   — CLI name, e.g. 'teams'
 * @param registry   — map of subcommand names to entries
 */
export function renderSubcommandHelp(
  groupLabel: string,
  groupCmd: string,
  registry: Record<string, SubcommandEntry>,
): void {
  console.log(`\n${chalk.bold(`aha ${groupCmd}`)} — ${groupLabel}\n`)
  console.log(chalk.bold('Commands:'))
  for (const [name, entry] of Object.entries(registry)) {
    const usageSuffix = entry.usage ? chalk.gray(`  ${entry.usage}`) : ''
    console.log(`  ${chalk.cyan(name.padEnd(16))}  ${entry.description}${usageSuffix}`)
  }
  console.log()
  console.log(chalk.gray('Global flags: --json  --verbose/-v  --quiet/-q  --yes/-y  --help/-h'))
  console.log()
}

// ---------------------------------------------------------------------------
// Shared utilities
// ---------------------------------------------------------------------------

/**
 * Readline yes/no confirmation prompt.
 * Always returns true immediately when --yes was passed (agent-friendly).
 *
 * @param prompt — question text, e.g. 'Archive this team? (y/N) '
 * @param flags  — pass flags to honour --yes
 */
export async function confirm(prompt: string, flags?: ParsedFlags): Promise<boolean> {
  if (flags?.yes) return true
  const { default: readline } = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await rl.question(chalk.cyan(prompt))
    return answer.trim().toLowerCase() === 'y'
  } finally {
    rl.close()
  }
}

/**
 * Auth-guarded API client factory.
 * Prints a friendly error and exits(1) if credentials are missing.
 */
export async function createApiClient(): Promise<ApiClient> {
  const credentials = await readCredentials()
  if (!credentials) {
    console.error(
      chalk.yellow('Not authenticated. Please run:'),
      chalk.green('aha auth login'),
    )
    process.exit(1)
  }
  const { credentials: authCredentials } = await authAndSetupMachineIfNeeded()
  return ApiClient.create(authCredentials)
}

// ---------------------------------------------------------------------------
// Lifecycle runner
// ---------------------------------------------------------------------------

/**
 * Unified subcommand lifecycle runner.
 *
 * Sequence:
 *   1. Extract subcommand name from args[0]
 *   2. Parse remaining args into ParsedFlags
 *   3. Show help if subcommand is missing, 'help', or --help
 *   4. Look up entry in registry; show help + exit(1) if unknown
 *   5. Build CommandContext with lazy api() factory
 *   6. Invoke handler
 *   7. Render result via renderResult()
 *   8. Exit:  0 on ok=true, 1 on ok=false, 2 on unhandled throw
 *
 * @param groupLabel — display label, e.g. 'Aha Teams'
 * @param groupCmd   — CLI prefix, e.g. 'teams'
 * @param registry   — subcommand → SubcommandEntry map
 * @param args       — raw args for the command group (subcommand is args[0])
 */
export async function runSubcommand(
  groupLabel: string,
  groupCmd: string,
  registry: Record<string, SubcommandEntry>,
  args: string[],
): Promise<void> {
  const sub = args[0]
  const flags = parseFlags(args.slice(1))

  if (!sub || sub === 'help' || flags.help) {
    renderSubcommandHelp(groupLabel, groupCmd, registry)
    process.exit(0)
  }

  const entry = registry[sub]
  if (!entry) {
    console.error(chalk.red(`Unknown subcommand: ${sub}`))
    renderSubcommandHelp(groupLabel, groupCmd, registry)
    process.exit(1)
  }

  const ctx: CommandContext = {
    flags,
    args: args.slice(1),
    api: createApiClient,
  }

  let result: CommandResult<unknown>
  try {
    result = await entry.handler(ctx)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    const failResult: CommandResult<unknown> = {
      ok: false,
      message,
      error: { code: 'SYSTEM_ERROR', message },
    }
    renderResult(failResult, flags)
    process.exit(2)
  }

  renderResult(result, flags)
  process.exit(result.ok ? 0 : 1)
}
