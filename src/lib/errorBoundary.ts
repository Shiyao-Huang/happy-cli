/**
 * Error Boundary Module for aha-cli
 *
 * Provides structured error handling with recovery suggestions
 * Part of R0c: Error Boundaries implementation
 */

import chalk from 'chalk'

/**
 * Error codes with user-friendly messages and recovery suggestions
 */
export const ErrorCodes = {
  // Authentication errors
  AUTH_FAILED: {
    code: 'AUTH_FAILED',
    message: 'Authentication failed',
    suggestion: 'Run "aha auth login" to authenticate'
  },
  AUTH_EXPIRED: {
    code: 'AUTH_EXPIRED',
    message: 'Authentication token expired',
    suggestion: 'Run "aha auth login" to refresh your credentials'
  },
  AUTH_CANCELLED: {
    code: 'AUTH_CANCELLED',
    message: 'Authentication was cancelled',
    suggestion: 'Run "aha auth login" when ready'
  },

  // Daemon errors
  DAEMON_START_FAILED: {
    code: 'DAEMON_START_FAILED',
    message: 'Failed to start daemon',
    suggestion: 'Run "aha doctor" for diagnostics'
  },
  DAEMON_NOT_RUNNING: {
    code: 'DAEMON_NOT_RUNNING',
    message: 'Daemon is not running',
    suggestion: 'Run "aha daemon start" to start the daemon'
  },
  DAEMON_VERSION_MISMATCH: {
    code: 'DAEMON_VERSION_MISMATCH',
    message: 'Daemon version mismatch',
    suggestion: 'Restart the daemon with "aha daemon stop && aha daemon start"'
  },

  // Session errors
  SESSION_SPAWN_FAILED: {
    code: 'SESSION_SPAWN_FAILED',
    message: 'Failed to spawn session',
    suggestion: 'Check the directory path and try again'
  },
  SESSION_TIMEOUT: {
    code: 'SESSION_TIMEOUT',
    message: 'Session timed out',
    suggestion: 'Try again or check your network connection'
  },

  // Network errors
  NETWORK_ERROR: {
    code: 'NETWORK_ERROR',
    message: 'Network connection failed',
    suggestion: 'Check your internet connection and try again'
  },
  SERVER_ERROR: {
    code: 'SERVER_ERROR',
    message: 'Server error',
    suggestion: 'Try again in a few moments'
  },

  // Permission errors
  PERMISSION_DENIED: {
    code: 'PERMISSION_DENIED',
    message: 'Permission denied',
    suggestion: 'Check file permissions or run with appropriate privileges'
  },
  DIRECTORY_NOT_FOUND: {
    code: 'DIRECTORY_NOT_FOUND',
    message: 'Directory not found',
    suggestion: 'Verify the path exists or create it first'
  },

  // Generic errors
  UNKNOWN_ERROR: {
    code: 'UNKNOWN_ERROR',
    message: 'An unexpected error occurred',
    suggestion: 'Run "aha doctor" for diagnostics'
  }
} as const

export type ErrorCode = keyof typeof ErrorCodes

/**
 * Custom error class with structured error information
 */
export class AhaError extends Error {
  code: ErrorCode
  suggestion: string
  cause?: Error

  constructor(code: ErrorCode, cause?: Error) {
    super(ErrorCodes[code].message)
    this.code = code
    this.suggestion = ErrorCodes[code].suggestion
    this.cause = cause
    this.name = 'AhaError'
  }

  /**
   * Display formatted error message to user
   */
  display(): void {
    console.error('')
    console.error(chalk.red(`✗ ${this.message}`))
    console.error(chalk.gray(`  Code: ${this.code}`))
    console.error(chalk.cyan(`  Suggestion: ${this.suggestion}`))

    if (this.cause && process.env.DEBUG) {
      console.error(chalk.gray('  Cause:'), this.cause.message)
    }

    console.error('')
  }
}

/**
 * Error boundary wrapper for async functions
 * Catches errors and displays user-friendly messages
 */
export function withErrorBoundary<T extends (...args: unknown[]) => Promise<void>>(
  handler: T,
  options?: { exitCode?: number }
): T {
  return (async (...args: unknown[]) => {
    try {
      await handler(...args)
    } catch (error) {
      if (error instanceof AhaError) {
        error.display()
      } else if (error instanceof Error) {
        console.error('')
        console.error(chalk.red(`✗ ${error.message}`))
        console.error(chalk.cyan('  Suggestion: Run "aha doctor" for diagnostics'))
        console.error('')
      } else {
        console.error('')
        console.error(chalk.red('✗ An unexpected error occurred'))
        console.error('')
      }

      if (process.env.DEBUG) {
        console.error(chalk.gray('Stack trace:'))
        console.error(error)
      }

      process.exit(options?.exitCode ?? 1)
    }
  }) as T
}

/**
 * Wrap a promise with error boundary
 */
export async function wrapPromise<T>(
  promise: Promise<T>,
  errorCode: ErrorCode
): Promise<T> {
  try {
    return await promise
  } catch (error) {
    throw new AhaError(errorCode, error instanceof Error ? error : undefined)
  }
}

/**
 * Assert condition and throw AhaError if false
 */
export function assert(condition: boolean, errorCode: ErrorCode): asserts condition {
  if (!condition) {
    throw new AhaError(errorCode)
  }
}