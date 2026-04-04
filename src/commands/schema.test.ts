import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSchemaCommand } from './schema';
import { buildCliSchemaDocument, resolveCliSchema } from './schemaRegistry';

describe('schema command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves top-level aliases', () => {
    const node = resolveCliSchema(['team']);
    expect(node?.name).toBe('teams');
  });

  it('builds a focused schema document for a nested command path', () => {
    const document = buildCliSchemaDocument(['teams', 'status']) as {
      found: boolean;
      command: { name: string; usage: string };
    };

    expect(document.found).toBe(true);
    expect(document.command.name).toBe('status');
    expect(document.command.usage).toContain('aha teams status');
  });

  it('exposes dry-run support for destructive commands', () => {
    const document = buildCliSchemaDocument(['teams', 'delete']) as {
      found: boolean;
      command: { supportsDryRun?: boolean; flags?: Array<{ name: string }> };
    };

    expect(document.found).toBe(true);
    expect(document.command.supportsDryRun).toBe(true);
    expect(document.command.flags).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: '--dry-run' }),
      ]),
    );
  });

  it('prints full schema JSON with --all', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await handleSchemaCommand(['--all']);

    expect(writeSpy).toHaveBeenCalled();
    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    expect(output).toContain('"schemaVersion": "aha-cli-schema-v1"');
    expect(output).toContain('"name": "teams"');
  });
});
