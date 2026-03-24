/**
 * P0 Unified Command Framework — shared type definitions
 *
 * Every command handler in aha-cli follows this contract:
 *   - Receives a CommandContext (flags + lazy API client)
 *   - Returns a CommandResult<T> (structured success or failure)
 *   - Is registered in a SubcommandEntry map for the group
 *
 * The runSubcommand() lifecycle runner in output.ts wires these together.
 */

import type { ApiClient } from '@/api/api'

/**
 * Parsed representation of all CLI flags.
 *
 * Global boolean flags are extracted into top-level fields.
 * All other --key value pairs live in `options`.
 * All other standalone flags live in `flags`.
 * Non-flag tokens live in `positional`.
 */
export interface ParsedFlags {
  /** --json: machine-readable JSON output (gh CLI convention) */
  json: boolean
  /** --verbose / -v: extra detail */
  verbose: boolean
  /** --quiet / -q: suppress non-essential output */
  quiet: boolean
  /** --yes / -y: skip interactive confirmations */
  yes: boolean
  /** --help / -h */
  help: boolean
  /** positional arguments after the subcommand has been consumed */
  positional: string[]
  /** --key value option pairs */
  options: Map<string, string>
  /** standalone boolean flags (without values) by long name, e.g. 'force' */
  flags: Set<string>
}

/**
 * Execution context passed to every CommandHandler.
 */
export interface CommandContext {
  /** Parsed flags for this invocation */
  flags: ParsedFlags
  /** Raw args slice after the subcommand name (for edge cases) */
  args: string[]
  /**
   * Lazy API client factory.
   * Calling api() exits(1) if not authenticated.
   * Avoid calling it in commands that don't need the API (e.g. `aha teams use`).
   */
  api: () => Promise<ApiClient>
}

/**
 * Structured result from every CommandHandler.
 *
 * For --json output:
 *   - ok=true:  prints result.data if present, else { ok: true, message }
 *   - ok=false: prints { ok: false, error: { code, message, hint? } }
 *
 * Exit codes assigned by runSubcommand:
 *   0 — ok=true
 *   1 — ok=false (user error, not found, precondition failed)
 *   2 — unhandled exception (system error)
 */
export interface CommandResult<T = void> {
  ok: boolean
  /** Human-readable status line */
  message: string
  /**
   * Data payload for --json output.
   *
   * Convention (mirrors gh CLI):
   *   - List commands: return T[] (flat array, no wrapper object)
   *   - Item/action commands: return the item or action result directly
   */
  data?: T
  /** Extra detail shown with --verbose in human mode */
  detail?: string
  /** Structured error for --json output */
  error?: {
    code: string
    message: string
    hint?: string
  }
}

/**
 * A handler function for a single subcommand.
 * Must be pure of process.exit — that is runSubcommand's responsibility.
 */
export type CommandHandler<T = unknown> = (ctx: CommandContext) => Promise<CommandResult<T>>

/**
 * One entry in a subcommand registry.
 */
export interface SubcommandEntry {
  handler: CommandHandler
  description: string
  /** Short usage hint shown in help, e.g. '<id> [--verbose]' */
  usage?: string
}
