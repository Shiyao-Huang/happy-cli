/**
 * Ralph Loop Executor Module
 *
 * Implements the RALPH pattern for iterative task execution:
 * - Research: Gather context and understand the problem
 * - Act: Execute the planned actions
 * - Loop: Evaluate results and iterate if needed
 * - Plan: Create/refine execution plan
 * - Halt: Stop when goal is achieved or max iterations reached
 *
 * This module coordinates complex multi-step tasks with
 * built-in feedback loops and adaptive planning.
 */

import { randomUUID } from 'crypto';
import { logger } from '@/ui/logger';
import { TaskStateManager } from '../utils/taskStateManager';
import { UltraThinkPlanner, TaskDecomposition, DecomposedTask } from './ultrathinkPlanner';
import { StatusReporter } from './statusReporter';
import { KanbanContext, KanbanTaskSummary } from './roles';

// === Types ===

export type LoopPhase = 'research' | 'plan' | 'act' | 'evaluate' | 'halt';

export interface LoopState {
    phase: LoopPhase;
    iteration: number;
    goal: string;
    context: LoopContext;
    plan?: TaskDecomposition;
    results: IterationResult[];
    haltReason?: HaltReason;
}

export interface LoopContext {
    gatheredInfo: string[];
    assumptions: string[];
    constraints: string[];
    blockers: string[];
    teamState: KanbanContext | null;
}

export interface IterationResult {
    iteration: number;
    phase: LoopPhase;
    success: boolean;
    outcome: string;
    tasksCompleted: string[];
    tasksFailed: string[];
    newBlockers: string[];
    nextAction: string;
}

export type HaltReason =
    | 'goal-achieved'
    | 'max-iterations'
    | 'blocked'
    | 'user-interrupt'
    | 'error';

export interface RalphLoopConfig {
    maxIterations: number;
    autoHaltOnGoal: boolean;
    requireApprovalPerIteration: boolean;
    minConfidenceToHalt: number;  // 0-1 confidence threshold
    pauseBetweenIterations: boolean;
}

const DEFAULT_CONFIG: RalphLoopConfig = {
    maxIterations: 10,
    autoHaltOnGoal: true,
    requireApprovalPerIteration: false,
    minConfidenceToHalt: 0.8,
    pauseBetweenIterations: false
};

// === Ralph Loop Executor Class ===

export class RalphLoopExecutor {
    private taskManager: TaskStateManager;
    private planner: UltraThinkPlanner;
    private statusReporter?: StatusReporter;
    private config: RalphLoopConfig;
    private state: LoopState | null = null;
    private onPhaseChange?: (state: LoopState) => void;
    private onIterationComplete?: (result: IterationResult) => void;

    constructor(
        taskManager: TaskStateManager,
        planner: UltraThinkPlanner,
        config?: Partial<RalphLoopConfig>,
        statusReporter?: StatusReporter
    ) {
        this.taskManager = taskManager;
        this.planner = planner;
        this.statusReporter = statusReporter;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Set callbacks for loop events
     */
    setCallbacks(callbacks: {
        onPhaseChange?: (state: LoopState) => void;
        onIterationComplete?: (result: IterationResult) => void;
    }): void {
        this.onPhaseChange = callbacks.onPhaseChange;
        this.onIterationComplete = callbacks.onIterationComplete;
    }

    /**
     * Execute the Ralph Loop for a given goal
     */
    async execute(goal: string): Promise<LoopState> {
        logger.debug(`[RalphLoop] Starting execution for goal: ${goal.substring(0, 50)}...`);

        // Initialize state
        this.state = {
            phase: 'research',
            iteration: 0,
            goal,
            context: {
                gatheredInfo: [],
                assumptions: [],
                constraints: [],
                blockers: [],
                teamState: null
            },
            results: []
        };

        // Main loop
        while (this.state.iteration < this.config.maxIterations && !this.state.haltReason) {
            this.state.iteration++;
            logger.debug(`[RalphLoop] Starting iteration ${this.state.iteration}`);

            try {
                // RESEARCH Phase
                await this.executeResearchPhase();

                // PLAN Phase
                await this.executePlanPhase();

                // ACT Phase
                const actResult = await this.executeActPhase();

                // EVALUATE (Loop decision)
                const shouldContinue = await this.executeEvaluatePhase(actResult);

                if (!shouldContinue) {
                    this.state.haltReason = 'goal-achieved';
                    this.state.phase = 'halt';
                    break;
                }

                // Pause between iterations if configured
                if (this.config.pauseBetweenIterations) {
                    logger.debug('[RalphLoop] Pausing between iterations...');
                    await this.pause(1000);
                }

            } catch (error) {
                logger.debug('[RalphLoop] Error during execution:', error);
                this.state.haltReason = 'error';
                this.state.phase = 'halt';

                this.state.results.push({
                    iteration: this.state.iteration,
                    phase: this.state.phase,
                    success: false,
                    outcome: `Error: ${String(error)}`,
                    tasksCompleted: [],
                    tasksFailed: [],
                    newBlockers: [String(error)],
                    nextAction: 'halt-on-error'
                });
                break;
            }
        }

        // Check for max iterations
        if (this.state.iteration >= this.config.maxIterations && !this.state.haltReason) {
            this.state.haltReason = 'max-iterations';
            this.state.phase = 'halt';
        }

        logger.debug(`[RalphLoop] Execution complete. Halt reason: ${this.state.haltReason}`);
        return this.state;
    }

    /**
     * Get current loop state
     */
    getState(): LoopState | null {
        return this.state;
    }

    /**
     * Manually halt the loop
     */
    halt(reason: HaltReason): void {
        if (this.state) {
            this.state.haltReason = reason;
            this.state.phase = 'halt';
        }
    }

    /**
     * Generate a summary of the loop execution
     */
    generateSummary(): string {
        if (!this.state) {
            return 'No loop execution state available.';
        }

        const successfulIterations = this.state.results.filter(r => r.success).length;
        const totalTasksCompleted = this.state.results.reduce(
            (sum, r) => sum + r.tasksCompleted.length, 0
        );

        return `
# Ralph Loop Execution Summary

**Goal:** ${this.state.goal}
**Total Iterations:** ${this.state.iteration}
**Successful Iterations:** ${successfulIterations}
**Halt Reason:** ${this.state.haltReason || 'still running'}

## Metrics
- Tasks Completed: ${totalTasksCompleted}
- Blockers Encountered: ${this.state.context.blockers.length}

## Iteration History
${this.state.results.map(r => `
### Iteration ${r.iteration}
- **Phase:** ${r.phase}
- **Success:** ${r.success ? '✅' : '❌'}
- **Outcome:** ${r.outcome}
- **Next Action:** ${r.nextAction}
`).join('\n')}

## Final Context
- **Gathered Info:** ${this.state.context.gatheredInfo.length} items
- **Assumptions:** ${this.state.context.assumptions.length} items
- **Constraints:** ${this.state.context.constraints.length} items
`.trim();
    }

    // === Phase Implementations ===

    /**
     * RESEARCH Phase: Gather context and understand the problem
     */
    private async executeResearchPhase(): Promise<void> {
        this.setPhase('research');
        logger.debug('[RalphLoop] Executing RESEARCH phase');

        // Get current team/kanban state
        try {
            this.state!.context.teamState = await this.taskManager.getFilteredContext();
            this.state!.context.gatheredInfo.push(
                `Team has ${this.state!.context.teamState.myTasks.length} active tasks`
            );
        } catch (error) {
            logger.debug('[RalphLoop] Failed to get team state:', error);
        }

        // Analyze existing information
        if (this.state!.iteration === 1) {
            this.state!.context.gatheredInfo.push(`Goal established: ${this.state!.goal}`);
        } else {
            // In subsequent iterations, analyze what we learned
            const lastResult = this.state!.results[this.state!.results.length - 1];
            if (lastResult) {
                this.state!.context.gatheredInfo.push(
                    `Previous iteration: ${lastResult.outcome}`
                );
            }
        }
    }

    /**
     * PLAN Phase: Create or refine the execution plan
     */
    private async executePlanPhase(): Promise<void> {
        this.setPhase('plan');
        logger.debug('[RalphLoop] Executing PLAN phase');

        // Generate planning prompt
        const planningContext = {
            existingTasks: this.state!.context.teamState?.myTasks || [],
            teamCapabilities: ['full-stack', 'review', 'research'],
            constraints: this.state!.context.constraints,
            projectGoals: [this.state!.goal]
        };

        // Generate planning prompt (would be sent to Claude for planning)
        const planPrompt = this.planner.generatePlanningPrompt(
            this.state!.goal,
            planningContext
        );

        // In a real implementation, this would call Claude with extended thinking
        // For now, we create a simple plan structure
        this.state!.plan = {
            originalRequest: this.state!.goal,
            analysis: {
                understanding: `Goal: ${this.state!.goal}`,
                assumptions: this.state!.context.assumptions,
                constraints: this.state!.context.constraints,
                risks: []
            },
            tasks: [],
            dependencies: [],
            estimatedComplexity: 'medium',
            recommendedApproach: 'Iterative execution with feedback'
        };

        logger.debug('[RalphLoop] Plan generated');
    }

    /**
     * ACT Phase: Execute the planned actions
     */
    private async executeActPhase(): Promise<IterationResult> {
        this.setPhase('act');
        logger.debug('[RalphLoop] Executing ACT phase');

        const result: IterationResult = {
            iteration: this.state!.iteration,
            phase: 'act',
            success: true,
            outcome: '',
            tasksCompleted: [],
            tasksFailed: [],
            newBlockers: [],
            nextAction: ''
        };

        // Execute tasks from the plan
        if (this.state!.plan?.tasks) {
            for (const task of this.state!.plan.tasks) {
                try {
                    // Report task start
                    if (this.statusReporter) {
                        await this.statusReporter.reportTaskStarted(task.id, task.title);
                    }

                    // Simulate task execution
                    // In real implementation, this would coordinate with the agent
                    const taskSuccess = await this.executeTask(task);

                    if (taskSuccess) {
                        result.tasksCompleted.push(task.id);
                        if (this.statusReporter) {
                            await this.statusReporter.reportComplete(task.id, 'Task completed');
                        }
                    } else {
                        result.tasksFailed.push(task.id);
                    }
                } catch (error) {
                    result.tasksFailed.push(task.id);
                    result.newBlockers.push(`Task ${task.id} failed: ${String(error)}`);
                }
            }
        }

        // Determine outcome
        if (result.tasksFailed.length === 0) {
            result.outcome = `Completed ${result.tasksCompleted.length} tasks successfully`;
            result.nextAction = 'evaluate-progress';
        } else {
            result.success = false;
            result.outcome = `Completed ${result.tasksCompleted.length}, failed ${result.tasksFailed.length} tasks`;
            result.nextAction = 'address-failures';
        }

        this.state!.results.push(result);
        this.onIterationComplete?.(result);

        return result;
    }

    /**
     * EVALUATE Phase: Assess results and decide whether to continue
     */
    private async executeEvaluatePhase(actResult: IterationResult): Promise<boolean> {
        this.setPhase('evaluate');
        logger.debug('[RalphLoop] Executing EVALUATE phase');

        // Calculate progress/confidence
        const totalTasks = this.state!.plan?.tasks.length || 0;
        const completedTasks = actResult.tasksCompleted.length;
        const confidence = totalTasks > 0 ? completedTasks / totalTasks : 0;

        // Check if we should halt
        if (this.config.autoHaltOnGoal && confidence >= this.config.minConfidenceToHalt) {
            logger.debug(`[RalphLoop] Goal achieved with confidence ${confidence}`);
            return false; // Halt
        }

        // Check for blockers that prevent continuation
        if (actResult.newBlockers.length > 0 && actResult.tasksFailed.length > actResult.tasksCompleted.length) {
            this.state!.context.blockers.push(...actResult.newBlockers);
            logger.debug('[RalphLoop] Too many blockers, may need to halt');

            // Could halt here if blockers are severe
            if (this.state!.context.blockers.length > 5) {
                this.state!.haltReason = 'blocked';
                return false;
            }
        }

        // Continue to next iteration
        return true;
    }

    // === Helper Methods ===

    private setPhase(phase: LoopPhase): void {
        if (this.state) {
            this.state.phase = phase;
            this.onPhaseChange?.(this.state);
        }
    }

    private async executeTask(task: DecomposedTask): Promise<boolean> {
        // Placeholder for actual task execution
        // In real implementation, this would coordinate with the agent
        logger.debug(`[RalphLoop] Executing task: ${task.title}`);
        return true;
    }

    private pause(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// === Factory Function ===

/**
 * Create a RalphLoopExecutor instance
 */
export function createRalphLoopExecutor(
    taskManager: TaskStateManager,
    planner: UltraThinkPlanner,
    config?: Partial<RalphLoopConfig>,
    statusReporter?: StatusReporter
): RalphLoopExecutor {
    return new RalphLoopExecutor(taskManager, planner, config, statusReporter);
}

// === Utility Functions ===

/**
 * Check if a loop should continue based on current state
 */
export function shouldContinueLoop(state: LoopState, config: RalphLoopConfig): boolean {
    if (state.haltReason) return false;
    if (state.iteration >= config.maxIterations) return false;
    if (state.context.blockers.length > 5) return false;
    return true;
}

/**
 * Calculate loop progress as a percentage
 */
export function calculateLoopProgress(state: LoopState): number {
    const totalResults = state.results.length;
    if (totalResults === 0) return 0;

    const successfulResults = state.results.filter(r => r.success).length;
    return Math.round((successfulResults / totalResults) * 100);
}
