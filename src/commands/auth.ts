import chalk from 'chalk';
import axios from 'axios';
import { t } from '@/i18n';
import { readCredentials, clearCredentials, clearMachineId, readSettings, writeCredentialsContentSecretKey, writeCredentialsLegacy, Credentials } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState, ensureDaemonRunning } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import os from 'node:os';
import { reconnectWithStoredCredentials } from '@/auth/reconnect';
import { authGetToken } from '@/api/auth';
import { doEmailOtpAuth } from '@/api/supabaseAuth';
import { ApiClient } from '@/api/api';
import { createAccountJoinTicket, isAccountJoinTicket, redeemAccountJoinTicket } from '@/api/accountJoin';
import { bootstrapRecoveryMaterial, getRecoveryMaterialSecret } from '@/auth/recoveryBootstrap';
import { DEFAULT_WEBAPP_URL, writePersistentCliConfig } from '@/configurationResolver';
import { parseBackupKeyToSecret } from '@/utils/backupKey';

function decodeTokenSubject(token: string): { accountId?: string; sessionId?: string } {
  try {
    const [, payload] = token.split('.');
    if (!payload) {
      return {};
    }
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      session?: string;
    };
    return {
      accountId: parsed.sub,
      sessionId: parsed.session,
    };
  } catch {
    return {};
  }
}

function readRestoreCodeArg(args: string[]): string | undefined {
  const codeIdx = args.indexOf('--code');
  if (codeIdx >= 0 && args[codeIdx + 1]) {
    return args[codeIdx + 1];
  }

  const positional = args.find((arg) => !arg.startsWith('-'));
  return positional;
}

type AuthLoginServerOverrides = {
  args: string[];
  serverUrl?: string;
  webappUrl?: string;
};

type MutableServerConfiguration = {
  serverUrl: string;
  webappUrl: string;
};

function normalizeUrlOption(flag: string, value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    throw new Error(`${flag} must be a valid URL. Received: ${value}`);
  }
}

function readServerUrlFlag(flag: string): 'serverUrl' | 'webappUrl' | null {
  if (flag === '--server-url' || flag === '--base-url') {
    return 'serverUrl';
  }
  if (flag === '--webapp-url') {
    return 'webappUrl';
  }
  return null;
}

function parseAuthLoginServerOverrides(args: string[]): AuthLoginServerOverrides {
  const strippedArgs: string[] = [];
  const overrides: Omit<AuthLoginServerOverrides, 'args'> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [maybeFlag, inlineValue] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    const key = readServerUrlFlag(maybeFlag);

    if (!key) {
      strippedArgs.push(arg);
      continue;
    }

    const rawValue = inlineValue ?? args[index + 1];
    if (!rawValue) {
      throw new Error(`Missing value for ${maybeFlag}.`);
    }

    overrides[key] = normalizeUrlOption(maybeFlag, rawValue);
    if (inlineValue === undefined) {
      index += 1;
    }
  }

  return {
    args: strippedArgs,
    ...overrides,
  };
}

function applyAuthLoginServerOverrides(overrides: AuthLoginServerOverrides): Partial<MutableServerConfiguration> {
  const patch: Partial<MutableServerConfiguration> = {};
  const mutableConfiguration = configuration as unknown as MutableServerConfiguration;

  if (overrides.serverUrl) {
    mutableConfiguration.serverUrl = overrides.serverUrl;
    patch.serverUrl = overrides.serverUrl;
  }
  if (overrides.webappUrl) {
    mutableConfiguration.webappUrl = overrides.webappUrl;
    patch.webappUrl = overrides.webappUrl;
  }

  return patch;
}

function persistAuthLoginServerOverrides(patch: Partial<MutableServerConfiguration>): void {
  if (!patch.serverUrl && !patch.webappUrl) {
    return;
  }

  writePersistentCliConfig(configuration.configFile, patch);
  if (patch.serverUrl) {
    console.log(chalk.gray(`  Server URL: ${configuration.serverUrl}`));
  }
  if (patch.webappUrl) {
    console.log(chalk.gray(`  Web app URL: ${configuration.webappUrl}`));
  }
}

type DaemonEnsureResult = Awaited<ReturnType<typeof ensureDaemonRunning>> | null;

async function ensureDaemonRunningAfterAuth(): Promise<DaemonEnsureResult> {
  try {
    return await ensureDaemonRunning();
  } catch (error) {
    await checkIfDaemonRunningAndCleanupStaleState().catch(() => false);

    try {
      return await ensureDaemonRunning();
    } catch (retryError) {
      console.log(chalk.yellow(`⚠️  Daemon start failed (non-fatal): ${retryError instanceof Error ? retryError.message : 'Unknown'}`));
      console.log(chalk.gray('  Run "aha daemon start" to start manually'));
      return null;
    }
  }
}

function printDaemonStatus(result: DaemonEnsureResult): void {
  if (!result) {
    return;
  }

  console.log(chalk.gray(`  Daemon: ${result === 'started' ? 'started in background' : 'already running'}`));
}

function describeBootstrapError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const serverError = typeof error.response?.data?.error === 'string'
      ? error.response.data.error
      : null;
    if (serverError) {
      return serverError;
    }
    if (error.code) {
      return error.code;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function describeJoinError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const serverCode = typeof error.response?.data?.code === 'string'
      ? error.response.data.code
      : null;
    const serverError = typeof error.response?.data?.error === 'string'
      ? error.response.data.error
      : null;

    if (serverCode === 'JOIN_TICKET_INVALID' || serverCode === 'JOIN_CODE_INVALID' || error.response?.status === 404) {
      return t('auth.joinTicketInvalid');
    }

    if (serverCode === 'RECOVERY_NOT_READY' || error.response?.status === 409) {
      return t('auth.joinRecoveryNotReady');
    }

    if (serverError) {
      return serverError;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}

function formatExpiration(expiresAt: string | number | null | undefined): string | null {
  if (expiresAt === null || expiresAt === undefined) {
    return null;
  }

  const parsed = new Date(expiresAt);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleString();
  }

  return String(expiresAt);
}

function quoteShellValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildJoinLoginCommand(code?: string): string {
  const loginArgs = [
    'npx aha auth login',
    '--server-url',
    quoteShellValue(configuration.serverUrl),
    '--webapp-url',
    quoteShellValue(configuration.webappUrl || DEFAULT_WEBAPP_URL),
  ];
  if (code) {
    loginArgs.push('--code', quoteShellValue(code));
  }
  const loginCommand = loginArgs.join(' ');

  return `npm i aha-agi && ${loginCommand}`;
}

async function ensureRecoveryMaterialForSeed(token: string, secret: Uint8Array, source: string): Promise<void> {
  try {
    await bootstrapRecoveryMaterial(token, secret);
  } catch (error) {
    console.log(chalk.yellow(`⚠️  Recovery bootstrap failed after ${source}: ${describeBootstrapError(error)}`));
    console.log(chalk.gray('  Same-Google auto-recovery may still fall back to a join ticket or Restore Key until this succeeds.'));
  }
}

async function ensureRecoveryMaterialForCredentials(credentials: Credentials, source: string): Promise<void> {
  const secret = getRecoveryMaterialSecret(credentials);
  if (!secret) {
    return;
  }

  await ensureRecoveryMaterialForSeed(credentials.token, secret, source);
}

export async function handleAuthCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    showAuthHelp();
    return;
  }

  switch (subcommand) {
    case 'login':
      await handleAuthLogin(args.slice(1));
      break;
    case 'reconnect':
      await handleAuthReconnect();
      break;
    case 'join':
      await handleAuthJoin(args.slice(1));
      break;
    case 'show-join-code':
      await handleAuthShowJoinCode();
      break;
    case 'logout':
      await handleAuthLogout();
      break;
    // case 'backup':
    //   await handleAuthShowBackup();
    //   break;
    case 'status':
      await handleAuthStatus();
      break;
    default:
      console.error(chalk.red(`Unknown auth subcommand: ${subcommand}`));
      showAuthHelp();
      process.exit(1);
  }
}

function showAuthHelp(): void {
  console.log(`
${chalk.bold('aha auth')} - Authentication management

${chalk.bold('Usage:')}
  aha auth login [--code <ticket>] [--server-url <url>] [--webapp-url <url>] [--force|--new|-n] [--mobile] [--email] Authenticate with Aha
  aha auth reconnect                                   Refresh token for the currently cached account
  aha auth join --ticket <ticket>                      Join an existing account from a one-time link ticket
  aha auth show-join-code                              Generate a one-time join command for another machine
  aha auth logout                                      Remove authentication and machine data
  aha auth status                                      Show authentication status
  aha auth help                                        Show this help message

${chalk.bold('Options:')}
  --force     Clear credentials, machine ID, stop daemon, and create a new account
  --new,-n    Explicitly create a new account during web auth
  --code <ticket|backup-key> One-time join ticket or backup key, no browser needed
  --server-url <url>, --base-url <url> Server API URL to use and save for future runs
  --webapp-url <url> Web app URL to save for browser-based auth and device links
  --ticket    Explicit flag for one-time account join tickets
  --mobile    Use the old mobile QR/manual flow instead of default web login
  --email     Use email OTP login (no browser needed, works on headless Linux)

${chalk.bold('Recommended flows:')}
  aha auth login
  aha auth login --server-url https://aha-agi.com/api --webapp-url https://aha-agi.com/webappv3 --code aha_join_xxx
  aha auth login --code XXXXX-XXXXX-XXXXX-XXXXX
  aha auth show-join-code
  aha auth reconnect
  aha auth login --email
  aha auth login --force
`);
}

async function handleAuthJoin(args: string[]): Promise<void> {
  const ticketIdx = args.indexOf('--ticket');
  const ticket = (ticketIdx >= 0 && args[ticketIdx + 1]) ? args[ticketIdx + 1] : readRestoreCodeArg(args);
  if (!ticket) {
    console.error(chalk.red('Missing join ticket.'));
    console.log(chalk.gray('Usage: aha auth join --ticket aha_join_xxxxxxxxxxxxxxxxxxxxxxxx'));
    process.exit(1);
  }

  console.log(chalk.yellow(t('auth.joiningFromTicket')));
  try {
    const result = await redeemAccountJoinTicket(ticket);
    await clearMachineId();
    await writeCredentialsContentSecretKey({
      contentSecretKey: result.secret,
      token: result.token,
    });
    await ensureRecoveryMaterialForSeed(result.token, result.secret, 'join');

    console.log(chalk.green(t('auth.joinSuccess')));
    if (result.userId) {
      console.log(chalk.gray(`  Account ID: ${result.userId}`));
    }
  } catch (error) {
    console.error(chalk.red('Join failed:'), describeJoinError(error));
    process.exit(1);
  }

  try { await stopDaemon(); } catch { }
  printDaemonStatus(await ensureDaemonRunningAfterAuth());
}

async function handleAuthBackupKeyRestore(backupKey: string): Promise<void> {
  let secret: Uint8Array;
  try {
    secret = parseBackupKeyToSecret(backupKey);
  } catch {
    console.error(chalk.red('Invalid code. Expected a one-time join ticket or backup key.'));
    console.log(chalk.gray('To join from another device, run: aha auth show-join-code'));
    console.log(chalk.gray('To restore from a backup key, use the secretKeyFormatted value from your restore JSON.'));
    process.exit(1);
  }

  console.log(chalk.yellow('Restoring account from backup key...'));
  try {
    const token = await authGetToken(secret, 'reconnect');
    await clearMachineId();
    await writeCredentialsContentSecretKey({
      contentSecretKey: secret,
      token,
    });
    await ensureRecoveryMaterialForSeed(token, secret, 'backup key restore');

    const { accountId } = decodeTokenSubject(token);
    console.log(chalk.green('Restored account from backup key.'));
    if (accountId) {
      console.log(chalk.gray(`  Account ID: ${accountId}`));
    }
  } catch (error) {
    console.error(chalk.red('Backup-key restore failed:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }

  try { await stopDaemon(); } catch { }
  printDaemonStatus(await ensureDaemonRunningAfterAuth());
}

async function handleAuthShowJoinCode(): Promise<void> {
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow(t('common.notAuthenticated')), chalk.green('aha auth login'));
    process.exit(1);
  }

  console.log(chalk.yellow(t('auth.generatingJoinCode')));
  try {
    const { ticket, expiresAt } = await createAccountJoinTicket(credentials.token);
    console.log(chalk.green(t('auth.joinCodeReady')));
    console.log(chalk.gray(`  ${t('auth.runOnNewMachine')}`));
    console.log(chalk.cyan(`  ${buildJoinLoginCommand(ticket)}`));
    console.log(chalk.gray(`  ${t('auth.joinCodeUsageHint')}`));

    const expiresLabel = formatExpiration(expiresAt);
    if (expiresLabel) {
      console.log(chalk.gray(`  Expires: ${expiresLabel}`));
    }
  } catch (error) {
    console.error(chalk.red('Failed to generate join command:'), error instanceof Error ? error.message : 'Unknown error');
    process.exit(1);
  }
}

async function handleAuthReconnect(): Promise<void> {
  const existingCreds = await readCredentials();
  const settings = await readSettings();

  if (!existingCreds) {
    console.error(chalk.red('No local credentials found.'));
    console.log(chalk.gray('Use `aha auth show-join-code` on another signed-in device to generate a join command, then run it here.'));
    process.exit(1);
  }

  console.log(chalk.yellow(t('auth.reconnecting')));
  try {
    const refreshed = await reconnectWithStoredCredentials(existingCreds);
    await ensureRecoveryMaterialForCredentials(refreshed, 'reconnect');
    const daemonResult = await ensureDaemonRunningAfterAuth();
    const { accountId } = decodeTokenSubject(refreshed.token);

    console.log(chalk.green(t('auth.reconnectSuccess')));
    if (accountId) {
      console.log(chalk.gray(`  Account ID: ${accountId}`));
    }
    if (settings?.machineId) {
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
    }
    printDaemonStatus(daemonResult);
  } catch (error) {
    console.error(chalk.red('Reconnect failed:'), error instanceof Error ? error.message : 'Unknown error');
    console.log(chalk.gray('Use `aha auth show-join-code` on another signed-in device to generate a join command, then run it here.'));
    process.exit(1);
  }
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const serverOverrides = parseAuthLoginServerOverrides(args);
  const serverOverridePatch = applyAuthLoginServerOverrides(serverOverrides);
  const loginArgs = serverOverrides.args;
  const hasServerOverride = !!serverOverridePatch.serverUrl || !!serverOverridePatch.webappUrl;
  const createNewAccount = loginArgs.includes('--force') || loginArgs.includes('-f') || loginArgs.includes('--new') || loginArgs.includes('-n');
  const restoreAccount = loginArgs.includes('--restore') || loginArgs.includes('-r');
  const forceAuth = createNewAccount || restoreAccount;
  const useMobileAuth = loginArgs.includes('--mobile');
  const useEmailAuth = loginArgs.includes('--email');
  const existingCreds = await readCredentials();
  const settings = await readSettings();

  // Extract --code <value> if provided
  const restoreCode = readRestoreCodeArg(loginArgs);

  if (createNewAccount && restoreAccount) {
    console.error(chalk.red('Choose either --new/--force or --restore, not both.'));
    process.exit(1);
  }

  // ── Email OTP: terminal-only login, no browser needed ──
  if (useEmailAuth) {
    const result = await doEmailOtpAuth();
    if (!result) {
      process.exit(1);
    }

    await clearMachineId();
    await writeCredentialsLegacy({ secret: result.secret, token: result.token });
    await ensureRecoveryMaterialForSeed(result.token, result.secret, 'email login');
    persistAuthLoginServerOverrides(serverOverridePatch);
    const { accountId } = decodeTokenSubject(result.token);
    console.log(chalk.green(t('auth.signedInEmail')));
    if (accountId) {
      console.log(chalk.gray(`  Account ID: ${accountId}`));
    }
    console.log(chalk.gray('\nTo add another machine later, run `aha auth show-join-code` on this device.'));

    try { await stopDaemon(); } catch { }
    printDaemonStatus(await ensureDaemonRunningAfterAuth());
    return;
  }

  // ── Restore with --code: join ticket or backup key ──
  if (restoreCode) {
    // The join path starts the daemon before returning, so save URL overrides first.
    persistAuthLoginServerOverrides(serverOverridePatch);
    if (isAccountJoinTicket(restoreCode)) {
      await handleAuthJoin(['--ticket', restoreCode]);
      return;
    }
    await handleAuthBackupKeyRestore(restoreCode);
    return;
  }

  // ── Restore with local credentials: try reconnect WITHOUT stopping daemon ──
  if (restoreAccount && existingCreds) {
    console.log(chalk.yellow(t('auth.reconnecting')));
    try {
      const refreshed = await reconnectWithStoredCredentials(existingCreds);
      await ensureRecoveryMaterialForCredentials(refreshed, 'login --restore');
      // Same account — daemon is still valid, just ensure it's running
      const daemonResult = await ensureDaemonRunningAfterAuth();
      const { accountId } = decodeTokenSubject(refreshed.token);
      console.log(chalk.green(t('auth.reconnectSuccess')));
      if (accountId) {
        console.log(chalk.gray(`  Account ID: ${accountId}`));
      }
      if (settings?.machineId) {
        console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      }
      printDaemonStatus(daemonResult);
      return;
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Local reconnect failed: ${error instanceof Error ? error.message : 'Unknown error'}`));
      console.log(chalk.gray('  Falling back to browser restore flow...\n'));
      // NOW stop daemon — we're switching to browser flow which may change credentials
      try {
        await stopDaemon();
        console.log(chalk.gray('✓ Stopped daemon'));
      } catch { }
    }
  }

  // ── Force new account: stop daemon + clear creds ──
  if (createNewAccount) {
    console.log(chalk.yellow(t('auth.forceAuthRequested')));
    try {
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch { }

    await clearCredentials();
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared credentials and machine ID'));
    console.log('');
  }

  // ── Restore without local creds: need browser flow ──
  if (restoreAccount && !existingCreds) {
    console.log(chalk.yellow('No local credentials. Opening browser restore flow...'));
    try {
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch { }
    console.log('');
  }

  // Check if already authenticated (if not forcing)
  if (!forceAuth && !hasServerOverride) {
    if (existingCreds && settings?.machineId) {
      console.log(chalk.green(t('auth.alreadyAuthenticated')));
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      printDaemonStatus(await ensureDaemonRunningAfterAuth());
      console.log(chalk.gray(`  Use 'aha auth login --force' to re-authenticate`));
      return;
    } else if (existingCreds && !settings?.machineId) {
      console.log(chalk.yellow('⚠️  Credentials exist but machine ID is missing'));
      console.log(chalk.gray('  This can happen if --auth flag was used previously'));
      console.log(chalk.gray('  Fixing by setting up machine...\n'));
    }
  }

  // Perform authentication and machine setup
  try {
    const result = await authAndSetupMachineIfNeeded({
      method: useMobileAuth ? 'mobile' : 'web',
      webNextPath: useMobileAuth ? undefined : '/teams/new',
      webMode: restoreAccount ? 'reconnect' : (createNewAccount ? 'create' : 'auto'),
      forceAuth: restoreAccount
    });
    await ensureRecoveryMaterialForCredentials(result.credentials, useMobileAuth ? 'mobile auth' : 'web auth');
    persistAuthLoginServerOverrides(serverOverridePatch);
    const daemonResult = await ensureDaemonRunningAfterAuth();
    const { accountId } = decodeTokenSubject(result.credentials.token);
    console.log(chalk.green(t('auth.authSuccess')));
    if (accountId) {
      console.log(chalk.gray(`  Account ID: ${accountId}`));
    }
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
    printDaemonStatus(daemonResult);
  } catch (error) {
    console.error(chalk.red('Authentication failed:'), error instanceof Error ? error.message : 'Unknown error');
    if (forceAuth) {
      try {
        await ensureDaemonRunning();
        console.log(chalk.gray('  Daemon restarted'));
      } catch { }
    }
    process.exit(1);
  }
}

async function handleAuthLogout(): Promise<void> {
  // "auth logout will essentially clear the private key that originally came from the phone"
  const ahaDir = configuration.ahaHomeDir;

  // Check if authenticated
  const credentials = await readCredentials();
  if (!credentials) {
    console.log(chalk.yellow(t('auth.notCurrentlyAuthenticated')));
    return;
  }

  console.log(chalk.blue(t('auth.logoutWarning')));
  console.log(chalk.yellow(t('auth.logoutReauthWarning')));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow(t('auth.logoutConfirmPrompt')), resolve);
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon();
        console.log(chalk.gray('Stopped daemon'));
      } catch { }

      // Remove auth files but preserve settings.json (contains machineId)
      if (existsSync(ahaDir)) {
        const settingsPath = join(ahaDir, 'settings.json');
        let savedSettings: string | null = null;

        // Backup settings before wiping
        if (existsSync(settingsPath)) {
          savedSettings = readFileSync(settingsPath, 'utf-8');
        }

        rmSync(ahaDir, { recursive: true, force: true });

        // Restore settings (machineId persists across logout/login)
        if (savedSettings) {
          mkdirSync(ahaDir, { recursive: true });
          writeFileSync(settingsPath, savedSettings);
        }
      }

      console.log(chalk.green(t('auth.logoutSuccess')));
      console.log(chalk.gray('  Run "aha auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(chalk.blue(t('auth.logoutCancelled')));
  }
}

// async function handleAuthShowBackup(): Promise<void> {
//   const credentials = await readCredentials();
//   const settings = await readSettings();

//   if (!credentials) {
//     console.log(chalk.yellow('Not authenticated'));
//     console.log(chalk.gray('Run "aha auth login" to authenticate first'));
//     return;
//   }

//   // Format the backup key exactly like the mobile client expects
//   // Mobile client uses formatSecretKeyForBackup which converts to base32 with dashes
//   const formattedBackupKey = formatSecretKeyForBackup(credentials.encryption.secret);

//   console.log(chalk.bold('\n📱 Backup Key\n'));

//   // Display in the format XXXXX-XXXXX-XXXXX-... that mobile expects
//   console.log(chalk.cyan('Your backup key:'));
//   console.log(chalk.bold(formattedBackupKey));
//   console.log('');

//   console.log(chalk.cyan('Machine Information:'));
//   console.log(`  Machine ID: ${settings?.machineId || 'not set'}`);
//   console.log(`  Host: ${os.hostname()}`);
//   console.log('');

//   console.log(chalk.bold('How to use this backup key:'));
//   console.log(chalk.gray('• In Aha mobile app: Go to restore/link device and enter this key'));
//   console.log(chalk.gray('• This key format matches what the mobile app expects'));
//   console.log(chalk.gray('• You can type it with or without dashes - the app will normalize it'));
//   console.log(chalk.gray('• Common typos (0→O, 1→I) are automatically corrected'));
//   console.log('');

//   console.log(chalk.yellow('⚠️  Keep this key secure - it provides full access to your account'));
// }

async function handleAuthStatus(): Promise<void> {
  const credentials = await readCredentials();
  const settings = await readSettings();

  console.log(chalk.bold(t('auth.statusHeader')));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "aha auth login" to authenticate'));
    return;
  }

  console.log(chalk.green('✓ Authenticated'));

  // Token preview (first few chars for security)
  const tokenPreview = credentials.token.substring(0, 30) + '...';
  const { accountId, sessionId } = decodeTokenSubject(credentials.token);
  console.log(chalk.gray(`  Token: ${tokenPreview}`));
  if (accountId) {
    console.log(chalk.gray(`  Account ID: ${accountId}`));
  }
  if (sessionId) {
    console.log(chalk.gray(`  Auth Session ID: ${sessionId}`));
  }

  // Machine status
  if (settings?.machineId) {
    console.log(chalk.green('✓ Machine registered'));
    console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
    console.log(chalk.gray(`  Host: ${os.hostname()}`));
  } else {
    console.log(chalk.yellow('⚠️  Machine not registered'));
    console.log(chalk.gray('  Run "aha auth login --force" to fix this'));
  }

  // Data location
  console.log(chalk.gray(`\n  Data directory: ${configuration.ahaHomeDir}`));

  try {
    const api = await ApiClient.create(credentials);
    const { teams } = await api.listTeams();
    console.log(chalk.bold(`\nTeams (${teams.length})`));
    if (teams.length === 0) {
      console.log(chalk.gray('  No teams found'));
    } else {
      for (const team of teams) {
        console.log(chalk.gray(`  - ${team.name} (${team.id}) · members ${team.memberCount} · tasks ${team.taskCount}`));
      }
    }
  } catch (error) {
    logger.debug('[AUTH] Failed to load teams for auth status:', error);
    console.log(chalk.yellow('\n⚠️  Failed to load teams'));
    console.log(chalk.gray(`  ${error instanceof Error ? error.message : 'Unknown error'}`));
  }

  // Daemon status
  try {
    const running = await checkIfDaemonRunningAndCleanupStaleState();
    if (running) {
      console.log(chalk.green('✓ Daemon running'));
    } else {
      console.log(chalk.gray('✗ Daemon not running'));
    }
  } catch {
    console.log(chalk.gray('✗ Daemon not running'));
  }
}
