import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { authenticateCodex } from './connect/authenticateCodex';
import { authenticateClaude } from './connect/authenticateClaude';
import { authenticateGemini } from './connect/authenticateGemini';
import { confirmPrompt, printCliDryRunPreview } from './globalCli';
import { t } from '@/i18n';

type ConnectVendorInput = 'codex' | 'claude' | 'gemini' | 'openai' | 'anthropic';
type ServerVendor = 'openai' | 'anthropic' | 'gemini';

/**
 * Handle connect subcommand
 *
 * Implements connect subcommands for storing AI vendor API keys:
 * - connect codex: Store OpenAI API key in Aha cloud
 * - connect claude: Store Anthropic API key in Aha cloud
 * - connect gemini: Store Gemini API key in Aha cloud
 * - connect help: Show help for connect command
 */
export async function handleConnectCommand(args: string[]): Promise<void> {
    const subcommand = args[0];
    const asJson = args.includes('--json');

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'list':
            await handleListConnections(asJson);
            break;
        case 'remove':
            await handleRemoveConnection(args.slice(1), asJson);
            break;
        case 'codex':
            await handleConnectVendor('codex', 'OpenAI');
            break;
        case 'claude':
            await handleConnectVendor('claude', 'Anthropic');
            break;
        case 'gemini':
            await handleConnectVendor('gemini', 'Gemini');
            break;
        default:
            console.error(chalk.red(t('connect.unknownTarget', { target: subcommand })));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('aha connect')} - Connect AI vendor API keys to Aha cloud

${chalk.bold('Usage:')}
  aha connect list         List stored AI vendor connections
  aha connect remove <vendor> [--force] [--dry-run] Remove a stored vendor connection
  aha connect codex        Store your Codex API key in Aha cloud
  aha connect claude       Store your Anthropic API key in Aha cloud
  aha connect gemini       Store your Gemini API key in Aha cloud
  aha connect help         Show this help message

${chalk.bold('Flags:')}
  --json                   Emit machine-readable JSON where supported
  --format <json|table>    Select JSON or human output mode
  --force, -f             Skip confirmation for remove
  --dry-run               Preview removal without executing it

${chalk.bold('Description:')}
  The connect command allows you to securely store your AI vendor API keys
  in Aha cloud. This enables you to use these services through Aha
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  aha connect list
  aha connect list --json
  aha connect remove codex --dry-run --json
  aha connect remove codex --force
  aha connect codex
  aha connect claude
  aha connect gemini

${chalk.bold('Notes:')}
  • You must be authenticated with Aha first (run 'aha auth login')
  • API keys are encrypted and stored securely in Aha cloud
  • You can manage your stored keys at app.aha.engineering
`);
}

function resolveServerVendor(vendor: ConnectVendorInput): ServerVendor {
    switch (vendor) {
        case 'codex':
        case 'openai':
            return 'openai';
        case 'claude':
        case 'anthropic':
            return 'anthropic';
        case 'gemini':
            return 'gemini';
        default:
            throw new Error(`Unsupported vendor: ${vendor}`);
    }
}

function getDisplayVendor(vendor: string): string {
    switch (vendor) {
        case 'openai':
            return 'codex';
        case 'anthropic':
            return 'claude';
        case 'gemini':
            return 'gemini';
        default:
            return vendor;
    }
}

async function confirm(prompt: string, force = false): Promise<boolean> {
    return confirmPrompt(prompt, { force, forceFlagName: '--force' });
}

async function createApiClient(): Promise<ApiClient> {
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow(t('connect.notAuthenticated')));
        console.log(chalk.gray(t('connect.loginHint')));
        process.exit(1);
    }

    return ApiClient.create(credentials);
}

async function handleListConnections(asJson: boolean): Promise<void> {
    const api = await createApiClient();
    const result = await api.listVendorTokens();

    if (asJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }

    if (!result.tokens.length) {
        console.log(chalk.yellow(t('connect.noTokens')));
        return;
    }

    console.log(chalk.bold(t('connect.storedConnections', { count: result.tokens.length })));
    for (const token of result.tokens) {
        const label = getDisplayVendor(token.vendor);
        console.log(`${chalk.green('✓')} ${chalk.bold(label)} ${chalk.gray(`(${token.vendor})`)}`);
    }
    console.log();
}

async function handleRemoveConnection(args: string[], asJson: boolean): Promise<void> {
    const vendorInput = args.find((value) => !value.startsWith('-')) as ConnectVendorInput | undefined;
    if (!vendorInput) {
        console.error(chalk.red(t('connect.removeUsage')));
        process.exit(1);
    }

    const serverVendor = resolveServerVendor(vendorInput);
    const displayVendor = getDisplayVendor(serverVendor);
    const dryRun = args.includes('--dry-run');

    if (dryRun) {
        printCliDryRunPreview(
            {
                action: 'connect.remove',
                summary: `Would remove stored ${displayVendor} credentials from Aha cloud.`,
                target: { vendor: displayVendor },
                payload: { serverVendor },
            },
            { asJson },
        );
        return;
    }

    const shouldRemove = await confirm(
        t('connect.removeConfirm', { vendor: displayVendor }),
        args.includes('--force') || args.includes('-f'),
    );
    if (!shouldRemove) {
        console.log(chalk.yellow(t('common.operationCancelled')));
        return;
    }

    const api = await createApiClient();
    await api.removeVendorToken(serverVendor);
    if (asJson) {
        console.log(JSON.stringify({ ok: true, removed: true, vendor: displayVendor }, null, 2));
        return;
    }
    console.log(chalk.green(t('connect.removedSuccess', { vendor: displayVendor })));
}

async function handleConnectVendor(vendor: 'codex' | 'claude' | 'gemini', displayName: string): Promise<void> {
    console.log(chalk.bold(t('connect.connecting', { vendor: displayName })));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow(t('connect.notAuthenticated')));
        console.log(chalk.gray(t('connect.loginHint')));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    // Handle vendor authentication
    if (vendor === 'codex') {
        console.log(t('connect.registering', { vendor: 'Codex' }));
        const codexAuthTokens = await authenticateCodex();
        await api.registerVendorToken('openai', { oauth: codexAuthTokens });
        console.log(t('connect.registered', { vendor: 'Codex' }));
        process.exit(0);
    } else if (vendor === 'claude') {
        console.log(t('connect.registering', { vendor: 'Anthropic' }));
        const anthropicAuthTokens = await authenticateClaude();
        await api.registerVendorToken('anthropic', { oauth: anthropicAuthTokens });
        console.log(t('connect.registered', { vendor: 'Anthropic' }));
        process.exit(0);
    } else if (vendor === 'gemini') {
        console.log(t('connect.registering', { vendor: 'Gemini' }));
        const geminiAuthTokens = await authenticateGemini();
        await api.registerVendorToken('gemini', { oauth: geminiAuthTokens });
        console.log(t('connect.registered', { vendor: 'Gemini' }));
        process.exit(0);
    } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
    }
}
