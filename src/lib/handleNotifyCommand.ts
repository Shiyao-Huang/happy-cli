/**
 * Handle notification command
 */
import chalk from 'chalk'
import { readCredentials } from '@/persistence'
import { ApiClient } from '@/api/api'

export async function handleNotifyCommand(args: string[]): Promise<void> {
  let message = ''
  let title = ''

  // Parse arguments
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '-p' && i + 1 < args.length) {
      message = args[++i]
    } else if (arg === '-t' && i + 1 < args.length) {
      title = args[++i]
    } else if (arg !== '-h' && arg !== '--help') {
      console.error(chalk.red(`Unknown argument for notify command: ${arg}`))
      process.exit(1)
    }
  }

  if (!message) {
    console.error(chalk.red('Error: Message is required. Use -p "your message"'))
    process.exit(1)
  }

  // Load credentials
  const credentials = await readCredentials()
  if (!credentials) {
    console.error(chalk.red('Error: Not authenticated. Please run "aha auth login" first.'))
    process.exit(1)
  }

  console.log(chalk.blue('Sending push notification...'))

  try {
    const api = await ApiClient.create(credentials)
    const notificationTitle = title || 'Aha'

    api.push().sendToAllDevices(
      notificationTitle,
      message,
      {
        source: 'cli',
        timestamp: Date.now()
      }
    )

    console.log(chalk.green('Push notification sent successfully!'))
    console.log(chalk.gray(`  Title: ${notificationTitle}`))
    console.log(chalk.gray(`  Message: ${message}`))

    // Give a moment for the async operation to start
    await new Promise(resolve => setTimeout(resolve, 1000))

  } catch (error) {
    console.error(chalk.red('Failed to send push notification'))
    throw error
  }
}