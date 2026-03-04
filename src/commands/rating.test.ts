import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __ratingTestables } from './rating';

function buildApiMock() {
  return {
    getTeamScore: vi.fn(),
    getRatingHistory: vi.fn(),
    getRatingAnalytics: vi.fn(),
    getRoleRatingHistory: vi.fn(),
    listRoleReviews: vi.fn(),
    listRolePool: vi.fn(),
    createRatingRecord: vi.fn(),
    calculateSystemRating: vi.fn(),
  };
}

describe('rating command handlers', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('shows team rating with analytics', async () => {
    const api = buildApiMock();
    api.getTeamScore.mockResolvedValue({
      averageRating: 4.5,
      reviewCount: 3,
      cumulativeCode: 120,
      cumulativeQuality: 260,
      sourceScoreTotals: { user: 6, master: 5, system: 4 },
    });
    api.getRatingHistory.mockResolvedValue({
      total: 1,
      ratings: [
        {
          roleId: 'implementer',
          rating: 5,
          codeLines: 42,
          commits: 3,
          bugsCount: 0,
          createdAt: '2026-02-27T12:00:00.000Z',
        },
      ],
    });
    api.getRatingAnalytics.mockResolvedValue({
      totalRatings: 1,
      averageQualityScore: 91,
      roleBreakdown: [
        {
          roleId: 'implementer',
          averageRating: 5,
          totalRatings: 1,
        },
      ],
    });

    await __ratingTestables.showTeamRating(api as never, ['team', 'team-1', '--analytics', '--limit', '5']);

    expect(api.getTeamScore).toHaveBeenCalledWith('team-1');
    expect(api.getRatingHistory).toHaveBeenCalledWith('team-1', 5);
    expect(api.getRatingAnalytics).toHaveBeenCalledWith('team-1');
  });

  it('shows role rating from team history when --team is provided', async () => {
    const api = buildApiMock();
    api.getRoleRatingHistory.mockResolvedValue({
      total: 1,
      ratings: [
        {
          rating: 4,
          source: 'system',
          qualityScore: 88,
          createdAt: '2026-02-27T12:00:00.000Z',
        },
      ],
    });

    await __ratingTestables.showRoleRating(api as never, ['role', 'architect', '--team', 'team-1', '--limit', '3']);

    expect(api.getRoleRatingHistory).toHaveBeenCalledWith('team-1', 'architect', 3);
    expect(api.listRoleReviews).not.toHaveBeenCalled();
  });

  it('shows role rating from role reviews without --team', async () => {
    const api = buildApiMock();
    api.listRoleReviews.mockResolvedValue({
      total: 1,
      reviews: [
        {
          rating: 5,
          source: 'master',
          codeScore: 92,
          qualityScore: 94,
          createdAt: '2026-02-27T12:00:00.000Z',
        },
      ],
    });

    await __ratingTestables.showRoleRating(api as never, ['role', 'architect', '--limit', '10']);

    expect(api.listRoleReviews).toHaveBeenCalledWith('architect', 10);
    expect(api.getRoleRatingHistory).not.toHaveBeenCalled();
  });

  it('shows leaderboard with search and limit filters', async () => {
    const api = buildApiMock();
    api.listRolePool.mockResolvedValue({
      total: 1,
      roles: [
        {
          id: 'architect',
          title: 'Architect',
          stats: { averageRating: 4.2, reviewCount: 7 },
        },
      ],
    });

    await __ratingTestables.showLeaderboard(api as never, ['leaderboard', '--limit', '1', '--search', 'arch']);

    expect(api.listRolePool).toHaveBeenCalledWith(1, 'arch');
  });

  it('submits rating payload with parsed numeric options', async () => {
    const api = buildApiMock();
    api.createRatingRecord.mockResolvedValue({
      rating: {
        id: 'rating-1',
        roleId: 'implementer',
        rating: 4,
      },
    });

    await __ratingTestables.submitRating(api as never, [
      'submit',
      '--team', 'team-1',
      '--role', 'implementer',
      '--task', 'task-1',
      '--rating', '4',
      '--user', '5',
      '--master', '4',
      '--system', '3',
      '--code-lines', '120',
      '--commits', '8',
      '--bugs', '1',
      '--quality', '90',
      '--source', 'master',
      '--comment', 'solid-delivery',
    ]);

    expect(api.createRatingRecord).toHaveBeenCalledWith({
      teamId: 'team-1',
      roleId: 'implementer',
      taskId: 'task-1',
      rating: 4,
      userRating: 5,
      masterRating: 4,
      systemRating: 3,
      codeLines: 120,
      commits: 8,
      bugsCount: 1,
      qualityScore: 90,
      source: 'master',
      comment: 'solid-delivery',
    });
  });

  it('runs auto rating with persist flag', async () => {
    const api = buildApiMock();
    api.calculateSystemRating.mockResolvedValue({
      result: {
        rating: 4,
        codeScore: 87,
        qualityScore: 89,
      },
      persisted: true,
    });

    await __ratingTestables.runAutoRating(api as never, [
      'auto',
      '--role', 'implementer',
      '--team', 'team-1',
      '--task', 'task-2',
      '--code-lines', '220',
      '--commits', '11',
      '--bugs', '2',
      '--files-changed', '14',
      '--review-comments', '6',
      '--coverage', '82',
      '--persist',
    ]);

    expect(api.calculateSystemRating).toHaveBeenCalledWith({
      roleId: 'implementer',
      teamId: 'team-1',
      taskId: 'task-2',
      codeLines: 220,
      commits: 11,
      bugsCount: 2,
      filesChanged: 14,
      reviewComments: 6,
      testCoverage: 82,
      persist: true,
    });
  });

  it('rejects invalid source values', () => {
    expect(() => __ratingTestables.parseSourceOption(['submit', '--source', 'bot'])).toThrow(
      '--source must be one of: user, master, system'
    );
  });
});
