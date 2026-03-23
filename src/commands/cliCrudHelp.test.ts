import { describe, it, expect, vi, afterEach } from 'vitest';
import { showAgentsHelp } from './agents';
import { showSessionsHelp } from './sessions';
import { showTasksHelp } from './tasks';
import { showTeamsHelp } from './teams';

describe('CLI CRUD help surfaces', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the new agents command help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showAgentsHelp();

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Aha Agents');
    expect(output).toContain('update');
    expect(output).toContain('archive');
  });

  it('shows the tasks command help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showTasksHelp();

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Aha Tasks');
    expect(output).toContain('create');
    expect(output).toContain('start');
    expect(output).toContain('complete');
  });

  it('shows the expanded teams command help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showTeamsHelp();

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Aha Teams');
    expect(output).toContain('create');
    expect(output).toContain('publish-template');
    expect(output).toContain('add-member');
    expect(output).toContain('batch-delete');
  });

  it('shows the sessions command help', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    showSessionsHelp();

    expect(logSpy).toHaveBeenCalledOnce();
    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain('Aha Sessions');
    expect(output).toContain('list');
    expect(output).toContain('archive');
    expect(output).toContain('delete');
  });
});
