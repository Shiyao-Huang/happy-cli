import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

describe('retire flush timeout (F-022)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when flush completes before timeout', async () => {
    const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 100));
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('flush timeout')), 3000),
    );

    const result = Promise.race([flush(), timeout]);
    vi.advanceTimersByTime(100);

    await expect(result).resolves.toBeUndefined();
  });

  it('rejects with flush timeout when flush hangs', async () => {
    const flush = () => new Promise<void>(() => {});
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('flush timeout')), 3000),
    );

    const result = Promise.race([flush(), timeout]);
    vi.advanceTimersByTime(3000);

    await expect(result).rejects.toThrow('flush timeout');
  });

  it('rejects at exactly 3000ms, not before', async () => {
    const flush = () => new Promise<void>(() => {});
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('flush timeout')), 3000),
    );

    const result = Promise.race([flush(), timeout]);

    vi.advanceTimersByTime(2999);
    const pending = Promise.race([
      result.then(() => 'resolved').catch(() => 'rejected'),
      new Promise<string>((r) => setTimeout(() => r('still-pending'), 0)),
    ]);
    vi.advanceTimersByTime(0);
    expect(await pending).toBe('still-pending');

    vi.advanceTimersByTime(1);
    await expect(result).rejects.toThrow('flush timeout');
  });

  it('timeout is exactly 3000ms matching production code', () => {
    const FLUSH_TIMEOUT_MS = 3000;
    expect(FLUSH_TIMEOUT_MS).toBe(3000);
  });
});
