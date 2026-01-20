/**
 * UltraThink Planner Module
 *
 * Integrates extended thinking capabilities for complex planning tasks.
 * This module provides:
 * - Deep task decomposition with reasoning
 * - Dependency analysis and ordering
 * - Risk assessment and mitigation planning
 * - Resource allocation recommendations
 *
 * Uses Claude's extended thinking mode for thorough analysis.
 */

import { randomUUID } from 'crypto';
import { logger } from '@/ui/logger';
import { KanbanTaskSummary, KanbanContext } from './roles';

// === Types ===

export interface TaskDecomposition {
    originalRequest: string;
    analysis: {
        understanding: string;
        assumptions: string[];
        constraints: string[];
        risks: string[];
    };
    tasks: DecomposedTask[];
    dependencies: TaskDependency[];
    estimatedComplexity: 'low' | 'medium' | 'high' | 'very-high';
    recommendedApproach: string;
    alternativeApproaches?: string[];
}

export interface DecomposedTask {
    id: string;
    title: string;
    description: string;
    category: string;
    suggestedRole: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    estimatedEffort: 'trivial' | 'small' | 'medium' | 'large' | 'epic';
    acceptanceCriteria: string[];
    subtasks?: DecomposedTask[];
}

export interface TaskDependency {
    taskId: string;
    dependsOn: string[];
    type: 'blocks' | 'requires' | 'informs';
    description?: string;
}

export interface PlanningContext {
    codebaseInfo?: string;
    existingTasks: KanbanTaskSummary[];
    teamCapabilities: string[];
    projectGoals?: string[];
    constraints?: string[];
}

export interface PlanningPromptConfig {
    thinkingBudget?: number;  // Token budget for extended thinking
    maxDepth?: number;        // Maximum subtask nesting depth
    includeRisks?: boolean;
    includeAlternatives?: boolean;
}

const DEFAULT_CONFIG: PlanningPromptConfig = {
    thinkingBudget: 16000,
    maxDepth: 3,
    includeRisks: true,
    includeAlternatives: true
};

// === UltraThink Planner Class ===

export class UltraThinkPlanner {
    private config: PlanningPromptConfig;

    constructor(config?: Partial<PlanningPromptConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Generate a planning prompt for extended thinking
     *
     * This creates a structured prompt that guides Claude's extended thinking
     * through a comprehensive planning process.
     */
    generatePlanningPrompt(
        userRequest: string,
        context: PlanningContext
    ): string {
        const existingTasksSummary = context.existingTasks.length > 0
            ? context.existingTasks.map(t => `- [${t.status}] ${t.title}`).join('\n')
            : '(No existing tasks)';

        const teamCapabilities = context.teamCapabilities.length > 0
            ? context.teamCapabilities.join(', ')
            : 'Full-stack development team';

        let prompt = `
# Task Decomposition Request

## User Request
${userRequest}

## Current Context

### Existing Tasks
${existingTasksSummary}

### Team Capabilities
${teamCapabilities}

${context.codebaseInfo ? `### Codebase Information\n${context.codebaseInfo}\n` : ''}
${context.projectGoals ? `### Project Goals\n${context.projectGoals.map(g => `- ${g}`).join('\n')}\n` : ''}
${context.constraints ? `### Constraints\n${context.constraints.map(c => `- ${c}`).join('\n')}\n` : ''}

## Planning Instructions

Please perform a thorough analysis and task decomposition:

1. **Understanding Phase**
   - Restate the request in your own words
   - Identify implicit requirements
   - List assumptions being made
   - Identify potential ambiguities

2. **Analysis Phase**
   - Assess technical complexity
   - Identify required skills/roles
   - Consider existing tasks and potential overlaps
   - Evaluate dependencies on external factors

3. **Decomposition Phase**
   - Break down into actionable tasks (max depth: ${this.config.maxDepth})
   - Each task should be:
     * Specific and measurable
     * Achievable by one role
     * Appropriately sized (2-8 hours ideal)
   - Include acceptance criteria for each task

4. **Dependency Mapping**
   - Identify task dependencies
   - Determine optimal execution order
   - Flag parallel execution opportunities

${this.config.includeRisks ? `
5. **Risk Assessment**
   - Identify potential blockers
   - Assess probability and impact
   - Suggest mitigation strategies
` : ''}

${this.config.includeAlternatives ? `
6. **Alternative Approaches**
   - Consider at least one alternative approach
   - Compare trade-offs
   - Recommend preferred approach with reasoning
` : ''}

## Output Format

Please structure your response as:

### Understanding
[Your understanding of the request]

### Assumptions
- [Assumption 1]
- [Assumption 2]

### Constraints
- [Constraint 1]
- [Constraint 2]

### Risks
- [Risk 1]: [Mitigation]
- [Risk 2]: [Mitigation]

### Task Breakdown

#### Task 1: [Title]
- **Description**: [What needs to be done]
- **Role**: [Suggested role]
- **Priority**: [low/medium/high/urgent]
- **Effort**: [trivial/small/medium/large/epic]
- **Acceptance Criteria**:
  - [ ] Criterion 1
  - [ ] Criterion 2
- **Dependencies**: [Task IDs this depends on]

[Continue for all tasks...]

### Recommended Approach
[Your recommended approach and reasoning]

${this.config.includeAlternatives ? `
### Alternative Approach
[Alternative approach and trade-offs]
` : ''}

### Execution Order
1. [Task ID] - [Title] (can start immediately)
2. [Task ID] - [Title] (after Task X)
...
`.trim();

        return prompt;
    }

    /**
     * Parse a planning response into structured TaskDecomposition
     *
     * This parses the response from extended thinking into a structured format.
     * In practice, this would be called after receiving a response from Claude.
     */
    parseDecompositionResponse(
        response: string,
        originalRequest: string
    ): TaskDecomposition {
        // This is a simplified parser - in production, you'd use more robust parsing
        const decomposition: TaskDecomposition = {
            originalRequest,
            analysis: {
                understanding: this.extractSection(response, 'Understanding'),
                assumptions: this.extractListItems(response, 'Assumptions'),
                constraints: this.extractListItems(response, 'Constraints'),
                risks: this.extractListItems(response, 'Risks')
            },
            tasks: this.extractTasks(response),
            dependencies: this.extractDependencies(response),
            estimatedComplexity: this.assessComplexity(response),
            recommendedApproach: this.extractSection(response, 'Recommended Approach'),
            alternativeApproaches: this.config.includeAlternatives
                ? [this.extractSection(response, 'Alternative Approach')]
                : undefined
        };

        return decomposition;
    }

    /**
     * Convert TaskDecomposition to Kanban tasks format
     */
    toKanbanTasks(decomposition: TaskDecomposition): Array<{
        title: string;
        description: string;
        priority: string;
        labels: string[];
        parentTaskId?: string;
    }> {
        const kanbanTasks: Array<{
            title: string;
            description: string;
            priority: string;
            labels: string[];
            parentTaskId?: string;
        }> = [];

        const processTask = (task: DecomposedTask, parentId?: string) => {
            const kanbanTask = {
                title: task.title,
                description: `${task.description}\n\n**Acceptance Criteria:**\n${task.acceptanceCriteria.map(c => `- [ ] ${c}`).join('\n')}`,
                priority: task.priority,
                labels: [task.category, task.suggestedRole, task.estimatedEffort],
                parentTaskId: parentId
            };

            kanbanTasks.push(kanbanTask);

            // Process subtasks
            if (task.subtasks) {
                task.subtasks.forEach(subtask => {
                    processTask(subtask, task.id);
                });
            }
        };

        decomposition.tasks.forEach(task => processTask(task));

        return kanbanTasks;
    }

    /**
     * Generate a summary of the decomposition for team communication
     */
    generateDecompositionSummary(decomposition: TaskDecomposition): string {
        const taskCount = this.countTasks(decomposition.tasks);

        return `
📋 **Task Decomposition Complete**

**Original Request:** ${decomposition.originalRequest.substring(0, 100)}${decomposition.originalRequest.length > 100 ? '...' : ''}

**Complexity:** ${decomposition.estimatedComplexity.toUpperCase()}
**Total Tasks:** ${taskCount}

**Key Assumptions:**
${decomposition.analysis.assumptions.slice(0, 3).map(a => `- ${a}`).join('\n')}

**Identified Risks:**
${decomposition.analysis.risks.slice(0, 3).map(r => `- ${r}`).join('\n')}

**Recommended Approach:**
${decomposition.recommendedApproach.substring(0, 200)}${decomposition.recommendedApproach.length > 200 ? '...' : ''}

**Top-Level Tasks:**
${decomposition.tasks.slice(0, 5).map((t, i) => `${i + 1}. [${t.priority.toUpperCase()}] ${t.title} → @${t.suggestedRole}`).join('\n')}
${decomposition.tasks.length > 5 ? `\n... and ${decomposition.tasks.length - 5} more tasks` : ''}
`.trim();
    }

    // === Private Helper Methods ===

    private extractSection(text: string, sectionName: string): string {
        const regex = new RegExp(`###\\s*${sectionName}\\s*\\n([\\s\\S]*?)(?=###|$)`, 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : '';
    }

    private extractListItems(text: string, sectionName: string): string[] {
        const section = this.extractSection(text, sectionName);
        const items = section.match(/^[-*]\s+(.+)$/gm);
        return items ? items.map(item => item.replace(/^[-*]\s+/, '').trim()) : [];
    }

    private extractTasks(text: string): DecomposedTask[] {
        // Simplified task extraction - in production, use more robust parsing
        const tasks: DecomposedTask[] = [];
        const taskRegex = /####\s*Task\s*\d+:\s*(.+)\n([\s\S]*?)(?=####|###|$)/gi;

        let match;
        while ((match = taskRegex.exec(text)) !== null) {
            const title = match[1].trim();
            const content = match[2];

            const task: DecomposedTask = {
                id: randomUUID(),
                title,
                description: this.extractField(content, 'Description'),
                category: 'implementation',
                suggestedRole: this.extractField(content, 'Role') || 'builder',
                priority: this.parsePriority(this.extractField(content, 'Priority')),
                estimatedEffort: this.parseEffort(this.extractField(content, 'Effort')),
                acceptanceCriteria: this.extractChecklistItems(content, 'Acceptance Criteria')
            };

            tasks.push(task);
        }

        return tasks;
    }

    private extractField(text: string, fieldName: string): string {
        const regex = new RegExp(`\\*\\*${fieldName}\\*\\*:\\s*(.+)`, 'i');
        const match = text.match(regex);
        return match ? match[1].trim() : '';
    }

    private extractChecklistItems(text: string, sectionName: string): string[] {
        const section = text.substring(text.indexOf(sectionName));
        const items = section.match(/^\s*-\s*\[\s*\]\s*(.+)$/gm);
        return items ? items.map(item => item.replace(/^\s*-\s*\[\s*\]\s*/, '').trim()) : [];
    }

    private extractDependencies(text: string): TaskDependency[] {
        // Simplified dependency extraction
        return [];
    }

    private parsePriority(value: string): 'low' | 'medium' | 'high' | 'urgent' {
        const normalized = value.toLowerCase();
        if (normalized.includes('urgent')) return 'urgent';
        if (normalized.includes('high')) return 'high';
        if (normalized.includes('low')) return 'low';
        return 'medium';
    }

    private parseEffort(value: string): 'trivial' | 'small' | 'medium' | 'large' | 'epic' {
        const normalized = value.toLowerCase();
        if (normalized.includes('trivial')) return 'trivial';
        if (normalized.includes('epic')) return 'epic';
        if (normalized.includes('large')) return 'large';
        if (normalized.includes('small')) return 'small';
        return 'medium';
    }

    private assessComplexity(text: string): 'low' | 'medium' | 'high' | 'very-high' {
        // Simple heuristic based on content
        const taskCount = (text.match(/####\s*Task/gi) || []).length;
        const riskCount = (text.match(/risk/gi) || []).length;

        if (taskCount > 10 || riskCount > 5) return 'very-high';
        if (taskCount > 5 || riskCount > 3) return 'high';
        if (taskCount > 2) return 'medium';
        return 'low';
    }

    private countTasks(tasks: DecomposedTask[]): number {
        let count = tasks.length;
        for (const task of tasks) {
            if (task.subtasks) {
                count += this.countTasks(task.subtasks);
            }
        }
        return count;
    }
}

// === Factory Function ===

/**
 * Create an UltraThinkPlanner instance
 */
export function createUltraThinkPlanner(
    config?: Partial<PlanningPromptConfig>
): UltraThinkPlanner {
    return new UltraThinkPlanner(config);
}

// === Utility Functions ===

/**
 * Generate a quick task breakdown without extended thinking
 * Useful for simpler requests
 */
export function quickDecompose(
    request: string,
    maxTasks: number = 5
): DecomposedTask[] {
    // This would be used for simple requests that don't need extended thinking
    logger.debug(`[UltraThinkPlanner] Quick decomposition for: ${request.substring(0, 50)}...`);

    // Placeholder - in practice, this would use a fast model call
    return [{
        id: randomUUID(),
        title: request,
        description: 'Task created from quick decomposition',
        category: 'general',
        suggestedRole: 'builder',
        priority: 'medium',
        estimatedEffort: 'medium',
        acceptanceCriteria: ['Task completed as requested']
    }];
}
