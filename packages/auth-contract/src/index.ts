/**
 * Auth contract — shared types and interfaces for Kanban and aha-cli.
 *
 * Goal: eliminate forked redefine-login implementations (#A-006).
 */

export * from './errorCodes';
export * from './recovery';

/** Supported login methods */
export type LoginMethod = 'email-otp' | 'google-oauth' | 'github-oauth';

/** Client kind — influences server-side behavior (e.g., web vs CLI token storage) */
export type ClientKind = 'kanban' | 'aha-cli';

/** Result of a successful login / signup / recovery */
export interface AuthSession {
  token: string;
  userId: string;
  /** Base64-encoded account secret (contentSecretKey) */
  secretBase64: string;
  /** Whether recovery material is available on the server */
  recoveryReady: boolean;
  /** Invitation verification state (if gate enabled) */
  invitationVerified?: boolean;
}

/** Request to complete a Supabase session on the server */
export interface CompleteSupabaseSessionRequest {
  accessToken: string;
  /** Ephemeral public key for server to encrypt the response */
  recoveryPublicKey: string;
  /** Optional: encrypted new secret (if creating new account) */
  newEncryptedContentSecretKey?: string;
  newNonce?: string;
  newEphemeralPublicKey?: string;
  /** Optional: plain new secret (if wrapping key unavailable) */
  newContentSecretKey?: string;
  /** Optional: legacy migration proof */
  legacyPublicKey?: string | null;
  legacyAuthToken?: string | null;
}

/** Server response to complete/recover */
export interface SupabaseCompleteResponse {
  state: 'existing_recovered' | 'new_account_created' | 'migration_required';
  token: string | null;
  userId: string | null;
  encryptedContentSecretKey?: string | null;
  canonicalPublicKey?: string | null;
  reason?: string;
  invitationVerified?: boolean;
}

/** Server response to recover */
export interface SupabaseRecoverResponse {
  token: string;
  userId: string;
  encryptedContentSecretKey: string;
}

/** Auth command types for the orchestrator */
export type AuthCommandType =
  | 'BOOTSTRAP'
  | 'LOGIN_WITH_EMAIL_OTP'
  | 'LOGIN_WITH_GOOGLE'
  | 'COMPLETE_SUPABASE_SESSION'
  | 'RECOVER'
  | 'LOGOUT';

export interface AuthCommand {
  type: AuthCommandType;
  payload?: Record<string, unknown>;
}
