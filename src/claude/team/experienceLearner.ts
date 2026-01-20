/**
 * Experience Learner Module
 *
 * Stores and retrieves execution experiences for learning and improvement.
 * This module provides:
 * - Experience recording (successes and failures)
 * - Pattern matching for similar tasks
 * - Recommendation generation based on past experiences
 * - Learning metrics and insights
 *
 * Enables "举一反三" (learning from one example to apply to many)
 */

import { randomUUID } from 'crypto';
import { logger } from '@/ui/logger';
import { KanbanTaskSummary } from './roles';

// === Types ===

export type ExperienceOutcome = 'success' | 'failure' | 'partial' | 'abandoned';

export interface Experience {
    id: string;
    taskType: string;
    taskTitle: string;
    approach: string;
    outcome: ExperienceOutcome;
    duration: number;  // milliseconds
    details: {
        stepsExecuted: string[];
        toolsUsed: string[];
        blockersFaced: string[];
        resolution?: string;
    };
    context: {
        roleId: string;
        teamId?: string;
        relatedTasks?: string[];
        codebaseContext?: string;
    };
    learnings: string[];
    timestamp: number;
    confidence: number;  // 0-1 confidence in the experience being relevant
}

export interface ExecutionOutcome {
    success: boolean;
    stepsExecuted: string[];
    toolsUsed: string[];
    blockersFaced: string[];
    resolution?: string;
    duration: number;
}

export interface ExecutionError {
    type: 'technical' | 'logic' | 'timeout' | 'dependency' | 'unknown';
    message: string;
    stackTrace?: string;
    recoveryAttempts: string[];
}

export interface TaskRecommendation {
    approach: string;
    confidence: number;
    basedOn: string[];  // Experience IDs
    warnings: string[];
    estimatedDuration: number;
    suggestedTools: string[];
}

export interface LearningMetrics {
    totalExperiences: number;
    successRate: number;
    averageDuration: number;
    topPatterns: Array<{ pattern: string; count: number }>;
    commonBlockers: Array<{ blocker: string; count: number }>;
}

// === Experience Storage (In-Memory + File-based) ===

interface ExperienceStore {
    experiences: Experience[];
    lastUpdated: number;
}

// === Experience Learner Class ===

export class ExperienceLearner {
    private store: ExperienceStore;
    private roleId: string;
    private teamId?: string;
    private maxExperiences: number;

    constructor(roleId: string, teamId?: string, maxExperiences: number = 1000) {
        this.roleId = roleId;
        this.teamId = teamId;
        this.maxExperiences = maxExperiences;
        this.store = {
            experiences: [],
            lastUpdated: Date.now()
        };
    }

    /**
     * Record a successful task execution
     */
    async recordSuccess(
        taskType: string,
        taskTitle: string,
        approach: string,
        outcome: ExecutionOutcome
    ): Promise<string> {
        const experience = this.createExperience(
            taskType,
            taskTitle,
            approach,
            'success',
            outcome
        );

        // Extract learnings from successful execution
        experience.learnings = this.extractLearnings(experience, outcome);

        this.addExperience(experience);
        logger.debug(`[ExperienceLearner] Recorded success: ${experience.id}`);

        return experience.id;
    }

    /**
     * Record a failed task execution
     */
    async recordFailure(
        taskType: string,
        taskTitle: string,
        approach: string,
        error: ExecutionError
    ): Promise<string> {
        const outcome: ExecutionOutcome = {
            success: false,
            stepsExecuted: [],
            toolsUsed: [],
            blockersFaced: [error.message],
            resolution: error.recoveryAttempts.join('; '),
            duration: 0
        };

        const experience = this.createExperience(
            taskType,
            taskTitle,
            approach,
            'failure',
            outcome
        );

        // Extract learnings from failure
        experience.learnings = this.extractFailureLearnings(experience, error);

        this.addExperience(experience);
        logger.debug(`[ExperienceLearner] Recorded failure: ${experience.id}`);

        return experience.id;
    }

    /**
     * Get relevant experiences for a task
     */
    async getRelevantExperiences(
        taskDescription: string,
        limit: number = 5
    ): Promise<Experience[]> {
        // Score each experience by relevance
        const scored = this.store.experiences.map(exp => ({
            experience: exp,
            score: this.calculateRelevanceScore(exp, taskDescription)
        }));

        // Sort by score descending
        scored.sort((a, b) => b.score - a.score);

        // Return top matches
        return scored.slice(0, limit).map(s => s.experience);
    }

    /**
     * Generate recommendations for a new task
     */
    async generateRecommendations(
        newTask: KanbanTaskSummary
    ): Promise<TaskRecommendation[]> {
        const taskDescription = `${newTask.title}`;
        const relevantExperiences = await this.getRelevantExperiences(taskDescription, 10);

        if (relevantExperiences.length === 0) {
            return [{
                approach: 'No similar experiences found. Proceed with standard approach.',
                confidence: 0.3,
                basedOn: [],
                warnings: ['No historical data available'],
                estimatedDuration: 0,
                suggestedTools: []
            }];
        }

        const recommendations: TaskRecommendation[] = [];

        // Group experiences by approach
        const approachGroups = this.groupByApproach(relevantExperiences);

        for (const [approach, experiences] of Object.entries(approachGroups)) {
            const successCount = experiences.filter(e => e.outcome === 'success').length;
            const totalCount = experiences.length;
            const successRate = successCount / totalCount;

            // Collect warnings from failures
            const warnings: string[] = [];
            const failedExperiences = experiences.filter(e => e.outcome === 'failure');
            failedExperiences.forEach(exp => {
                exp.details.blockersFaced.forEach(blocker => {
                    if (!warnings.includes(blocker)) {
                        warnings.push(blocker);
                    }
                });
            });

            // Calculate average duration from successful experiences
            const successfulExperiences = experiences.filter(e => e.outcome === 'success');
            const avgDuration = successfulExperiences.length > 0
                ? successfulExperiences.reduce((sum, e) => sum + e.duration, 0) / successfulExperiences.length
                : 0;

            // Collect commonly used tools
            const toolCounts = new Map<string, number>();
            experiences.forEach(exp => {
                exp.details.toolsUsed.forEach(tool => {
                    toolCounts.set(tool, (toolCounts.get(tool) || 0) + 1);
                });
            });
            const suggestedTools = Array.from(toolCounts.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([tool]) => tool);

            recommendations.push({
                approach,
                confidence: successRate * 0.7 + (totalCount / 10) * 0.3, // Blend success rate with sample size
                basedOn: experiences.map(e => e.id),
                warnings: warnings.slice(0, 3),
                estimatedDuration: avgDuration,
                suggestedTools
            });
        }

        // Sort by confidence
        recommendations.sort((a, b) => b.confidence - a.confidence);

        return recommendations.slice(0, 3);
    }

    /**
     * Get learning metrics
     */
    getMetrics(): LearningMetrics {
        const experiences = this.store.experiences;

        // Calculate success rate
        const successCount = experiences.filter(e => e.outcome === 'success').length;
        const successRate = experiences.length > 0 ? successCount / experiences.length : 0;

        // Calculate average duration
        const durations = experiences.map(e => e.duration).filter(d => d > 0);
        const avgDuration = durations.length > 0
            ? durations.reduce((sum, d) => sum + d, 0) / durations.length
            : 0;

        // Find top patterns (task types)
        const patternCounts = new Map<string, number>();
        experiences.forEach(exp => {
            patternCounts.set(exp.taskType, (patternCounts.get(exp.taskType) || 0) + 1);
        });
        const topPatterns = Array.from(patternCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pattern, count]) => ({ pattern, count }));

        // Find common blockers
        const blockerCounts = new Map<string, number>();
        experiences.forEach(exp => {
            exp.details.blockersFaced.forEach(blocker => {
                blockerCounts.set(blocker, (blockerCounts.get(blocker) || 0) + 1);
            });
        });
        const commonBlockers = Array.from(blockerCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([blocker, count]) => ({ blocker, count }));

        return {
            totalExperiences: experiences.length,
            successRate,
            averageDuration: avgDuration,
            topPatterns,
            commonBlockers
        };
    }

    /**
     * Get learnings summary
     */
    getLearningsSummary(): string {
        const metrics = this.getMetrics();

        let summary = `
# Experience Learning Summary

**Total Experiences:** ${metrics.totalExperiences}
**Success Rate:** ${(metrics.successRate * 100).toFixed(1)}%
**Average Duration:** ${this.formatDuration(metrics.averageDuration)}

## Top Task Patterns
${metrics.topPatterns.map(p => `- ${p.pattern}: ${p.count} experiences`).join('\n')}

## Common Blockers
${metrics.commonBlockers.map(b => `- ${b.blocker}: ${b.count} occurrences`).join('\n')}

## Key Learnings
`.trim();

        // Aggregate learnings from successful experiences
        const allLearnings = this.store.experiences
            .filter(e => e.outcome === 'success')
            .flatMap(e => e.learnings);

        const uniqueLearnings = [...new Set(allLearnings)].slice(0, 10);
        summary += '\n' + uniqueLearnings.map(l => `- ${l}`).join('\n');

        return summary;
    }

    /**
     * Clear all experiences (for testing/reset)
     */
    clearExperiences(): void {
        this.store.experiences = [];
        this.store.lastUpdated = Date.now();
        logger.debug('[ExperienceLearner] Cleared all experiences');
    }

    // === Private Methods ===

    private createExperience(
        taskType: string,
        taskTitle: string,
        approach: string,
        outcome: ExperienceOutcome,
        executionOutcome: ExecutionOutcome
    ): Experience {
        return {
            id: randomUUID(),
            taskType,
            taskTitle,
            approach,
            outcome,
            duration: executionOutcome.duration,
            details: {
                stepsExecuted: executionOutcome.stepsExecuted,
                toolsUsed: executionOutcome.toolsUsed,
                blockersFaced: executionOutcome.blockersFaced,
                resolution: executionOutcome.resolution
            },
            context: {
                roleId: this.roleId,
                teamId: this.teamId
            },
            learnings: [],
            timestamp: Date.now(),
            confidence: outcome === 'success' ? 0.8 : 0.5
        };
    }

    private addExperience(experience: Experience): void {
        this.store.experiences.push(experience);
        this.store.lastUpdated = Date.now();

        // Trim old experiences if over limit
        if (this.store.experiences.length > this.maxExperiences) {
            // Keep most recent and highest confidence
            this.store.experiences.sort((a, b) => {
                const timeScore = (b.timestamp - a.timestamp) / 1000000;
                const confScore = b.confidence - a.confidence;
                return timeScore + confScore;
            });
            this.store.experiences = this.store.experiences.slice(0, this.maxExperiences);
        }
    }

    private extractLearnings(experience: Experience, outcome: ExecutionOutcome): string[] {
        const learnings: string[] = [];

        // Learn from tools used
        if (outcome.toolsUsed.length > 0) {
            learnings.push(`Effective tools for ${experience.taskType}: ${outcome.toolsUsed.join(', ')}`);
        }

        // Learn from execution steps
        if (outcome.stepsExecuted.length > 0) {
            learnings.push(`Successful approach: ${outcome.stepsExecuted.slice(0, 3).join(' → ')}`);
        }

        // Learn from blockers overcome
        if (outcome.blockersFaced.length > 0 && outcome.resolution) {
            learnings.push(`Blocker "${outcome.blockersFaced[0]}" resolved by: ${outcome.resolution}`);
        }

        return learnings;
    }

    private extractFailureLearnings(experience: Experience, error: ExecutionError): string[] {
        const learnings: string[] = [];

        learnings.push(`Avoid: ${error.message}`);

        if (error.recoveryAttempts.length > 0) {
            learnings.push(`Recovery attempts that didn't work: ${error.recoveryAttempts.join(', ')}`);
        }

        learnings.push(`Task type ${experience.taskType} may have issues with approach: ${experience.approach}`);

        return learnings;
    }

    private calculateRelevanceScore(experience: Experience, taskDescription: string): number {
        let score = 0;

        // Simple keyword matching (in production, use embeddings/semantic search)
        const descWords = taskDescription.toLowerCase().split(/\s+/);
        const titleWords = experience.taskTitle.toLowerCase().split(/\s+/);
        const typeWords = experience.taskType.toLowerCase().split(/\s+/);

        // Title similarity
        const titleMatches = titleWords.filter(w => descWords.includes(w)).length;
        score += (titleMatches / Math.max(titleWords.length, 1)) * 0.4;

        // Type similarity
        const typeMatches = typeWords.filter(w => descWords.includes(w)).length;
        score += (typeMatches / Math.max(typeWords.length, 1)) * 0.3;

        // Recency bonus
        const ageHours = (Date.now() - experience.timestamp) / (1000 * 60 * 60);
        const recencyScore = Math.max(0, 1 - ageHours / (24 * 30)); // Decay over 30 days
        score += recencyScore * 0.2;

        // Confidence bonus
        score += experience.confidence * 0.1;

        return score;
    }

    private groupByApproach(experiences: Experience[]): Record<string, Experience[]> {
        const groups: Record<string, Experience[]> = {};

        for (const exp of experiences) {
            const key = exp.approach;
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(exp);
        }

        return groups;
    }

    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
        return `${(ms / 3600000).toFixed(1)}h`;
    }
}

// === Factory Function ===

/**
 * Create an ExperienceLearner instance
 */
export function createExperienceLearner(
    roleId: string,
    teamId?: string,
    maxExperiences?: number
): ExperienceLearner {
    return new ExperienceLearner(roleId, teamId, maxExperiences);
}

// === Utility Functions ===

/**
 * Merge multiple experience learners (for team-wide learning)
 */
export function mergeExperiences(
    learners: ExperienceLearner[]
): LearningMetrics {
    // Aggregate metrics from all learners
    const allMetrics = learners.map(l => l.getMetrics());

    const totalExperiences = allMetrics.reduce((sum, m) => sum + m.totalExperiences, 0);
    const weightedSuccessRate = allMetrics.reduce(
        (sum, m) => sum + m.successRate * m.totalExperiences, 0
    ) / totalExperiences;
    const avgDuration = allMetrics.reduce(
        (sum, m) => sum + m.averageDuration * m.totalExperiences, 0
    ) / totalExperiences;

    // Merge pattern counts
    const patternMap = new Map<string, number>();
    allMetrics.forEach(m => {
        m.topPatterns.forEach(p => {
            patternMap.set(p.pattern, (patternMap.get(p.pattern) || 0) + p.count);
        });
    });

    // Merge blocker counts
    const blockerMap = new Map<string, number>();
    allMetrics.forEach(m => {
        m.commonBlockers.forEach(b => {
            blockerMap.set(b.blocker, (blockerMap.get(b.blocker) || 0) + b.count);
        });
    });

    return {
        totalExperiences,
        successRate: weightedSuccessRate,
        averageDuration: avgDuration,
        topPatterns: Array.from(patternMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([pattern, count]) => ({ pattern, count })),
        commonBlockers: Array.from(blockerMap.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([blocker, count]) => ({ blocker, count }))
    };
}
