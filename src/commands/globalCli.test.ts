import { afterEach, describe, expect, it, vi } from 'vitest';
import { CliCommandError, confirmPrompt, normalizeGlobalCliArgs, printCliDryRunPreview } from './globalCli';

describe('globalCli', () => {
  afterEach(() => {
    delete process.env.AHA_NO_INTERACTIVE;
    vi.restoreAllMocks();
  });

  it('normalizes --format json into --json', () => {
    expect(normalizeGlobalCliArgs(['teams', 'list', '--format', 'json'])).toEqual([
      'teams',
      'list',
      '--json',
    ]);
  });

  it('strips --format table while keeping human mode', () => {
    expect(normalizeGlobalCliArgs(['teams', 'list', '--format', 'table'])).toEqual([
      'teams',
      'list',
    ]);
  });

  it('enables non-interactive mode and strips the flag', () => {
    expect(normalizeGlobalCliArgs(['teams', 'delete', 'team-1', '--no-interactive'])).toEqual([
      'teams',
      'delete',
      'team-1',
    ]);
    expect(process.env.AHA_NO_INTERACTIVE).toBe('1');
  });

  it('rejects unsupported formats', () => {
    expect(() => normalizeGlobalCliArgs(['teams', 'list', '--format', 'yaml'])).toThrow(CliCommandError);
  });

  it('fails fast on confirmPrompt in non-interactive mode', async () => {
    process.env.AHA_NO_INTERACTIVE = '1';

    await expect(confirmPrompt('Delete?', { forceFlagName: '--force' })).rejects.toMatchObject({
      code: 'INTERACTIVE_REQUIRED',
      exitCode: 2,
      hint: expect.stringContaining('--force'),
    });
  });

  it('prints structured dry-run previews in json mode', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    printCliDryRunPreview(
      {
        action: 'teams.delete',
        summary: 'Would delete team team-1.',
        target: { teamId: 'team-1' },
      },
      { asJson: true },
    );

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(output).toContain('"dryRun": true');
    expect(output).toContain('"action": "teams.delete"');
    expect(output).toContain('"teamId": "team-1"');
  });
});
