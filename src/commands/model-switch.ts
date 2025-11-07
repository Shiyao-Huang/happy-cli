/**
 * Model Switch Command - Manage and switch between model configurations
 */

import { getModelManager, type ModelProfile } from '@/claude/sdk/modelManager'
import chalk from 'chalk'

interface ModelSwitchOptions {
    list?: boolean
    set?: string
    add?: string
    remove?: string
    update?: string
    auto?: 'expensive' | 'cheap' | 'balanced'
    export?: string
    import?: string
    format?: 'table' | 'json'
    tags?: string[]
    cost?: string // format: "input:output" e.g. "0.003:0.015"
}

export async function handleModelSwitch(options: ModelSwitchOptions) {
    const modelManager = getModelManager()

    // List models
    if (options.list) {
        await listModels(modelManager, options.format)
        return
    }

    // Add new model
    if (options.add) {
        await addModel(modelManager, options.add, options)
        return
    }

    // Remove model
    if (options.remove) {
        await removeModel(modelManager, options.remove)
        return
    }

    // Update model
    if (options.update) {
        await updateModel(modelManager, options.update, options)
        return
    }

    // Switch to model
    if (options.set) {
        await switchModel(modelManager, options.set)
        return
    }

    // Auto switch
    if (options.auto) {
        await autoSwitch(modelManager, options.auto)
        return
    }

    // Export configuration
    if (options.export) {
        await exportConfig(modelManager, options.export)
        return
    }

    // Import configuration
    if (options.import) {
        await importConfig(modelManager, options.import)
        return
    }

    // Default: show current active model
    showActiveModel(modelManager)
}

async function listModels(modelManager: any, format?: string) {
    const profiles = modelManager.getAllProfiles()
    const activeProfile = modelManager.getActiveProfile()

    if (format === 'json') {
        console.log(JSON.stringify(profiles, null, 2))
        return
    }

    console.log('\n' + '='.repeat(100))
    console.log(chalk.bold('Model Configurations'))
    console.log('='.repeat(100) + '\n')

    profiles.forEach((profile: ModelProfile) => {
        const isActive = activeProfile?.name === profile.name
        const status = isActive ? chalk.green('● ACTIVE') : chalk.gray('○')

        console.log(`${status} ${chalk.bold(profile.displayName || profile.name)}`)
        console.log(`   Model ID: ${chalk.cyan(profile.modelId)}`)
        console.log(`   Provider: ${chalk.blue(profile.provider)}`)
        console.log(`   Cost: $${profile.costPer1KInput}/1K input, $${profile.costPer1KOutput}/1K output`)

        if (profile.maxTokens) {
            console.log(`   Max Tokens: ${profile.maxTokens.toLocaleString()}`)
        }

        if (profile.tags.length > 0) {
            console.log(`   Tags: ${profile.tags.map((t: string) => chalk.magenta(t)).join(', ')}`)
        }

        if (profile.description) {
            console.log(`   ${chalk.gray(profile.description)}`)
        }

        console.log('')
    })

    console.log(chalk.green(`Total: ${profiles.length} model(s)`))
    console.log('')
}

async function addModel(modelManager: any, name: string, options: ModelSwitchOptions) {
    // Get model usage stats for recommendations
    const stats = modelManager.getModelUsageStats()
    const avgUsage = stats.length > 0
        ? {
            avgInputTokens: stats.reduce((s: any, st: any) => s + st.totalInputTokens, 0) / stats.length,
            avgOutputTokens: stats.reduce((s: any, st: any) => s + st.totalOutputTokens, 0) / stats.length,
            avgCost: stats.reduce((s: any, st: any) => s + st.totalCost, 0) / stats.length
        }
        : undefined

    const recommendations = modelManager.getRecommendations(avgUsage)

    if (recommendations.length > 0) {
        console.log(chalk.blue('Model recommendations based on your usage:'))
        console.log('')
        recommendations.slice(0, 3).forEach((rec: any) => {
            console.log(`  ${chalk.cyan(rec.profile.name)}: ${chalk.green(rec.reason)}`)
        })
        console.log('')
    }

    // Parse cost if provided
    let costPer1KInput = 0.003
    let costPer1KOutput = 0.015
    if (options.cost) {
        const [input, output] = options.cost.split(':').map(Number)
        if (!isNaN(input) && !isNaN(output)) {
            costPer1KInput = input
            costPer1KOutput = output
        } else {
            console.error(chalk.red('Invalid cost format. Use "input:output" (e.g., "0.003:0.015")'))
            process.exit(1)
        }
    }

    // Prompt for required fields
    const modelId = name // In a real implementation, would prompt user
    const provider = 'custom' // Would prompt user

    if (!modelId) {
        console.error(chalk.red('Model ID is required'))
        process.exit(1)
    }

    const profile: Omit<ModelProfile, 'createdAt' | 'updatedAt'> = {
        name,
        displayName: name,
        provider: provider as any,
        modelId,
        costPer1KInput,
        costPer1KOutput,
        tags: options.tags || [],
        isActive: false
    }

    modelManager.upsertProfile(profile)
    console.log(chalk.green(`✓ Model "${name}" added successfully`))
}

async function removeModel(modelManager: any, name: string) {
    const profile = modelManager.getProfile(name)
    if (!profile) {
        console.error(chalk.red(`Model "${name}" not found`))
        process.exit(1)
    }

    const activeProfile = modelManager.getActiveProfile()
    if (activeProfile?.name === name) {
        console.error(chalk.red('Cannot remove active model. Switch to another model first.'))
        process.exit(1)
    }

    modelManager.removeProfile(name)
    console.log(chalk.green(`✓ Model "${name}" removed successfully`))
}

async function updateModel(modelManager: any, name: string, options: ModelSwitchOptions) {
    const profile = modelManager.getProfile(name)
    if (!profile) {
        console.error(chalk.red(`Model "${name}" not found`))
        process.exit(1)
    }

    const updated: Partial<ModelProfile> = {}

    if (options.cost) {
        const [input, output] = options.cost.split(':').map(Number)
        if (!isNaN(input) && !isNaN(output)) {
            updated.costPer1KInput = input
            updated.costPer1KOutput = output
        } else {
            console.error(chalk.red('Invalid cost format. Use "input:output"'))
            process.exit(1)
        }
    }

    if (options.tags) {
        updated.tags = options.tags
    }

    modelManager.upsertProfile({ ...profile, ...updated, name: profile.name })
    console.log(chalk.green(`✓ Model "${name}" updated successfully`))
}

async function switchModel(modelManager: any, name: string) {
    const profile = modelManager.getProfile(name)
    if (!profile) {
        console.error(chalk.red(`Model "${name}" not found`))
        process.exit(1)
    }

    const success = modelManager.switchModel(name)
    if (success) {
        console.log(chalk.green(`✓ Switched to model "${profile.displayName || name}"`))
        console.log(`   Model ID: ${chalk.cyan(profile.modelId)}`)
        console.log(`   Cost: $${profile.costPer1KInput}/1K input, $${profile.costPer1KOutput}/1K output`)
    } else {
        console.error(chalk.red('Failed to switch model'))
        process.exit(1)
    }
}

async function autoSwitch(modelManager: any, pattern: 'expensive' | 'cheap' | 'balanced') {
    const success = modelManager.autoSwitch(pattern)
    if (success) {
        const active = modelManager.getActiveProfile()
        console.log(chalk.green(`✓ Auto-switched to "${active?.displayName || active?.name}" based on ${pattern} usage pattern`))
    } else {
        console.error(chalk.red('Auto-switch failed'))
        process.exit(1)
    }
}

async function exportConfig(modelManager: any, filePath: string) {
    const config = modelManager.exportConfig()

    const { writeFileSync } = require('node:fs')
    try {
        writeFileSync(filePath, config)
        console.log(chalk.green(`✓ Configuration exported to ${filePath}`))
    } catch (error) {
        console.error(chalk.red('Failed to export configuration:'), error)
        process.exit(1)
    }
}

async function importConfig(modelManager: any, filePath: string) {
    const { readFileSync } = require('node:fs')
    try {
        const config = readFileSync(filePath, 'utf-8')
        const success = modelManager.importConfig(config)
        if (success) {
            console.log(chalk.green(`✓ Configuration imported from ${filePath}`))
        } else {
            console.error(chalk.red('Invalid configuration file'))
            process.exit(1)
        }
    } catch (error) {
        console.error(chalk.red('Failed to import configuration:'), error)
        process.exit(1)
    }
}

function showActiveModel(modelManager: any) {
    const active = modelManager.getActiveProfile()
    if (!active) {
        console.log(chalk.yellow('No active model configured'))
        return
    }

    console.log(chalk.bold('\nActive Model:'))
    console.log(`  ${chalk.green(active.displayName || active.name)}`)
    console.log(`  ID: ${chalk.cyan(active.modelId)}`)
    console.log(`  Provider: ${chalk.blue(active.provider)}`)
    console.log(`  Cost: $${active.costPer1KInput}/1K input, $${active.costPer1KOutput}/1K output`)

    if (active.tags.length > 0) {
        console.log(`  Tags: ${active.tags.map((t: string) => chalk.magenta(t)).join(', ')}`)
    }
    console.log('')
}
