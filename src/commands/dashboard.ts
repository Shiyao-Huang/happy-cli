/**
 * Dashboard Command - Real-time token usage dashboard
 */

import { getTokenMonitor } from '@/claude/sdk/tokenMonitor'
import { getModelManager } from '@/claude/sdk/modelManager'
import chalk from 'chalk'

interface DashboardOptions {
    refresh?: number
}

export async function handleDashboard(options: DashboardOptions = {}) {
    const monitor = getTokenMonitor()
    const modelManager = getModelManager()
    const refreshInterval = options.refresh || 1000

    console.clear()
    console.log(chalk.blue.bold('\n╔══════════════════════════════════════════════════════════════════════════════╗'))
    console.log(chalk.blue.bold('║                     Claude Code Token Monitor Dashboard                      ║'))
    console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════════════════════╝\n'))
    console.log(chalk.gray('Press Ctrl+C to exit\n'))

    let lastStats = monitor.getStats()
    let animationFrame = 0
    const animationFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

    // Update function
    const update = () => {
        const stats = monitor.getStats()
        const modelStats = modelManager.getModelUsageStats()
        const topModels = monitor.getTopModels(3)
        const activeModel = modelManager.getActiveProfile()

        // Clear screen except first lines
        console.clear()
        console.log(chalk.blue.bold('\n╔══════════════════════════════════════════════════════════════════════════════╗'))
        console.log(chalk.blue.bold('║                     Claude Code Token Monitor Dashboard                      ║'))
        console.log(chalk.blue.bold('╚══════════════════════════════════════════════════════════════════════════════╝\n'))

        // Active model
        console.log(chalk.bold('┌─ ') + chalk.green('Active Model') + chalk.bold(' ─' + '─'.repeat(60) + '┐'))
        if (activeModel) {
            const cost = `$${activeModel.costPer1KInput}/1K in, $${activeModel.costPer1KOutput}/1K out`
            console.log(`│ ${chalk.cyan(activeModel.displayName || activeModel.name)} (${activeModel.modelId})`)
            console.log(`│ ${chalk.gray(cost)}`)
        } else {
            console.log(`│ ${chalk.yellow('No active model')}`)
        }
        console.log('└' + '─'.repeat(74) + '┘\n')

        // Current session stats
        console.log(chalk.bold('┌─ ') + chalk.green('Current Session') + chalk.bold(' ─' + '─'.repeat(58) + '┐'))
        const sessionDuration = (Date.now() - stats.sessionStartTime) / 1000
        const totalTokens = stats.totalInput + stats.totalOutput

        console.log(`│ ${chalk.bold('Total Tokens:')}   ${chalk.cyan(totalTokens.toLocaleString())}`)
        console.log(`│ ${chalk.bold('  Input:')}        ${chalk.cyan(stats.totalInput.toLocaleString())}`)
        console.log(`│ ${chalk.bold('  Output:')}       ${chalk.cyan(stats.totalOutput.toLocaleString())}`)
        console.log(`│ ${chalk.bold('Total Cost:')}    ${chalk.yellow('$' + stats.totalCost.toFixed(6))}`)
        console.log(`│ ${chalk.bold('Requests:')}      ${chalk.green(stats.requestCount)}`)
        console.log(`│ ${chalk.bold('Duration:')}      ${chalk.blue(sessionDuration.toFixed(1) + 's')}`)
        console.log('└' + '─'.repeat(74) + '┘\n')

        // Real-time rate
        console.log(chalk.bold('┌─ ') + chalk.green('Real-time Rate') + chalk.bold(' ─' + '─'.repeat(60) + '┐'))
        const rateAnimation = animationFrames[animationFrame % animationFrames.length]

        console.log(`│ ${chalk.bold('Tokens/sec:')}     ${chalk.magenta(stats.currentRate.tokensPerSecond.toFixed(2))} ${rateAnimation}`)
        console.log(`│ ${chalk.bold('Cost/sec:')}      ${chalk.magenta('$' + stats.currentRate.costPerSecond.toFixed(6))}`)

        // Rate bar visualization
        const barWidth = 60
        const maxRate = Math.max(stats.currentRate.tokensPerSecond, stats.averageRate.tokensPerSecond, 1)
        const currentBarLength = Math.min(barWidth, (stats.currentRate.tokensPerSecond / maxRate) * barWidth)
        const averageBarLength = Math.min(barWidth, (stats.averageRate.tokensPerSecond / maxRate) * barWidth)

        console.log(`│`)
        console.log(`│ ${chalk.bold('Current:')}  ${chalk.magenta('█'.repeat(Math.floor(currentBarLength)) + '░'.repeat(barWidth - Math.floor(currentBarLength)))}`)
        console.log(`│ ${chalk.bold('Average:')} ${chalk.blue('█'.repeat(Math.floor(averageBarLength)) + '░'.repeat(barWidth - Math.floor(averageBarLength)))}`)
        console.log('└' + '─'.repeat(74) + '┘\n')

        // Top models
        if (topModels.length > 0) {
            console.log(chalk.bold('┌─ ') + chalk.green('Top Models') + chalk.bold(' ─' + '─'.repeat(63) + '┐'))
            topModels.forEach((model, index) => {
                const rank = ['', '①', '②', '③'][index] || '④'
                console.log(`│ ${rank} ${chalk.cyan(model.model)} - ${chalk.green(model.requestCount)} req, ${chalk.yellow('$' + model.totalCost.toFixed(4))}`)
            })
            console.log('└' + '─'.repeat(74) + '┘\n')
        }

        // Recent activity
        const recent = monitor.getHistory(5)
        if (recent.length > 0) {
            console.log(chalk.bold('┌─ ') + chalk.green('Recent Usage') + chalk.bold(' ─' + '─'.repeat(62) + '┐'))
            recent.slice(-5).reverse().forEach(usage => {
                const time = new Date(usage.timestamp).toLocaleTimeString()
                const tokens = usage.inputTokens + usage.outputTokens
                const cost = '$' + usage.costUSD.toFixed(4)
                console.log(`│ ${chalk.gray(time)}  ${tokens.toLocaleString()} tokens  ${chalk.yellow(cost)}  ${chalk.cyan(usage.model || 'unknown')}`)
            })
            console.log('└' + '─'.repeat(74) + '┘\n')
        }

        // Footer
        const elapsed = Date.now() - lastStats.sessionStartTime
        console.log(chalk.gray(`Last updated: ${new Date().toLocaleTimeString()} | Session: ${(elapsed / 1000).toFixed(0)}s`))

        animationFrame++
        lastStats = stats
    }

    // Set up event listeners
    monitor.on('usage', update)

    // Initial display
    update()

    // Auto-refresh timer
    const timer = setInterval(update, refreshInterval)

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        clearInterval(timer)
        monitor.off('usage', update)
        console.clear()
        console.log(chalk.green('\n✓ Dashboard stopped\n'))
        process.exit(0)
    })
}

/**
 * Simple dashboard for terminal with limited capabilities
 */
export async function handleSimpleDashboard() {
    const monitor = getTokenMonitor()

    console.clear()
    console.log(chalk.blue('Claude Code Token Monitor\n'))

    let running = true

    const update = () => {
        if (!running) return

        const stats = monitor.getStats()

        process.stdout.write('\x1b[2J\x1b[H')
        console.log(chalk.blue('Claude Code Token Monitor\n'))

        const totalTokens = stats.totalInput + stats.totalOutput
        console.log(`Total Tokens:  ${chalk.cyan(totalTokens.toLocaleString())}`)
        console.log(`  Input:        ${chalk.cyan(stats.totalInput.toLocaleString())}`)
        console.log(`  Output:       ${chalk.cyan(stats.totalOutput.toLocaleString())}`)
        console.log(`Total Cost:    ${chalk.yellow('$' + stats.totalCost.toFixed(6))}`)
        console.log(`Requests:      ${chalk.green(stats.requestCount)}\n`)

        console.log(`Current Rate:  ${chalk.magenta(stats.currentRate.tokensPerSecond.toFixed(2) + ' tokens/sec')}`)
        console.log(`Average Rate:  ${chalk.blue(stats.averageRate.tokensPerSecond.toFixed(2) + ' tokens/sec')}\n`)

        const activeModel = getModelManager().getActiveProfile()
        if (activeModel) {
            console.log(`Active Model:  ${chalk.green(activeModel.displayName || activeModel.name)}`)
        }

        console.log(chalk.gray('\nPress Ctrl+C to exit'))
    }

    monitor.on('usage', update)
    update()

    const timer = setInterval(update, 2000)

    process.on('SIGINT', () => {
        running = false
        clearInterval(timer)
        monitor.off('usage', update)
        console.clear()
        console.log(chalk.green('\n✓ Stopped\n'))
        process.exit(0)
    })
}
