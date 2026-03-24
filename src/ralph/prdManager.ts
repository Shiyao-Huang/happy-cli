/**
 * PRD Manager
 *
 * Pure functions for reading/writing prd.json and progress.txt.
 * Manages the state of user stories and progress logging
 * for the Ralph autonomous loop.
 */

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { logger } from '@/ui/logger';
import type { PrdJson, UserStory } from './types';

/**
 * Load and parse a prd.json file.
 *
 * Supports two schemas:
 *   - Ralph format:   { project, userStories[] }
 *   - Project format: { projectName, tasks[] }
 *
 * Project format is normalized to Ralph format on load.
 */
export async function loadPrd(path: string): Promise<PrdJson> {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Normalize project-format PRD (tasks[] + projectName) to Ralph format
    if (Array.isArray(parsed.tasks) && !Array.isArray(parsed.userStories)) {
        const tasks = parsed.tasks as Array<Record<string, unknown>>;
        const normalized: PrdJson = {
            project: (parsed.projectName as string) ?? (parsed.project as string) ?? '',
            branchName: (parsed.metadata as Record<string, unknown>)?.branch as string ?? '',
            description: (parsed.description as string) ?? '',
            userStories: tasks.map((t, i) => ({
                id: (t.id as string) ?? `task-${i + 1}`,
                title: (t.title as string) ?? '',
                description: (t.description as string) ?? '',
                acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria as string[] : [],
                priority: priorityToNumber(t.priority as string) ?? i + 1,
                passes: (t.passes as boolean) ?? false,
                notes: (t.notes as string) ?? '',
            })),
        };

        if (normalized.userStories.length === 0) {
            throw new Error('Invalid prd.json: tasks array is empty');
        }

        return normalized;
    }

    // Standard Ralph format
    const prd = parsed as unknown as PrdJson;

    if (!prd.userStories || !Array.isArray(prd.userStories)) {
        throw new Error('Invalid prd.json: missing or invalid userStories array');
    }
    if (!prd.project || typeof prd.project !== 'string') {
        throw new Error('Invalid prd.json: missing project name');
    }

    return prd;
}

/**
 * Convert string priority to numeric priority.
 * Returns undefined if already numeric or unrecognized.
 */
function priorityToNumber(priority: string | undefined): number | undefined {
    if (priority === undefined) return undefined;
    const map: Record<string, number> = { high: 1, medium: 2, low: 3 };
    return map[priority];
}

/**
 * Save prd.json back to disk
 */
export async function savePrd(path: string, prd: PrdJson): Promise<void> {
    await writeFile(path, JSON.stringify(prd, null, 2) + '\n', 'utf-8');
}

/**
 * Get the next incomplete story, sorted by priority (lowest number first)
 * Returns null if all stories are complete
 */
export function getNextStory(prd: PrdJson): UserStory | null {
    const incomplete = prd.userStories
        .filter(s => !s.passes)
        .sort((a, b) => a.priority - b.priority);

    return incomplete[0] ?? null;
}

/**
 * Mark a story as complete in the prd.json file
 */
export async function markStoryComplete(
    prdPath: string,
    storyId: string,
    notes: string
): Promise<void> {
    const prd = await loadPrd(prdPath);
    const story = prd.userStories.find(s => s.id === storyId);

    if (!story) {
        throw new Error(`Story ${storyId} not found in prd.json`);
    }

    // Immutable update pattern
    const updatedStories = prd.userStories.map(s =>
        s.id === storyId
            ? { ...s, passes: true, notes }
            : s
    );

    await savePrd(prdPath, { ...prd, userStories: updatedStories });
    logger.debug(`[Ralph] Marked story ${storyId} as complete`);
}

/**
 * Append a progress entry to progress.txt
 */
export async function appendProgress(
    progressPath: string,
    entry: string
): Promise<void> {
    const separator = '\n---\n\n';
    const content = entry.endsWith('\n') ? entry : entry + '\n';

    if (!existsSync(progressPath)) {
        // Create file with header
        await writeFile(progressPath, `## Codebase Patterns\n\n---\n\n${content}${separator}`, 'utf-8');
    } else {
        await appendFile(progressPath, `${content}${separator}`, 'utf-8');
    }
}

/**
 * Extract the "Codebase Patterns" section from progress.txt
 * Returns empty string if the section doesn't exist
 */
export async function getCodebasePatterns(progressPath: string): Promise<string> {
    if (!existsSync(progressPath)) {
        return '';
    }

    const content = await readFile(progressPath, 'utf-8');
    const patternsHeader = '## Codebase Patterns';
    const headerIndex = content.indexOf(patternsHeader);

    if (headerIndex === -1) {
        return '';
    }

    // Extract from header to the first separator (---)
    const afterHeader = content.substring(headerIndex);
    const separatorIndex = afterHeader.indexOf('\n---');

    if (separatorIndex === -1) {
        return afterHeader.trim();
    }

    return afterHeader.substring(0, separatorIndex).trim();
}

/**
 * Get summary stats from the PRD
 */
export function getPrdStats(prd: PrdJson): { completed: number; total: number } {
    const total = prd.userStories.length;
    const completed = prd.userStories.filter(s => s.passes).length;
    return { completed, total };
}
