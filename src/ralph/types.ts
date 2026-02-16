/**
 * Ralph Loop Types
 *
 * Type definitions for the Ralph autonomous loop system.
 * Ralph iteratively spawns fresh Claude processes to complete
 * user stories from a PRD (Product Requirements Document).
 */

export interface UserStory {
    id: string;             // e.g. "US-001"
    title: string;
    description: string;
    acceptanceCriteria: string[];
    priority: number;       // lower number = higher priority
    passes: boolean;
    notes: string;
}

export interface PrdJson {
    project: string;
    branchName: string;
    description: string;
    userStories: UserStory[];
}

export interface RalphConfig {
    prdPath: string;
    progressPath: string;
    workingDirectory: string;
    maxIterations: number;
    model?: string;
    permissionMode?: string;
}

export type RalphStatus = 'idle' | 'running' | 'stopped' | 'complete' | 'error';

export interface RalphState {
    status: RalphStatus;
    iteration: number;
    maxIterations: number;
    currentStoryId: string | null;
    completed: number;
    total: number;
    startedAt: number;
}

export type ProgressPhase = 'research' | 'implementing' | 'testing' | 'committing';
