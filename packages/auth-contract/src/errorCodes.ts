/**
 * Auth contract — standardized error codes for login, signup, verify, and recover.
 *
 * Issue #A-006: kanban vs aha-cli redefine-login convergence.
 */

export type AuthErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'SUPABASE_OTP_FAILED'
  | 'SUPABASE_OAUTH_FAILED'
  | 'SUPABASE_SESSION_MISSING'
  | 'SUPABASE_TOKEN_EXPIRED'
  | 'SERVER_COMPLETE_FAILED'
  | 'SERVER_RECOVER_FAILED'
  | 'SERVER_UNREACHABLE'
  | 'ACCOUNT_NOT_FOUND'
  | 'ACCOUNT_LINK_CONFLICT'
  | 'RECOVERY_NOT_READY'
  | 'MIGRATION_REQUIRED'
  | 'LEGACY_SECRET_REJECTED'
  | 'TOKEN_STORAGE_UNAVAILABLE'
  | 'CREDENTIALS_INVALID'
  | 'UNKNOWN';

export interface AuthError {
  code: AuthErrorCode;
  message: string;
  detail?: string;
  recoveryHint?: string;
}

export function normalizeAuthError(err: unknown): AuthError {
  if (isAxiosLikeError(err)) {
    const status = err.response?.status;
    const code = err.response?.data?.code as string | undefined;

    if (err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
      return { code: 'SERVER_UNREACHABLE', message: 'Server is unreachable. Check your network connection.' };
    }

    if (status === 404) {
      if (code === 'ACCOUNT_NOT_FOUND') {
        return {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'No account is linked to this sign-in identity yet.',
          recoveryHint: 'On another signed-in device, run "aha auth show-join-code" and use the generated command on this device.',
        };
      }
      return { code: 'SERVER_COMPLETE_FAILED', message: 'Server endpoint not found (404).', detail: JSON.stringify(err.response?.data) };
    }

    if (status === 409) {
      if (code === 'ACCOUNT_LINK_CONFLICT') {
        return {
          code: 'ACCOUNT_LINK_CONFLICT',
          message: 'This sign-in identity conflicts with an existing account.',
          recoveryHint: 'On another signed-in device, run "aha auth show-join-code" and use the generated command on this device.',
        };
      }
      if (code === 'RECOVERY_NOT_READY' || code === 'secret-proof-mismatch' || code === 'secret-proof-required') {
        return {
          code: 'RECOVERY_NOT_READY',
          message: 'Automatic recovery is not ready for this account yet.',
          recoveryHint: 'Open "Add New Device" on another signed-in device to continue.',
        };
      }
      if (code === 'MIGRATION_REQUIRED') {
        return {
          code: 'MIGRATION_REQUIRED',
          message: 'This account needs to be migrated to the new sign-in method.',
          recoveryHint: 'On another signed-in device, run "aha auth show-join-code" and use the generated command on this device.',
        };
      }
    }

    if (status === 401) {
      return { code: 'SUPABASE_TOKEN_EXPIRED', message: 'Session expired. Please sign in again.' };
    }

    if (status && status >= 500) {
      return { code: 'SERVER_COMPLETE_FAILED', message: 'Server error during authentication. Please try again later.', detail: JSON.stringify(err.response?.data) };
    }
  }

  if (isSupabaseLikeError(err)) {
    if (err.message?.includes('Invalid login credentials')) {
      return { code: 'SUPABASE_OTP_FAILED', message: 'Invalid email or verification code.' };
    }
    if (err.message?.includes('Email not confirmed')) {
      return { code: 'SUPABASE_OTP_FAILED', message: 'Email not confirmed. Please check your inbox.' };
    }
    return { code: 'SUPABASE_OAUTH_FAILED', message: err.message || 'Supabase authentication failed.' };
  }

  if (err instanceof Error) {
    if (err.message.includes('Missing required')) {
      return { code: 'CONFIG_MISSING', message: err.message };
    }
    return { code: 'UNKNOWN', message: err.message };
  }

  return { code: 'UNKNOWN', message: 'An unknown authentication error occurred.' };
}

function isAxiosLikeError(err: unknown): err is { code?: string; response?: { status?: number; data?: unknown } } {
  return typeof err === 'object' && err !== null && ('response' in err || 'code' in err);
}

function isSupabaseLikeError(err: unknown): err is { message?: string } {
  return typeof err === 'object' && err !== null && 'message' in err;
}
