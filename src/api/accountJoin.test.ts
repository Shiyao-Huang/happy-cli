import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPost = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    post: mockPost,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    serverUrl: 'https://aha-agi.test',
  },
}));

import { createAccountJoinTicket } from './accountJoin';

describe('createAccountJoinTicket', () => {
  beforeEach(() => {
    mockPost.mockReset();
  });

  it('calls the authenticated join-ticket endpoint and returns the ticket', async () => {
    mockPost.mockResolvedValue({
      data: {
        ticket: 'aha_join_abc123',
        expiresAt: '2026-04-02T12:34:56.000Z',
      },
    });

    await expect(createAccountJoinTicket('token-123')).resolves.toEqual({
      ticket: 'aha_join_abc123',
      expiresAt: '2026-04-02T12:34:56.000Z',
    });

    expect(mockPost).toHaveBeenCalledWith(
      'https://aha-agi.test/v1/account/join-ticket',
      {},
      {
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        },
      },
    );
  });

  it('accepts legacy joinTicket field names for compatibility', async () => {
    mockPost.mockResolvedValue({
      data: {
        joinTicket: 'aha_join_legacy',
      },
    });

    await expect(createAccountJoinTicket('token-123')).resolves.toEqual({
      ticket: 'aha_join_legacy',
      expiresAt: null,
    });
  });

  it('throws when the server response is missing a ticket', async () => {
    mockPost.mockResolvedValue({
      data: {
        expiresAt: '2026-04-02T12:34:56.000Z',
      },
    });

    await expect(createAccountJoinTicket('token-123')).rejects.toThrow('Server did not return a join ticket');
  });
});
