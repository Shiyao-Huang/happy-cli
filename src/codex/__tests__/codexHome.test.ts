import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { seedCodexHomeConfig } from '../codexHome';

describe('seedCodexHomeConfig', () => {
    const tempDirs: string[] = [];

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    function makeTempDir(prefix: string): string {
        const dir = mkdtempSync(join(os.tmpdir(), prefix));
        tempDirs.push(dir);
        return dir;
    }

    it('copies config.toml from the source Codex home into the isolated home', () => {
        const sourceCodexHome = makeTempDir(`codex-home-source-${Date.now()}`);
        const targetCodexHome = makeTempDir(`codex-home-target-${Date.now()}`);
        const configToml = [
            'model_provider = "packycode"',
            '',
            '[model_providers.packycode]',
            'name = "packycode"',
            'base_url = "http://127.0.0.1:15721/v1"',
        ].join('\n');

        writeFileSync(join(sourceCodexHome, 'config.toml'), configToml, 'utf-8');
        writeFileSync(join(sourceCodexHome, 'auth.json'), '{"OPENAI_API_KEY":"test"}', 'utf-8');

        seedCodexHomeConfig(targetCodexHome, {
            env: {
                ...process.env,
                CODEX_HOME: sourceCodexHome,
            },
        });

        expect(existsSync(join(targetCodexHome, 'config.toml'))).toBe(true);
        expect(readFileSync(join(targetCodexHome, 'config.toml'), 'utf-8')).toBe(configToml);
        expect(readFileSync(join(targetCodexHome, 'auth.json'), 'utf-8')).toBe('{"OPENAI_API_KEY":"test"}');
    });
});
