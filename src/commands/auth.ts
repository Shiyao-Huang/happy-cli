import chalk from 'chalk';
import { readCredentials, clearCredentials, clearMachineId, readSettings, writeCredentialsLegacy } from '@/persistence';
import { authAndSetupMachineIfNeeded } from '@/ui/auth';
import { configuration } from '@/configuration';
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { stopDaemon, checkIfDaemonRunningAndCleanupStaleState, ensureDaemonRunning } from '@/daemon/controlClient';
import { logger } from '@/ui/logger';
import os from 'node:os';
import { reconnectWithStoredCredentials } from '@/auth/reconnect';
import { parseBackupKeyToSecret } from '@/utils/backupKey';
import { authGetToken } from '@/api/auth';

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
  aha auth login [--force|--new|-n|--restore|-r] [--code <key>] [--mobile] Authenticate with Aha
  aha auth logout             Remove authentication and machine data
  aha auth status             Show authentication status
  aha auth help               Show this help message

${chalk.bold('Options:')}
  --force     Clear credentials, machine ID, stop daemon, and create a new account
  --new,-n    Explicitly create a new account during web auth
  --restore,-r Reconnect to existing account (keeps daemon alive when possible)
  --code <key> Restore from backup key directly (e.g. XXXXX-XXXXX-...), no browser needed
  --mobile    Use the old mobile QR/manual flow instead of default web login
`);
}

async function handleAuthLogin(args: string[]): Promise<void> {
  const createNewAccount = args.includes('--force') || args.includes('-f') || args.includes('--new') || args.includes('-n');
  const restoreAccount = args.includes('--restore') || args.includes('-r');
  const forceAuth = createNewAccount || restoreAccount;
  const useMobileAuth = args.includes('--mobile');
  const existingCreds = await readCredentials();
  const settings = await readSettings();

  // Extract --code <value> if provided
  const codeIdx = args.indexOf('--code');
  const restoreCode = codeIdx >= 0 && args[codeIdx + 1] ? args[codeIdx + 1] : undefined;

  if (createNewAccount && restoreAccount) {
    console.error(chalk.red('Choose either --new/--force or --restore, not both.'));
    process.exit(1);
  }

  // ── Restore with --code: direct key-based restore, no browser needed ──
  if (restoreCode) {
    console.log(chalk.yellow('Restoring account from backup key...'));
    try {
      const secretBytes = parseBackupKeyToSecret(restoreCode);
      const token = await authGetToken(secretBytes, 'reconnect');
      // New secret key = new encryption context. Clear old machineId to force re-registration.
      await clearMachineId();
      await writeCredentialsLegacy({ secret: secretBytes, token });
      console.log(chalk.green('✓ Credentials restored from backup key'));
    } catch (error) {
      console.error(chalk.red('Restore from backup key failed:'), error instanceof Error ? error.message : 'Unknown error');
      process.exit(1);
    }
    // Stop old daemon (encrypted with old key) and restart with new credentials
    try { await stopDaemon(); } catch { }
    try {
      const daemonResult = await ensureDaemonRunning();
      console.log(chalk.gray(`  Daemon: ${daemonResult === 'started' ? 'started in background' : 'already running'}`));
    } catch (error) {
      console.log(chalk.yellow(`⚠️  Daemon start failed (non-fatal): ${error instanceof Error ? error.message : 'Unknown'}`));
      console.log(chalk.gray('  Run "aha daemon start" to start manually'));
    }
    return;
  }

  // ── Restore with local credentials: try reconnect WITHOUT stopping daemon ──
  if (restoreAccount && existingCreds) {
    console.log(chalk.yellow('Reconnecting to existing account...'));
    try {
      await reconnectWithStoredCredentials(existingCreds);
      // Same account — daemon is still valid, just ensure it's running
      const daemonResult = await ensureDaemonRunning();
      console.log(chalk.green('\n✓ Reconnected successfully'));
      if (settings?.machineId) {
        console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      }
      console.log(chalk.gray(`  Daemon: ${daemonResult === 'started' ? 'started in background' : 'already running'}`));
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
    console.log(chalk.yellow('Force authentication requested.'));
    try {
      await stopDaemon();
      console.log(chalk.gray('✓ Stopped daemon'));
    } catch { }

    await clearCredentials();
    console.log(chalk.gray('✓ Cleared credentials'));
    await clearMachineId();
    console.log(chalk.gray('✓ Cleared machine ID'));
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
  if (!forceAuth) {
    if (existingCreds && settings?.machineId) {
      console.log(chalk.green('✓ Already authenticated'));
      console.log(chalk.gray(`  Machine ID: ${settings.machineId}`));
      console.log(chalk.gray(`  Host: ${os.hostname()}`));
      const daemonResult = await ensureDaemonRunning();
      console.log(chalk.gray(`  Daemon: ${daemonResult === 'started' ? 'started in background' : 'already running'}`));
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
    const daemonResult = await ensureDaemonRunning();
    console.log(chalk.green('\n✓ Authentication successful'));
    console.log(chalk.gray(`  Machine ID: ${result.machineId}`));
    console.log(chalk.gray(`  Daemon: ${daemonResult === 'started' ? 'started in background' : 'already running'}`));
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
    console.log(chalk.yellow('Not currently authenticated'));
    return;
  }

  console.log(chalk.blue('This will log you out of Aha'));
  console.log(chalk.yellow('⚠️  You will need to re-authenticate to use Aha again'));

  // Ask for confirmation
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.yellow('Are you sure you want to log out? (y/N): '), resolve);
  });

  rl.close();

  if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
    try {
      // Stop daemon if running
      try {
        await stopDaemon();
        console.log(chalk.gray('Stopped daemon'));
      } catch { }

      // Remove entire aha directory (as current logout does)
      if (existsSync(ahaDir)) {
        rmSync(ahaDir, { recursive: true, force: true });
      }

      console.log(chalk.green('✓ Successfully logged out'));
      console.log(chalk.gray('  Run "aha auth login" to authenticate again'));
    } catch (error) {
      throw new Error(`Failed to logout: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  } else {
    console.log(chalk.blue('Logout cancelled'));
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

  console.log(chalk.bold('\nAuthentication Status\n'));

  if (!credentials) {
    console.log(chalk.red('✗ Not authenticated'));
    console.log(chalk.gray('  Run "aha auth login" to authenticate'));
    return;
  }

  console.log(chalk.green('✓ Authenticated'));

  // Token preview (first few chars for security)
  const tokenPreview = credentials.token.substring(0, 30) + '...';
  console.log(chalk.gray(`  Token: ${tokenPreview}`));

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
