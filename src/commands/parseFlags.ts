/**
 * P0 Unified Command Framework — consolidated argument parsing
 *
 * Replaces the 5x-duplicated getOption / hasFlag / getPositionalArgs helpers
 * that existed independently in agents.ts, teams.ts, sessions.ts, tasks.ts, roles.ts.
 *
 * Usage:
 *   import { parseFlags, getOption, getEnumOption } from './parseFlags'
 *
 *   const flags = parseFlags(args.slice(1)) // args[0] is subcommand name
 *   const teamId = getOption(flags, 'team')
 *   const status = getEnumOption(flags, 'status', TASK_STATUSES)
 */

import type { ParsedFlags } from './types'

/**
 * Flags that are always boolean (never consume the next argument as a value).
 * Includes both long and short forms.
 */
const GLOBAL_BOOLEAN_FLAGS = new Set([
  '--json',
  '--verbose', '-v',
  '--quiet', '-q',
  '--yes', '-y',
  '--help', '-h',
  '--force', '-f',
  '--active',
])

/**
 * Parse raw CLI args into a structured ParsedFlags.
 *
 * Rules applied in order:
 *  1. Known global boolean flags never consume next arg
 *  2. Unknown --long-name: if next token is a non-flag string, treat as value pair
 *  3. Unknown -x shorthand: same rule
 *  4. Everything else is a positional
 *
 * The subcommand name (args[0]) should be consumed by the caller before
 * calling parseFlags. Typically: parseFlags(args.slice(1))
 */
export function parseFlags(args: string[]): ParsedFlags {
  const options = new Map<string, string>()
  const flags = new Set<string>()
  const positional: string[] = []

  let i = 0
  while (i < args.length) {
    const arg = args[i]

    if (arg.startsWith('--')) {
      const name = arg.slice(2)
      if (GLOBAL_BOOLEAN_FLAGS.has(arg)) {
        flags.add(name)
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          options.set(name, next)
          i += 1
        } else {
          flags.add(name)
        }
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const name = arg.slice(1)
      if (GLOBAL_BOOLEAN_FLAGS.has(arg)) {
        flags.add(name)
      } else {
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith('-')) {
          options.set(name, next)
          i += 1
        } else {
          flags.add(name)
        }
      }
    } else {
      positional.push(arg)
    }

    i += 1
  }

  return {
    json: flags.has('json'),
    verbose: flags.has('verbose') || flags.has('v'),
    quiet: flags.has('quiet') || flags.has('q'),
    yes: flags.has('yes') || flags.has('y'),
    help: flags.has('help') || flags.has('h'),
    positional,
    options,
    flags,
  }
}

// ---------------------------------------------------------------------------
// Typed option accessors
// ---------------------------------------------------------------------------

/** Get a string option value by long name, e.g. getOption(flags, 'team') → 'abc123' */
export function getOption(flags: ParsedFlags, name: string): string | undefined {
  return flags.options.get(name)
}

/** Get a numeric option value; throws on non-numeric input */
export function getNumberOption(flags: ParsedFlags, name: string): number | undefined {
  const raw = flags.options.get(name)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (Number.isNaN(n)) {
    throw new Error(`--${name} must be a number, got: ${raw}`)
  }
  return n
}

/**
 * Get an enum-constrained option value.
 * Throws with a clear message if the value is not in the allowed set.
 *
 * @example
 *   const status = getEnumOption(flags, 'status', TASK_STATUSES)
 */
export function getEnumOption<const T extends readonly string[]>(
  flags: ParsedFlags,
  name: string,
  allowed: T,
): T[number] | undefined {
  const value = flags.options.get(name)
  if (value === undefined) return undefined
  if ((allowed as readonly string[]).includes(value)) return value as T[number]
  throw new Error(`--${name} must be one of: ${allowed.join(', ')}`)
}

/**
 * Get a comma-separated list option.
 * Returns undefined if the flag was not provided.
 *
 * @example
 *   const ids = parseCsvOption(flags, 'ids') // --ids a,b,c → ['a', 'b', 'c']
 */
export function parseCsvOption(flags: ParsedFlags, name: string): string[] | undefined {
  const raw = flags.options.get(name)
  if (!raw) return undefined
  const values = raw
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
  return values.length > 0 ? values : undefined
}
