/**
 * Model Manager - Dynamic model configuration and switching
 * Manages multiple model profiles with cost and performance tracking
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { getTokenMonitor } from './tokenMonitor'

export interface ModelProfile {
    name: string
    displayName?: string
    provider: 'anthropic' | 'openai' | 'gemini' | 'custom'
    modelId: string
    fallbackModelId?: string
    costPer1KInput: number
    costPer1KOutput: number
    maxTokens?: number
    description?: string
    tags: string[]
    isActive: boolean
    createdAt: number
    updatedAt: number
}

export interface ModelUsageStats {
    modelId: string
    totalRequests: number
    totalInputTokens: number
    totalOutputTokens: number
    totalCost: number
    averageCostPerRequest: number
    lastUsed: number
}

export class ModelManager {
    private profiles: Map<string, ModelProfile> = new Map()
    private configFile: string
    private activeProfile: string | null = null

    constructor() {
        this.configFile = join(homedir(), '.happy', 'model-config.json')
        this.loadConfig()
        this.initializeDefaultProfiles()
    }

    /**
     * Load configuration from file
     */
    private loadConfig(): void {
        try {
            if (existsSync(this.configFile)) {
                const content = readFileSync(this.configFile, 'utf-8')
                const data = JSON.parse(content)
                this.profiles = new Map(Object.entries(data.profiles || {}))
                this.activeProfile = data.activeProfile || null
            }
        } catch (error) {
            console.error('Failed to load model configuration:', error)
        }
    }

    /**
     * Save configuration to file
     */
    private saveConfig(): void {
        try {
            const data = {
                profiles: Object.fromEntries(this.profiles),
                activeProfile: this.activeProfile
            }
            writeFileSync(this.configFile, JSON.stringify(data, null, 2))
        } catch (error) {
            console.error('Failed to save model configuration:', error)
        }
    }

    /**
     * Initialize default model profiles
     */
    private initializeDefaultProfiles(): void {
        const defaults: ModelProfile[] = [
            {
                name: 'claude-3-5-sonnet',
                displayName: 'Claude 3.5 Sonnet',
                provider: 'anthropic',
                modelId: 'claude-3-5-sonnet-20241022',
                fallbackModelId: 'claude-3-5-haiku-20241022',
                costPer1KInput: 0.003,
                costPer1KOutput: 0.015,
                maxTokens: 200000,
                description: 'Most intelligent model with enhanced reasoning',
                tags: ['reasoning', 'coding', 'analysis'],
                isActive: false,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            {
                name: 'claude-3-5-haiku',
                displayName: 'Claude 3.5 Haiku',
                provider: 'anthropic',
                modelId: 'claude-3-5-haiku-20241022',
                fallbackModelId: 'claude-3-5-sonnet-20241022',
                costPer1KInput: 0.001,
                costPer1KOutput: 0.005,
                maxTokens: 200000,
                description: 'Fast and efficient for everyday tasks',
                tags: ['fast', 'efficient'],
                isActive: false,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            {
                name: 'claude-3-opus',
                displayName: 'Claude 3 Opus',
                provider: 'anthropic',
                modelId: 'claude-3-opus-20240229',
                costPer1KInput: 0.015,
                costPer1KOutput: 0.075,
                maxTokens: 200000,
                description: 'Most powerful model for complex tasks',
                tags: ['powerful', 'complex'],
                isActive: false,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            {
                name: 'gpt-4o',
                displayName: 'GPT-4o',
                provider: 'openai',
                modelId: 'gpt-4o',
                costPer1KInput: 0.005,
                costPer1KOutput: 0.015,
                description: 'OpenAI GPT-4o model',
                tags: ['openai', 'multimodal'],
                isActive: false,
                createdAt: Date.now(),
                updatedAt: Date.now()
            },
            {
                name: 'gpt-4o-mini',
                displayName: 'GPT-4o Mini',
                provider: 'openai',
                modelId: 'gpt-4o-mini',
                costPer1KInput: 0.00015,
                costPer1KOutput: 0.0006,
                description: 'OpenAI GPT-4o Mini - cost effective',
                tags: ['openai', 'fast', 'cheap'],
                isActive: false,
                createdAt: Date.now(),
                updatedAt: Date.now()
            }
        ]

        let added = 0
        defaults.forEach(profile => {
            if (!this.profiles.has(profile.name)) {
                this.profiles.set(profile.name, profile)
                added++
            }
        })

        // Load models from APIs configuration file
        this.loadFromApisConfig()

        if (added > 0) {
            this.saveConfig()
        }

        // Set default active profile if none
        if (!this.activeProfile && this.profiles.size > 0) {
            this.activeProfile = 'claude-3-5-sonnet'
            this.saveConfig()
        }
    }

    /**
     * Load model profiles from APIs configuration file
     */
    private loadFromApisConfig(): void {
        try {
            // Check for APIs config file in project directory or home directory
            const possiblePaths = [
                '/Users/swmt/Documents/auto_claude_proxy/APIs',
                join(homedir(), '.happy', 'APIs'),
                join(process.cwd(), 'APIs')
            ]

            for (const path of possiblePaths) {
                if (existsSync(path)) {
                    try {
                        const content = readFileSync(path, 'utf-8')
                        // Parse all JSON blocks in the file
                        const jsonMatches = content.match(/\{[\s\S]*?\n\}/g)
                        if (jsonMatches) {
                            for (const jsonStr of jsonMatches) {
                                try {
                                    const config = JSON.parse(jsonStr)
                                    if (config && config.env) {
                                        const env = config.env

                                        // Add MiniMax model
                                        if (env.ANTHROPIC_BASE_URL?.includes('minimaxi.com') && env.ANTHROPIC_MODEL) {
                                            this.profiles.set('MiniMax', {
                                                name: 'MiniMax',
                                                displayName: 'MiniMax',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'MiniMax model via API',
                                                tags: ['minimax', 'custom'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })

                                            // Also add "MM" as an alias for MiniMax
                                            this.profiles.set('MM', {
                                                name: 'MM',
                                                displayName: 'MM (MiniMax)',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'MiniMax model via API (alias: MM)',
                                                tags: ['minimax', 'custom', 'alias'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })
                                        }

                                        // Add GLM model
                                        if (env.ANTHROPIC_BASE_URL?.includes('bigmodel.cn') && env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
                                            this.profiles.set('GLM', {
                                                name: 'GLM',
                                                displayName: 'GLM',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'GLM model via API',
                                                tags: ['glm', 'custom'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })

                                            // Also add lowercase alias
                                            this.profiles.set('glm', {
                                                name: 'glm',
                                                displayName: 'glm (GLM)',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_DEFAULT_SONNET_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'GLM model via API (alias: glm)',
                                                tags: ['glm', 'custom', 'alias'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })
                                        }

                                        // Add Kimi model
                                        if (env.ANTHROPIC_BASE_URL?.includes('moonshot.cn') && env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
                                            this.profiles.set('Kimi', {
                                                name: 'Kimi',
                                                displayName: 'Kimi',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'Kimi model via API',
                                                tags: ['kimi', 'custom'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })

                                            // Also add uppercase "KIMI" and lowercase "kimi" aliases
                                            this.profiles.set('KIMI', {
                                                name: 'KIMI',
                                                displayName: 'KIMI (Kimi)',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'Kimi model via API (alias: KIMI)',
                                                tags: ['kimi', 'custom', 'alias'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })

                                            this.profiles.set('kimi', {
                                                name: 'kimi',
                                                displayName: 'kimi (Kimi)',
                                                provider: 'custom',
                                                modelId: env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
                                                costPer1KInput: 0.001,
                                                costPer1KOutput: 0.001,
                                                description: 'Kimi model via API (alias: kimi)',
                                                tags: ['kimi', 'custom', 'alias'],
                                                isActive: false,
                                                createdAt: Date.now(),
                                                updatedAt: Date.now()
                                            })
                                        }
                                    }
                                } catch (e) {
                                    // Skip invalid JSON blocks
                                }
                            }
                        }
                    } catch (e) {
                        // Try next path
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load APIs configuration:', error)
        }
    }

    /**
     * Get all profiles
     */
    getAllProfiles(): ModelProfile[] {
        return Array.from(this.profiles.values())
    }

    /**
     * Get active profile
     */
    getActiveProfile(): ModelProfile | null {
        if (!this.activeProfile) return null
        return this.profiles.get(this.activeProfile) || null
    }

    /**
     * Get profile by name
     */
    getProfile(name: string): ModelProfile | null {
        return this.profiles.get(name) || null
    }

    /**
     * Add or update a profile
     */
    upsertProfile(profile: Omit<ModelProfile, 'createdAt' | 'updatedAt'> & Partial<Pick<ModelProfile, 'createdAt' | 'updatedAt'>>): ModelProfile {
        const existing = this.profiles.get(profile.name)
        const updated: ModelProfile = {
            ...profile,
            createdAt: existing?.createdAt || Date.now(),
            updatedAt: Date.now()
        }

        this.profiles.set(profile.name, updated)
        this.saveConfig()
        return updated
    }

    /**
     * Remove a profile
     */
    removeProfile(name: string): boolean {
        const wasActive = this.activeProfile === name
        const removed = this.profiles.delete(name)

        if (removed) {
            if (wasActive) {
                this.activeProfile = this.profiles.size > 0
                    ? Array.from(this.profiles.keys())[0]
                    : null
            }
            this.saveConfig()
        }

        return removed
    }

    /**
     * Switch active model
     */
    switchModel(name: string): boolean {
        if (!this.profiles.has(name)) {
            return false
        }

        // Deactivate all profiles
        this.profiles.forEach(profile => {
            profile.isActive = false
        })

        // Activate selected profile
        const profile = this.profiles.get(name)!
        profile.isActive = true
        this.activeProfile = name
        profile.updatedAt = Date.now()

        this.saveConfig()
        return true
    }

    /**
     * Get model usage statistics
     */
    getModelUsageStats(name?: string): ModelUsageStats[] {
        const monitor = getTokenMonitor()
        const history = monitor.getHistory()

        const statsMap = new Map<string, ModelUsageStats>()

        history.forEach(usage => {
            const modelId = name || usage.model || 'unknown'
            const existing = statsMap.get(modelId) || {
                modelId,
                totalRequests: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                totalCost: 0,
                averageCostPerRequest: 0,
                lastUsed: 0
            }

            existing.totalRequests++
            existing.totalInputTokens += usage.inputTokens
            existing.totalOutputTokens += usage.outputTokens
            existing.totalCost += usage.costUSD
            existing.lastUsed = Math.max(existing.lastUsed, usage.timestamp)

            statsMap.set(modelId, existing)
        })

        return Array.from(statsMap.values()).map(stats => ({
            ...stats,
            averageCostPerRequest: stats.totalCost / stats.totalRequests
        }))
    }

    /**
     * Find best model by criteria
     */
    findBestModel(criteria: {
        maxCost?: number
        minSpeed?: number
        maxTokens?: number
        tags?: string[]
    }): ModelProfile | null {
        const candidates = this.profiles.values()
        const filtered = Array.from(candidates).filter(profile => {
            if (criteria.maxCost && profile.costPer1KOutput > criteria.maxCost) {
                return false
            }
            if (criteria.maxTokens && profile.maxTokens && profile.maxTokens < criteria.maxTokens) {
                return false
            }
            if (criteria.tags && criteria.tags.length > 0) {
                const hasTag = criteria.tags.some(tag => profile.tags.includes(tag))
                if (!hasTag) return false
            }
            return true
        })

        if (filtered.length === 0) return null

        // Sort by cost efficiency
        filtered.sort((a, b) => (a.costPer1KInput + a.costPer1KOutput) - (b.costPer1KInput + b.costPer1KOutput))

        return filtered[0]
    }

    /**
     * Auto-switch based on usage
     */
    autoSwitch(usagePattern: 'expensive' | 'cheap' | 'balanced'): boolean {
        let targetProfile: string | null = null

        switch (usagePattern) {
            case 'expensive':
                // Switch to cheaper model if current usage is high
                targetProfile = 'claude-3-5-haiku'
                break
            case 'cheap':
                // Switch to more capable model if usage is low
                targetProfile = 'claude-3-5-sonnet'
                break
            case 'balanced':
                // Keep current model or switch based on cost
                const stats = this.getModelUsageStats()
                const totalCost = stats.reduce((sum, s) => sum + s.totalCost, 0)
                if (totalCost > 10) {
                    targetProfile = 'claude-3-5-haiku'
                } else if (totalCost < 1) {
                    targetProfile = 'claude-3-5-sonnet'
                }
                break
        }

        if (targetProfile && this.profiles.has(targetProfile)) {
            return this.switchModel(targetProfile)
        }

        return false
    }

    /**
     * Export configuration
     */
    exportConfig(): string {
        return JSON.stringify({
            profiles: Object.fromEntries(this.profiles),
            activeProfile: this.activeProfile,
            exportedAt: Date.now()
        }, null, 2)
    }

    /**
     * Import configuration
     */
    importConfig(configJson: string): boolean {
        try {
            const data = JSON.parse(configJson)
            if (data.profiles) {
                this.profiles = new Map(Object.entries(data.profiles))
                this.activeProfile = data.activeProfile || null
                this.saveConfig()
                return true
            }
            return false
        } catch (error) {
            console.error('Failed to import configuration:', error)
            return false
        }
    }

    /**
     * Get model recommendations
     */
    getRecommendations(currentUsage?: {
        avgInputTokens: number
        avgOutputTokens: number
        avgCost: number
    }): Array<{ profile: ModelProfile; reason: string; score: number }> {
        const recommendations: Array<{ profile: ModelProfile; reason: string; score: number }> = []

        this.profiles.forEach(profile => {
            let score = 0
            let reason = ''

            // Cost efficiency score
            if (currentUsage) {
                const estimatedCost =
                    (currentUsage.avgInputTokens * profile.costPer1KInput +
                     currentUsage.avgOutputTokens * profile.costPer1KOutput) / 1000

                if (estimatedCost < currentUsage.avgCost) {
                    score += 10
                    reason += 'More cost-efficient. '
                }
            }

            // Speed score (Haiku is faster)
            if (profile.tags.includes('fast')) {
                score += 5
                reason += 'Faster response. '
            }

            // Capability score (Sonnet is more capable)
            if (profile.tags.includes('reasoning')) {
                score += 8
                reason += 'Better reasoning. '
            }

            if (score > 0) {
                recommendations.push({ profile, reason: reason.trim(), score })
            }
        })

        return recommendations.sort((a, b) => b.score - a.score)
    }
}

// Global instance
let globalModelManager: ModelManager | null = null

export function getModelManager(): ModelManager {
    if (!globalModelManager) {
        globalModelManager = new ModelManager()
    }
    return globalModelManager
}
