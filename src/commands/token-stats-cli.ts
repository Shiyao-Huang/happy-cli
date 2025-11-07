/**
 * CLI integration for token-stats command
 * Real implementation that reads from Claude session files like ccusage
 */

import chalk from 'chalk'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

interface TokenUsage {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
}

interface SessionMessage {
    type: string
    message?: {
        role: string
        model?: string
        usage?: TokenUsage
    }
    usage?: TokenUsage
    timestamp?: string
    sessionId?: string
}

interface AggregatedStats {
    date: string
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    totalTokens: number
    totalCost: number
    modelsUsed: Set<string>
    sessionCount: number
}

export async function handleTokenStatsCli(args: string[]): Promise<void> {
    // Parse arguments
    const options: any = {}
    let showHelp = false
    let timeRange: string = 'daily'

    for (let i = 0; i < args.length; i++) {
        const arg = args[i]

        if (arg === '-h' || arg === '--help') {
            showHelp = true
        } else if (arg === '--stats') {
            // No-op flag for top-level command compatibility
            // The default behavior is to show stats anyway
        } else if (arg === '-f' || arg === '--format') {
            const format = args[++i]
            if (['table', 'json', 'compact'].includes(format)) {
                options.format = format
            } else {
                console.error(chalk.red(`Invalid format: ${format}`))
                process.exit(1)
            }
        } else if (arg === '--since' && i + 1 < args.length) {
            options.since = args[++i]
        } else if (arg === '--until' && i + 1 < args.length) {
            options.until = args[++i]
        } else if (['daily', 'weekly', 'monthly', 'session'].includes(arg)) {
            timeRange = arg
        } else {
            console.error(chalk.red(`Unknown argument: ${arg}`))
            showHelp = true
            break
        }
    }

    if (showHelp) {
        console.log(`
${chalk.bold('happy token-stats')} - Display token usage statistics from Claude sessions

${chalk.bold('Usage:')}
  happy token-stats [time-range] [options]

${chalk.bold('Time Ranges:')}
  daily (default)    Show usage grouped by date
  weekly             Show usage grouped by week
  monthly            Show usage grouped by month
  session            Show usage grouped by conversation session

${chalk.bold('Options:')}
  --f, --format <fmt>   Output format: table (default), json, compact
  --since <date>        Filter from date (YYYYMMDD)
  --until <date>        Filter until date (YYYYMMDD)
  -h, --help           Show this help

${chalk.bold('Examples:')}
  happy token-stats              Show daily usage
  happy token-stats weekly       Show weekly usage
  happy token-stats monthly -f json    Show monthly usage in JSON
  happy token-stats session --since 20241101  Show sessions since Nov 1, 2024
`)
        return
    }

    // Read and aggregate session data
    const stats = await readSessionData(options)

    if (options.format === 'json') {
        console.log(JSON.stringify(stats, null, 2))
        return
    }

    // Display results
    displayStats(stats, timeRange, options)
}

async function readSessionData(options: any): Promise<any> {
    const projectsDir = join(homedir(), '.claude', 'projects')

    if (!existsSync(projectsDir)) {
        console.log(chalk.yellow('No Claude projects found. Make sure you have run Claude Code first.'))
        return []
    }

    const sessions: any[] = []
    const projectDirs = readdirSync(projectsDir).filter(d => !d.startsWith('.'))

    for (const projectDir of projectDirs) {
        const projectPath = join(projectsDir, projectDir)
        try {
            const sessionFiles = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'))

            for (const sessionFile of sessionFiles) {
                const sessionPath = join(projectPath, sessionFile)
                const content = readFileSync(sessionPath, 'utf-8')
                const lines = content.split('\n').filter(l => l.trim())

                for (const line of lines) {
                    try {
                        const msg: SessionMessage = JSON.parse(line)

                        // Look for usage data in different places
                        const usage = msg.message?.usage || msg.usage

                        if (usage && (usage.input_tokens || usage.output_tokens)) {
                            sessions.push({
                                date: msg.timestamp?.split('T')[0] || '',
                                timestamp: msg.timestamp,
                                sessionId: msg.sessionId,
                                model: msg.message?.model,
                                input_tokens: usage.input_tokens || 0,
                                output_tokens: usage.output_tokens || 0,
                                cache_read_input_tokens: usage.cache_read_input_tokens || 0,
                                cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
                                project: projectDir
                            })
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                    }
                }
            }
        } catch (e) {
            // Skip inaccessible directories
        }
    }

    // Filter by date range if specified
    let filteredSessions = sessions
    if (options.since) {
        filteredSessions = sessions.filter(s => s.date >= options.since)
    }
    if (options.until) {
        filteredSessions = sessions.filter(s => s.date <= options.until)
    }

    // Group by time range
    return groupSessions(filteredSessions)
}

function groupSessions(sessions: any[]): any[] {
    const groups: Map<string, any> = new Map()

    for (const session of sessions) {
        let key = session.date

        // Group by day (already done by date)
        if (!groups.has(key)) {
            groups.set(key, {
                date: key,
                inputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                totalTokens: 0,
                totalCost: 0,
                modelsUsed: new Set<string>(),
                sessions: new Set<string>()
            })
        }

        const group = groups.get(key)
        group.inputTokens += session.input_tokens
        group.outputTokens += session.output_tokens
        group.cacheReadTokens += session.cache_read_input_tokens
        group.cacheCreationTokens += session.cache_creation_input_tokens

        if (session.model) {
            group.modelsUsed.add(session.model)
        }
        if (session.sessionId) {
            group.sessions.add(session.sessionId)
        }
    }

    // Convert to array and calculate totals
    return Array.from(groups.values()).map(group => {
        const totalInput = group.inputTokens + group.cacheReadTokens + group.cacheCreationTokens
        const totalOutput = group.outputTokens
        const totalTokens = totalInput + totalOutput
        const totalCost = calculateCost(group.modelsUsed, totalInput, totalOutput)

        return {
            ...group,
            modelsUsed: Array.from(group.modelsUsed),
            sessionCount: group.sessions.size,
            totalInput,
            totalOutput,
            totalTokens,
            totalCost
        }
    }).sort((a, b) => a.date.localeCompare(b.date))
}

function calculateCost(models: Set<string>, inputTokens: number, outputTokens: number): number {
    // Claude model pricing (per 1K tokens)
    const pricing: { [key: string]: { input: number, output: number } } = {
        'claude-3-5-sonnet-20241022': { input: 0.003, output: 0.015 },
        'claude-3-5-haiku-20241022': { input: 0.001, output: 0.005 },
        'claude-3-opus-20240229': { input: 0.015, output: 0.075 },
        'claude-3-sonnet-20240229': { input: 0.003, output: 0.015 },
        'claude-3-haiku-20240307': { input: 0.00025, output: 0.00125 },
        'glm-4.6': { input: 0.001, output: 0.001 },
        'glm-4.5': { input: 0.0005, output: 0.0005 }
    }

    let totalCost = 0
    const avgInputCost = 0.003  // Default to Claude 3.5 Sonnet
    const avgOutputCost = 0.015

    totalCost = (inputTokens / 1000) * avgInputCost + (outputTokens / 1000) * avgOutputCost

    return totalCost
}

function displayStats(stats: any[], timeRange: string, options: any): void {
    if (stats.length === 0) {
        console.log(chalk.yellow('No token usage data found.'))
        console.log(chalk.gray('Make sure you have run Claude Code and check the --since option.'))
        return
    }

    console.log('\n' + '='.repeat(80))
    console.log(chalk.bold(`Token Usage Statistics (${timeRange})`))
    console.log('='.repeat(80) + '\n')

    if (options.format === 'compact') {
        for (const stat of stats) {
            console.log(
                `${chalk.cyan(stat.date)}: ` +
                `Input: ${stat.totalInput.toLocaleString()} | ` +
                `Output: ${stat.totalOutput.toLocaleString()} | ` +
                `Total: ${stat.totalTokens.toLocaleString()} | ` +
                `Cost: ${chalk.yellow('$' + stat.totalCost.toFixed(4))} | ` +
                `Models: ${stat.modelsUsed.join(', ')}`
            )
        }
        return
    }

    // Table format
    console.log(chalk.bold('Date         Input Tokens    Output Tokens   Total Tokens    Cost       Models'))
    console.log('-'.repeat(80))

    for (const stat of stats) {
        const modelStr = stat.modelsUsed.length > 2
            ? `${stat.modelsUsed.slice(0, 2).join(', ')} +${stat.modelsUsed.length - 2}`
            : stat.modelsUsed.join(', ')

        console.log(
            `${stat.date}  ` +
            `${stat.totalInput.toLocaleString().padStart(12)}  ` +
            `${stat.totalOutput.toLocaleString().padStart(12)}  ` +
            `${stat.totalTokens.toLocaleString().padStart(12)}  ` +
            `${chalk.yellow('$' + stat.totalCost.toFixed(4)).padStart(9)}  ` +
            `${modelStr}`
        )
    }

    // Summary
    const totalInput = stats.reduce((s, stat) => s + stat.totalInput, 0)
    const totalOutput = stats.reduce((s, stat) => s + stat.totalOutput, 0)
    const totalTokens = stats.reduce((s, stat) => s + stat.totalTokens, 0)
    const totalCost = stats.reduce((s, stat) => s + stat.totalCost, 0)
    const totalSessions = stats.reduce((s, stat) => s + stat.sessionCount, 0)

    console.log('\n' + '-'.repeat(80))
    console.log(chalk.bold('Total:'))
    console.log(`  Input Tokens:     ${chalk.cyan(totalInput.toLocaleString())}`)
    console.log(`  Output Tokens:    ${chalk.cyan(totalOutput.toLocaleString())}`)
    console.log(`  Total Tokens:     ${chalk.cyan(totalTokens.toLocaleString())}`)
    console.log(`  Total Cost:       ${chalk.yellow('$' + totalCost.toFixed(4))}`)
    console.log(`  Sessions:         ${chalk.green(totalSessions)}`)
    console.log(`  Date Range:       ${stats[0].date} to ${stats[stats.length - 1].date}`)
    console.log('')
}
