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
 * Load and parse a prd.json file
 */
export async function loadPrd(path: string): Promise<PrdJson> {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as PrdJson;

    if (!parsed.userStories || !Array.isArray(parsed.userStories)) {
        throw new Error(`Invalid prd.json: missing or invalid userStories array`);
    }
    if (!parsed.project || typeof parsed.project !== 'string') {
        throw new Error(`Invalid prd.json: missing project name`);
    }

    return parsed;
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
