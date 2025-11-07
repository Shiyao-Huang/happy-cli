/**
 * Token Stats Command - Display real-time token usage statistics
 */

import { getTokenMonitor } from '@/claude/sdk/tokenMonitor'
import { getModelManager } from '@/claude/sdk/modelManager'
import chalk from 'chalk'

interface TokenStatsOptions {
    realTime?: boolean
    interval?: number
    format?: 'table' | 'json' | 'compact'
    model?: string
    history?: number
}

export async function handleTokenStats(options: TokenStatsOptions = {}) {
    const monitor = getTokenMonitor()
    const modelManager = getModelManager()

    const displayStats = () => {
        const stats = options.model
            ? monitor.getUsageByModel(options.model)
            : monitor.getStats()

        if (options.format === 'json') {
            console.log(JSON.stringify(stats, null, 2))
            return
        }

        if (options.format === 'compact') {
            const { totalInput, totalOutput, totalCost, currentRate, requestCount } = stats
            console.log(
                `Input: ${chalk.cyan(totalInput.toLocaleString())} | ` +
                `Output: ${chalk.cyan(totalOutput.toLocaleString())} | ` +
                `Cost: ${chalk.yellow('$' + totalCost.toFixed(4))} | ` +
                `Rate: ${chalk.magenta(currentRate.tokensPerSecond.toFixed(1) + ' t/s')} | ` +
                `Requests: ${chalk.green(requestCount)}`
            )
            return
        }

        // Table format (default)
        console.log('\n' + '='.repeat(80))
        console.log(chalk.bold('Token Usage Statistics'))
        console.log('='.repeat(80) + '\n')

        if ('totalInput' in stats) {
            // Full session stats
            const { totalInput, totalOutput, totalCost, currentRate, averageRate, requestCount } = stats
            const sessionDuration = (Date.now() - stats.sessionStartTime) / 1000

            console.log(chalk.bold('Total Usage:'))
            console.log(`  Input Tokens:    ${chalk.cyan(totalInput.toLocaleString())}`)
            console.log(`  Output Tokens:   ${chalk.cyan(totalOutput.toLocaleString())}`)
            console.log(`  Total Tokens:    ${chalk.cyan((totalInput + totalOutput).toLocaleString())}`)
            console.log(`  Total Cost:      ${chalk.yellow('$' + totalCost.toFixed(6))}`)
            console.log(`  Requests:        ${chalk.green(requestCount)}`)
            console.log(`  Session Duration: ${chalk.blue(sessionDuration.toFixed(1) + 's')}\n`)

            console.log(chalk.bold('Current Rate (1 min window):'))
            console.log(`  Tokens/sec:      ${chalk.magenta(currentRate.tokensPerSecond.toFixed(2))}`)
            console.log(`  Cost/sec:        ${chalk.magenta('$' + currentRate.costPerSecond.toFixed(6))}\n`)

            console.log(chalk.bold('Average Rate (session):'))
            console.log(`  Tokens/sec:      ${chalk.magenta(averageRate.tokensPerSecond.toFixed(2))}`)
            console.log(`  Cost/sec:        ${chalk.magenta('$' + averageRate.costPerSecond.toFixed(6))}\n`)
        } else {
            // Model-specific stats
            const modelStats = stats as any
            console.log(chalk.bold('Model: ') + chalk.cyan(options.model || 'All'))
            console.log(`  Input Tokens:    ${chalk.cyan(modelStats.totalInput.toLocaleString())}`)
            console.log(`  Output Tokens:   ${chalk.cyan(modelStats.totalOutput.toLocaleString())}`)
            console.log(`  Total Cost:      ${chalk.yellow('$' + modelStats.totalCost.toFixed(6))}`)
            console.log(`  Requests:        ${chalk.green(modelStats.requestCount)}\n`)
        }
    }

    // Display model usage breakdown
    const modelStats = modelManager.getModelUsageStats()
    if (modelStats.length > 0 && options.format !== 'compact') {
        console.log(chalk.bold('Model Breakdown:'))
        console.log('-'.repeat(80))
        modelStats.forEach(stat => {
            const avgCost = stat.totalCost / stat.totalRequests
            console.log(
                `${chalk.cyan(stat.modelId)}: ` +
                `${stat.totalRequests} req, ` +
                `${stat.totalInputTokens + stat.totalOutputTokens} tokens, ` +
                `${chalk.yellow('$' + stat.totalCost.toFixed(4))} ` +
                `(avg: ${chalk.gray('$' + avgCost.toFixed(4))})`
            )
        })
        console.log('')
    }

    // Show top models if no specific model filter
    if (!options.model && modelStats.length > 0 && options.format !== 'compact') {
        const topModels = monitor.getTopModels(5)
        console.log(chalk.bold('Top Models by Usage:'))
        console.log('-'.repeat(80))
        topModels.forEach((model, index) => {
            console.log(
                `${index + 1}. ${chalk.cyan(model.model)}: ` +
                `${chalk.green(model.requestCount)} req, ` +
                `${chalk.cyan(model.totalTokens.toLocaleString())} tokens, ` +
                `${chalk.yellow('$' + model.totalCost.toFixed(4))}`
            )
        })
        console.log('')
    }

    // Display current active model
    const activeProfile = modelManager.getActiveProfile()
    if (activeProfile && options.format !== 'compact') {
        console.log(chalk.bold('Active Model:'))
        console.log(`  ${chalk.green(activeProfile.displayName || activeProfile.name)}`)
        console.log(`  ID: ${activeProfile.modelId}`)
        console.log(`  Provider: ${activeProfile.provider}`)
        console.log(`  Cost: $${activeProfile.costPer1KInput}/1K input, $${activeProfile.costPer1KOutput}/1K output\n`)
    }

    displayStats()
}

/**
 * Watch mode - continuously update stats
 */
export async function handleTokenWatch(options: TokenStatsOptions = {}) {
    const monitor = getTokenMonitor()
    const interval = options.interval || 2000

    console.clear()
    console.log(chalk.blue('Watching token usage... (Press Ctrl+C to stop)\n'))

    // Set up event listener
    const updateHandler = () => {
        console.clear()
        console.log(chalk.blue('Watching token usage... (Press Ctrl+C to stop)\n'))
        handleTokenStats({ ...options, format: 'compact' })
    }

    monitor.on('usage', updateHandler)

    // Initial display
    updateHandler()

    // Also update periodically
    const intervalId = setInterval(updateHandler, interval)

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        clearInterval(intervalId)
        monitor.off('usage', updateHandler)
        console.log('\n\nStopped watching.')
        process.exit(0)
    })
}
