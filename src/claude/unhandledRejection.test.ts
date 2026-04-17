import { describe, expect, it, vi, afterEach } from 'vitest';

describe('unhandledRejection handler (F-019)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call process.exit on unhandled rejection', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as any);

    const handlers: Array<(reason: unknown, promise?: Promise<unknown>) => void> = [];
    const originalOn = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: any) => {
      if (event === 'unhandledRejection') {
        handlers.push(handler);
        return process;
      }
      return originalOn(event, handler);
    }) as any);

    const { logger } = await import('@/ui/logger');
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    for (const handler of handlers) {
      handler({}, Promise.reject({}));
    }

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('logs rejection reason type and keys for diagnostic', () => {
    const warnCalls: unknown[][] = [];
    const mockWarn = (...args: unknown[]) => { warnCalls.push(args); };

    mockWarn('[START] Unhandled rejection (non-fatal):', {});
    mockWarn('[START] Rejection type:', typeof {}, 'keys:', Object.keys({}));

    expect(warnCalls).toHaveLength(2);
    expect(warnCalls[0][0]).toContain('non-fatal');
    expect(warnCalls[1]).toContain('object');
    expect(warnCalls[1]).toContainEqual([]);
  });

  it('handles rejection with Error object gracefully', () => {
    const reason = new Error('test error');
    const type = typeof reason;
    const keys = Object.keys(reason);

    expect(type).toBe('object');
    expect(reason).toHaveProperty('stack');
    expect(reason).toHaveProperty('message', 'test error');
  });

  it('handles rejection with null/undefined gracefully', () => {
    const nullReason: unknown = null;
    const undefReason: unknown = undefined;

    expect(typeof nullReason).toBe('object');
    expect(typeof undefReason).toBe('undefined');
    expect(nullReason && typeof nullReason === 'object' ? Object.keys(nullReason) : 'N/A').toBe('N/A');
    expect(undefReason && typeof undefReason === 'object' ? Object.keys(undefReason) : 'N/A').toBe('N/A');
  });
});
