import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPrd, savePrd, getNextStory, markStoryComplete, appendProgress, getCodebasePatterns, getPrdStats } from './prdManager';
import type { PrdJson, UserStory } from './types';

const TEST_DIR = join(tmpdir(), 'ralph-test-' + process.pid);
const PRD_PATH = join(TEST_DIR, 'prd.json');
const PROGRESS_PATH = join(TEST_DIR, 'progress.txt');

function makePrd(overrides: Partial<PrdJson> = {}): PrdJson {
    return {
        project: 'TestProject',
        branchName: 'ralph/test',
        description: 'Test PRD',
        userStories: [
            {
                id: 'US-001',
                title: 'First story',
                description: 'Implement first feature',
                acceptanceCriteria: ['Typecheck passes'],
                priority: 1,
                passes: false,
                notes: '',
            },
            {
                id: 'US-002',
                title: 'Second story',
                description: 'Implement second feature',
                acceptanceCriteria: ['Tests pass'],
                priority: 2,
                passes: false,
                notes: '',
            },
            {
                id: 'US-003',
                title: 'Third story',
                description: 'Implement third feature',
                acceptanceCriteria: ['Build passes'],
                priority: 3,
                passes: true,
                notes: 'Already done',
            },
        ],
        ...overrides,
    };
}

describe('prdManager', () => {
    beforeEach(async () => {
        await mkdir(TEST_DIR, { recursive: true });
    });

    afterEach(async () => {
        await rm(TEST_DIR, { recursive: true, force: true });
    });

    describe('loadPrd', () => {
        it('should load a valid prd.json', async () => {
            const prd = makePrd();
            await writeFile(PRD_PATH, JSON.stringify(prd, null, 2));

            const loaded = await loadPrd(PRD_PATH);

            expect(loaded.project).toBe('TestProject');
            expect(loaded.userStories).toHaveLength(3);
        });

        it('should throw on missing userStories', async () => {
            await writeFile(PRD_PATH, JSON.stringify({ project: 'Test' }));

            await expect(loadPrd(PRD_PATH)).rejects.toThrow('missing or invalid userStories');
        });

        it('should throw on missing project name', async () => {
            await writeFile(PRD_PATH, JSON.stringify({ userStories: [] }));

            await expect(loadPrd(PRD_PATH)).rejects.toThrow('missing project name');
        });

        it('should throw on non-existent file', async () => {
            await expect(loadPrd(join(TEST_DIR, 'nonexistent.json'))).rejects.toThrow();
        });

        it('should throw on invalid JSON', async () => {
            await writeFile(PRD_PATH, 'not json');

            await expect(loadPrd(PRD_PATH)).rejects.toThrow();
        });

        // ─── Project format normalization tests ──────────────
        it('should normalize project-format PRD (tasks[] + projectName)', async () => {
            const projectPrd = {
                projectName: 'Aha Project',
                tasks: [
                    { id: 'task-001', title: 'First task', description: 'Do thing', passes: false, priority: 'high' },
                    { id: 'task-002', title: 'Second task', description: 'Do other', passes: true, priority: 'medium' },
                ],
                metadata: { branch: 'dev-1119' },
            };
            await writeFile(PRD_PATH, JSON.stringify(projectPrd, null, 2));

            const loaded = await loadPrd(PRD_PATH);

            expect(loaded.project).toBe('Aha Project');
            expect(loaded.branchName).toBe('dev-1119');
            expect(loaded.userStories).toHaveLength(2);
            expect(loaded.userStories[0].id).toBe('task-001');
            expect(loaded.userStories[0].passes).toBe(false);
            expect(loaded.userStories[1].passes).toBe(true);
        });

        it('should convert string priority to numeric in project format', async () => {
            const projectPrd = {
                projectName: 'Test',
                tasks: [
                    { id: 't-1', title: 'High', description: '', passes: false, priority: 'high' },
                    { id: 't-2', title: 'Med', description: '', passes: false, priority: 'medium' },
                    { id: 't-3', title: 'Low', description: '', passes: false, priority: 'low' },
                ],
            };
            await writeFile(PRD_PATH, JSON.stringify(projectPrd, null, 2));

            const loaded = await loadPrd(PRD_PATH);

            expect(loaded.userStories[0].priority).toBe(1); // high
            expect(loaded.userStories[1].priority).toBe(2); // medium
            expect(loaded.userStories[2].priority).toBe(3); // low
        });

        it('should throw on empty tasks array in project format', async () => {
            const projectPrd = { projectName: 'Empty', tasks: [] };
            await writeFile(PRD_PATH, JSON.stringify(projectPrd, null, 2));

            await expect(loadPrd(PRD_PATH)).rejects.toThrow('tasks array is empty');
        });

        it('should handle project format with missing optional fields', async () => {
            const projectPrd = {
                projectName: 'Minimal',
                tasks: [
                    { id: 'min-1', title: 'Minimal task', passes: false },
                ],
            };
            await writeFile(PRD_PATH, JSON.stringify(projectPrd, null, 2));

            const loaded = await loadPrd(PRD_PATH);

            expect(loaded.project).toBe('Minimal');
            expect(loaded.branchName).toBe('');
            expect(loaded.userStories[0].description).toBe('');
            expect(loaded.userStories[0].acceptanceCriteria).toEqual([]);
        });

        it('should load actual .aha/prd.json format', async () => {
            // Replica of the real .aha/prd.json structure
            const realPrd = {
                projectName: 'Aha Ralph Loop Integration',
                version: '1.0.0',
                tasks: [
                    { id: 'task-001', title: 'Brand rename', passes: true, priority: 'high', dependencies: [] },
                    { id: 'task-002', title: 'Project structure', passes: true, priority: 'high', dependencies: [] },
                    { id: 'task-003', title: 'Core loop', passes: false, priority: 'high', dependencies: ['task-002'] },
                ],
                metadata: { repository: '/Users/swmt/happy', branch: 'dev-1119', mainBranch: 'main' },
            };
            await writeFile(PRD_PATH, JSON.stringify(realPrd, null, 2));

            const loaded = await loadPrd(PRD_PATH);

            expect(loaded.project).toBe('Aha Ralph Loop Integration');
            expect(loaded.branchName).toBe('dev-1119');
            expect(loaded.userStories).toHaveLength(3);
            expect(loaded.userStories[0].passes).toBe(true);
            expect(loaded.userStories[2].passes).toBe(false);
        });
    });

    describe('savePrd', () => {
        it('should save prd.json with trailing newline', async () => {
            const prd = makePrd();

            await savePrd(PRD_PATH, prd);

            const raw = await readFile(PRD_PATH, 'utf-8');
            expect(raw.endsWith('\n')).toBe(true);

            const parsed = JSON.parse(raw);
            expect(parsed.project).toBe('TestProject');
        });
    });

    describe('getNextStory', () => {
        it('should return highest priority incomplete story', () => {
            const prd = makePrd();

            const next = getNextStory(prd);

            expect(next).not.toBeNull();
            expect(next!.id).toBe('US-001');
            expect(next!.priority).toBe(1);
        });

        it('should skip completed stories', () => {
            const prd = makePrd({
                userStories: [
                    { id: 'US-001', title: 'Done', description: '', acceptanceCriteria: [], priority: 1, passes: true, notes: '' },
                    { id: 'US-002', title: 'Not done', description: '', acceptanceCriteria: [], priority: 2, passes: false, notes: '' },
                ],
            });

            const next = getNextStory(prd);

            expect(next!.id).toBe('US-002');
        });

        it('should return null when all stories complete', () => {
            const prd = makePrd({
                userStories: [
                    { id: 'US-001', title: 'Done', description: '', acceptanceCriteria: [], priority: 1, passes: true, notes: '' },
                ],
            });

            const next = getNextStory(prd);

            expect(next).toBeNull();
        });

        it('should return null for empty stories array', () => {
            const prd = makePrd({ userStories: [] });

            const next = getNextStory(prd);

            expect(next).toBeNull();
        });

        it('should sort by priority (lowest number first)', () => {
            const prd = makePrd({
                userStories: [
                    { id: 'US-HIGH', title: 'High', description: '', acceptanceCriteria: [], priority: 3, passes: false, notes: '' },
                    { id: 'US-LOW', title: 'Low', description: '', acceptanceCriteria: [], priority: 1, passes: false, notes: '' },
                    { id: 'US-MED', title: 'Med', description: '', acceptanceCriteria: [], priority: 2, passes: false, notes: '' },
                ],
            });

            const next = getNextStory(prd);

            expect(next!.id).toBe('US-LOW');
        });
    });

    describe('markStoryComplete', () => {
        it('should mark a story as complete', async () => {
            const prd = makePrd();
            await writeFile(PRD_PATH, JSON.stringify(prd, null, 2));

            await markStoryComplete(PRD_PATH, 'US-001', 'Implemented feature');

            const updated = await loadPrd(PRD_PATH);
            const story = updated.userStories.find(s => s.id === 'US-001');
            expect(story!.passes).toBe(true);
            expect(story!.notes).toBe('Implemented feature');
        });

        it('should not modify other stories', async () => {
            const prd = makePrd();
            await writeFile(PRD_PATH, JSON.stringify(prd, null, 2));

            await markStoryComplete(PRD_PATH, 'US-001', 'Done');

            const updated = await loadPrd(PRD_PATH);
            const us002 = updated.userStories.find(s => s.id === 'US-002');
            expect(us002!.passes).toBe(false);
        });

        it('should throw for non-existent story ID', async () => {
            const prd = makePrd();
            await writeFile(PRD_PATH, JSON.stringify(prd, null, 2));

            await expect(markStoryComplete(PRD_PATH, 'US-999', 'notes')).rejects.toThrow('not found');
        });
    });

    describe('appendProgress', () => {
        it('should create file with header if not exists', async () => {
            await appendProgress(PROGRESS_PATH, 'First entry');

            const content = await readFile(PROGRESS_PATH, 'utf-8');
            expect(content).toContain('## Codebase Patterns');
            expect(content).toContain('First entry');
        });

        it('should append to existing file', async () => {
            await appendProgress(PROGRESS_PATH, 'Entry 1');
            await appendProgress(PROGRESS_PATH, 'Entry 2');

            const content = await readFile(PROGRESS_PATH, 'utf-8');
            expect(content).toContain('Entry 1');
            expect(content).toContain('Entry 2');
        });

        it('should add separator between entries', async () => {
            await appendProgress(PROGRESS_PATH, 'Entry 1');

            const content = await readFile(PROGRESS_PATH, 'utf-8');
            expect(content).toContain('---');
        });
    });

    describe('getCodebasePatterns', () => {
        it('should return empty string if file not exists', async () => {
            const result = await getCodebasePatterns(join(TEST_DIR, 'missing.txt'));

            expect(result).toBe('');
        });

        it('should extract Codebase Patterns section', async () => {
            const content = `## Codebase Patterns\n- Pattern A\n- Pattern B\n---\n\nSome entry`;
            await writeFile(PROGRESS_PATH, content);

            const result = await getCodebasePatterns(PROGRESS_PATH);

            expect(result).toContain('Pattern A');
            expect(result).toContain('Pattern B');
        });

        it('should return empty for file without patterns section', async () => {
            await writeFile(PROGRESS_PATH, 'Just a regular entry\nNo patterns here');

            const result = await getCodebasePatterns(PROGRESS_PATH);

            expect(result).toBe('');
        });
    });

    describe('getPrdStats', () => {
        it('should count completed and total', () => {
            const prd = makePrd();

            const stats = getPrdStats(prd);

            expect(stats.total).toBe(3);
            expect(stats.completed).toBe(1); // US-003 is passes: true
        });

        it('should handle all complete', () => {
            const prd = makePrd({
                userStories: [
                    { id: 'US-001', title: 'Done', description: '', acceptanceCriteria: [], priority: 1, passes: true, notes: '' },
                ],
            });

            const stats = getPrdStats(prd);

            expect(stats.completed).toBe(1);
            expect(stats.total).toBe(1);
        });

        it('should handle empty stories', () => {
            const prd = makePrd({ userStories: [] });

            const stats = getPrdStats(prd);

            expect(stats.completed).toBe(0);
            expect(stats.total).toBe(0);
        });
    });
});
