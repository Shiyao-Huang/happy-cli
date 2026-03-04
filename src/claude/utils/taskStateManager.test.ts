import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TaskStateManager } from '@/claude/utils/taskStateManager';
import { ApiClient } from '@/api/api';

describe('TaskStateManager - Task Completion Rating Trigger', () => {
    let apiMock: any;
    let taskManager: TaskStateManager;
    const teamId = 'test-team-123';
    const sessionId = 'session-456';
    const roleId = 'implementer';

    beforeEach(() => {
        apiMock = {
            getArtifact: vi.fn(),
            updateArtifact: vi.fn(),
            createArtifact: vi.fn(),
            listTasks: vi.fn(),
            startTask: vi.fn(),
            completeTask: vi.fn(),
            calculateSystemRating: vi.fn(),
            createRatingRecord: vi.fn(),
            reviewRole: vi.fn(),
            sendTeamMessage: vi.fn(),
        };

        taskManager = new TaskStateManager(apiMock, teamId, sessionId, roleId);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('completeTask with auto-rating', () => {
        it('should trigger system rating when task is completed', async () => {
            const taskId = 'task-789';
            const mockTask = {
                id: taskId,
                title: 'Implement feature X (code-lines: 200, commits: 5)',
                description: 'Bug fixes: 2',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockResolvedValue({
                success: true,
                result: {
                    rating: 4.5,
                    codeScore: 85,
                    qualityScore: 90,
                    breakdown: {
                        codeScore: 85,
                        qualityScore: 90,
                        bugsScore: -5,
                        coverageBonus: 10,
                    },
                },
            });

            apiMock.createRatingRecord.mockResolvedValue({
                rating: {
                    id: 'rating-001',
                    roleId,
                    rating: 4.5,
                },
            });

            const result = await taskManager.completeTask(taskId);

            expect(result.success).toBe(true);
            expect(apiMock.completeTask).toHaveBeenCalledWith(teamId, taskId, sessionId);
            expect(apiMock.calculateSystemRating).toHaveBeenCalled();
            expect(apiMock.createRatingRecord).toHaveBeenCalled();
        });

        it('should derive metrics from task title and description', async () => {
            const taskId = 'task-metrics';
            const mockTask = {
                id: taskId,
                title: 'Update API endpoints (code-lines: 150, commits: 3)',
                description: 'Files changed: 5. Bugs fixed: 1',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockResolvedValue({
                success: true,
                result: {
                    rating: 4.0,
                    codeScore: 70,
                    qualityScore: 85,
                },
            });

            apiMock.createRatingRecord.mockResolvedValue({
                rating: { id: 'rating-002', roleId, rating: 4.0 },
            });

            await taskManager.completeTask(taskId);

            const ratingCall = apiMock.calculateSystemRating.mock.calls[0][0];
            expect(ratingCall.codeLines).toBe(150);
            expect(ratingCall.commits).toBe(3);
            expect(ratingCall.bugsCount).toBe(1);
            expect(ratingCall.filesChanged).toBe(5);
        });

        it('should use fallback to reviewRole if createRatingRecord fails', async () => {
            const taskId = 'task-fallback';
            const mockTask = {
                id: taskId,
                title: 'Test task',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockResolvedValue({
                success: true,
                result: {
                    rating: 3.5,
                    codeScore: 60,
                    qualityScore: 75,
                },
            });

            // Simulate createRatingRecord failure (older API)
            apiMock.createRatingRecord.mockRejectedValue(new Error('API not available'));

            // Fallback should succeed
            apiMock.reviewRole.mockResolvedValue({ success: true });

            const result = await taskManager.completeTask(taskId);

            expect(result.success).toBe(true);
            expect(apiMock.reviewRole).toHaveBeenCalledWith(
                roleId,
                expect.objectContaining({
                    rating: 3.5,
                    source: 'system',
                    teamId,
                })
            );
        });

        it('should handle rating calculation failure gracefully', async () => {
            const taskId = 'task-rating-fail';
            const mockTask = {
                id: taskId,
                title: 'Task with rating error',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockRejectedValue(new Error('Rating service unavailable'));

            // Should not throw - rating failure shouldn't block task completion
            const result = await taskManager.completeTask(taskId);

            expect(result.success).toBe(true);
        });

        it('should estimate metrics when not explicitly provided', async () => {
            const taskId = 'task-estimated';
            const mockTask = {
                id: taskId,
                title: 'Simple task',
                description: 'Description text here',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockResolvedValue({
                success: true,
                result: {
                    rating: 3.0,
                    codeScore: 50,
                    qualityScore: 60,
                },
            });

            apiMock.createRatingRecord.mockResolvedValue({
                rating: { id: 'rating-003', roleId, rating: 3.0 },
            });

            await taskManager.completeTask(taskId);

            const ratingCall = apiMock.calculateSystemRating.mock.calls[0][0];
            // Should have estimated values
            expect(ratingCall.codeLines).toBeGreaterThan(0);
            expect(ratingCall.commits).toBeGreaterThan(0);
            expect(ratingCall.filesChanged).toBeGreaterThan(0);
        });

        it('should include task ID in rating comment', async () => {
            const taskId = 'task-comment-check';
            const mockTask = {
                id: taskId,
                title: 'Task for comment test',
                status: 'done',
                updatedAt: Date.now(),
            };

            apiMock.completeTask.mockResolvedValue({
                success: true,
                task: mockTask,
            });

            apiMock.calculateSystemRating.mockResolvedValue({
                success: true,
                result: { rating: 4.0, codeScore: 75, qualityScore: 80 },
            });

            apiMock.createRatingRecord.mockResolvedValue({
                rating: { id: 'rating-004', roleId, rating: 4.0 },
            });

            await taskManager.completeTask(taskId);

            const ratingRecordCall = apiMock.createRatingRecord.mock.calls[0][0];
            expect(ratingRecordCall.comment).toBe(`auto-task-complete:${taskId}`);
            expect(ratingRecordCall.source).toBe('system');
            expect(ratingRecordCall.taskId).toBe(taskId);
        });
    });
});
