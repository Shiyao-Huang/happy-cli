/**
 * CLI integration for dashboard command
 * Integrates with happy's existing CLI system (index.ts)
 */

import chalk from 'chalk';
import { handleDashboard } from './dashboard';

export async function handleDashboardCli(args: string[]): Promise<void> {
  // Parse arguments
  const options: any = {};
  let showHelp = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-h' || arg === '--help') {
      showHelp = true;
    } else if (arg === '--refresh' && i + 1 < args.length) {
      const refresh = parseInt(args[++i]);
      if (!isNaN(refresh) && refresh > 0) {
        options.refresh = refresh;
      } else {
        console.error(chalk.red(`Invalid refresh rate: ${args[i]}`));
        process.exit(1);
      }
    } else {
      console.error(chalk.red(`Unknown argument: ${arg}`));
      showHelp = true;
      break;
    }
  }

  if (showHelp) {
    console.log(`
${chalk.bold('happy dashboard')} - Real-time token usage dashboard

${chalk.bold('Usage:')}
  happy dashboard [options]

${chalk.bold('Options:')}
  --refresh <ms>    Dashboard refresh rate in milliseconds (default: 1000)
  -h, --help       Show this help

${chalk.bold('Examples:')}
  happy dashboard              Start dashboard with 1s refresh
  happy dashboard --refresh 500  Start dashboard with 0.5s refresh

${chalk.bold('Note:')}
  Press Ctrl+C to exit the dashboard
`);
    return;
  }

  // Run command
  await handleDashboard(options);
}
