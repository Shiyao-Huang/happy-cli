import chalk from 'chalk';
import { readCredentials } from '@/persistence';
import { ApiClient } from '@/api/api';
import { authenticateCodex } from './connect/authenticateCodex';
import { authenticateClaude } from './connect/authenticateClaude';
import { authenticateGemini } from './connect/authenticateGemini';

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

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        showConnectHelp();
        return;
    }

    switch (subcommand.toLowerCase()) {
        case 'list':
            await handleListConnections();
            break;
        case 'remove':
            await handleRemoveConnection(args.slice(1));
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
            console.error(chalk.red(`Unknown connect target: ${subcommand}`));
            showConnectHelp();
            process.exit(1);
    }
}

function showConnectHelp(): void {
    console.log(`
${chalk.bold('aha connect')} - Connect AI vendor API keys to Aha cloud

${chalk.bold('Usage:')}
  aha connect list         List stored AI vendor connections
  aha connect remove <vendor> Remove a stored vendor connection
  aha connect codex        Store your Codex API key in Aha cloud
  aha connect claude       Store your Anthropic API key in Aha cloud
  aha connect gemini       Store your Gemini API key in Aha cloud
  aha connect help         Show this help message

${chalk.bold('Description:')}
  The connect command allows you to securely store your AI vendor API keys
  in Aha cloud. This enables you to use these services through Aha
  without exposing your API keys locally.

${chalk.bold('Examples:')}
  aha connect list
  aha connect remove codex
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

async function confirm(prompt: string): Promise<boolean> {
    const { default: readline } = await import('node:readline/promises');
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    try {
        const answer = await rl.question(chalk.cyan(prompt));
        return answer.trim().toLowerCase() === 'y';
    } finally {
        rl.close();
    }
}

async function createApiClient(): Promise<ApiClient> {
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Aha'));
        console.log(chalk.gray('  Please run "aha auth login" first'));
        process.exit(1);
    }

    return ApiClient.create(credentials);
}

async function handleListConnections(): Promise<void> {
    const api = await createApiClient();
    const result = await api.listVendorTokens();

    if (!result.tokens.length) {
        console.log(chalk.yellow('No vendor connections stored in Aha cloud.'));
        return;
    }

    console.log(chalk.bold(`\nStored vendor connections (${result.tokens.length})\n`));
    for (const token of result.tokens) {
        const label = getDisplayVendor(token.vendor);
        console.log(`${chalk.green('✓')} ${chalk.bold(label)} ${chalk.gray(`(${token.vendor})`)}`);
    }
    console.log();
}

async function handleRemoveConnection(args: string[]): Promise<void> {
    const vendorInput = args[0] as ConnectVendorInput | undefined;
    if (!vendorInput) {
        console.error(chalk.red('Usage: aha connect remove <codex|claude|gemini>'));
        process.exit(1);
    }

    const serverVendor = resolveServerVendor(vendorInput);
    const displayVendor = getDisplayVendor(serverVendor);
    const shouldRemove = await confirm(`Remove stored ${displayVendor} credentials from Aha cloud? (y/N): `);
    if (!shouldRemove) {
        console.log(chalk.yellow('Operation cancelled'));
        return;
    }

    const api = await createApiClient();
    await api.removeVendorToken(serverVendor);
    console.log(chalk.green(`✅ Removed ${displayVendor} credentials from Aha cloud`));
}

async function handleConnectVendor(vendor: 'codex' | 'claude' | 'gemini', displayName: string): Promise<void> {
    console.log(chalk.bold(`\n🔌 Connecting ${displayName} to Aha cloud\n`));

    // Check if authenticated
    const credentials = await readCredentials();
    if (!credentials) {
        console.log(chalk.yellow('⚠️  Not authenticated with Aha'));
        console.log(chalk.gray('  Please run "aha auth login" first'));
        process.exit(1);
    }

    // Create API client
    const api = await ApiClient.create(credentials);

    // Handle vendor authentication
    if (vendor === 'codex') {
        console.log('🚀 Registering Codex token with server');
        const codexAuthTokens = await authenticateCodex();
        await api.registerVendorToken('openai', { oauth: codexAuthTokens });
        console.log('✅ Codex token registered with server');
        process.exit(0);
    } else if (vendor === 'claude') {
        console.log('🚀 Registering Anthropic token with server');
        const anthropicAuthTokens = await authenticateClaude();
        await api.registerVendorToken('anthropic', { oauth: anthropicAuthTokens });
        console.log('✅ Anthropic token registered with server');
        process.exit(0);
    } else if (vendor === 'gemini') {
        console.log('🚀 Registering Gemini token with server');
        const geminiAuthTokens = await authenticateGemini();
        await api.registerVendorToken('gemini', { oauth: geminiAuthTokens });
        console.log('✅ Gemini token registered with server');
        process.exit(0);
    } else {
        throw new Error(`Unsupported vendor: ${vendor}`);
    }
}
