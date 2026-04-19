import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

    it('preserves source model config while disabling noisy runtime features', () => {
        const sourceCodexHome = makeTempDir(`codex-home-source-${Date.now()}`);
        const targetCodexHome = makeTempDir(`codex-home-target-${Date.now()}`);
        const configToml = [
            'model_provider = "packycode"',
            'model = "gpt-5.4"',
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

        const isolatedConfig = readFileSync(join(targetCodexHome, 'config.toml'), 'utf-8');
        expect(existsSync(join(targetCodexHome, 'config.toml'))).toBe(true);
        expect(isolatedConfig).toContain('model_provider = "packycode"');
        expect(isolatedConfig).toContain('model = "gpt-5.4"');
        expect(isolatedConfig).toContain('[model_providers.packycode]');
        expect(isolatedConfig).toContain('plugins = false');
        expect(isolatedConfig).toContain('shell_snapshot = false');
        expect(readFileSync(join(targetCodexHome, 'auth.json'), 'utf-8')).toBe('{"OPENAI_API_KEY":"test"}');
    });

    it('strips marketplace sections and overrides existing feature flags', () => {
        const sourceCodexHome = makeTempDir(`codex-home-source-marketplaces-${Date.now()}`);
        const targetCodexHome = makeTempDir(`codex-home-target-marketplaces-${Date.now()}`);
        const configToml = [
            'model = "gpt-5.4"',
            '',
            '[features]',
            'plugins = true',
            'shell_snapshot = true',
            'fast_mode = true',
            '',
            '[marketplaces.openai-bundled]',
            'source_type = "local"',
            'source = "/tmp/openai-bundled"',
            '',
            '[projects."/Users/copizza/Desktop/happyhere"]',
            'trust_level = "trusted"',
        ].join('\n');

        writeFileSync(join(sourceCodexHome, 'config.toml'), configToml, 'utf-8');

        seedCodexHomeConfig(targetCodexHome, {
            env: {
                ...process.env,
                CODEX_HOME: sourceCodexHome,
            },
        });

        const isolatedConfig = readFileSync(join(targetCodexHome, 'config.toml'), 'utf-8');
        expect(isolatedConfig).toContain('[features]');
        expect(isolatedConfig).toContain('plugins = false');
        expect(isolatedConfig).toContain('shell_snapshot = false');
        expect(isolatedConfig).toContain('fast_mode = true');
        expect(isolatedConfig).toContain('[projects."/Users/copizza/Desktop/happyhere"]');
        expect(isolatedConfig).not.toContain('[marketplaces.openai-bundled]');
        expect(isolatedConfig).not.toContain('plugins = true');
        expect(isolatedConfig).not.toContain('shell_snapshot = true');
    });

    it('copies Codex runtime auth state needed by isolated sessions', () => {
        const sourceCodexHome = makeTempDir(`codex-home-source-state-${Date.now()}`);
        const targetCodexHome = makeTempDir(`codex-home-target-state-${Date.now()}`);

        mkdirSync(join(sourceCodexHome, 'sqlite'), { recursive: true });
        writeFileSync(join(sourceCodexHome, '.codex-global-state.json'), '{"activeAccount":"acct_123"}', 'utf-8');
        writeFileSync(join(sourceCodexHome, 'installation_id'), 'install-123', 'utf-8');
        writeFileSync(join(sourceCodexHome, 'state_5.sqlite'), 'sqlite-main', 'utf-8');
        writeFileSync(join(sourceCodexHome, 'state_5.sqlite-wal'), 'sqlite-wal', 'utf-8');
        writeFileSync(join(sourceCodexHome, 'session_index.jsonl'), '{"session":"abc"}\n', 'utf-8');
        writeFileSync(join(sourceCodexHome, 'sqlite', 'codex-dev.db'), 'sqlite-dev-db', 'utf-8');

        seedCodexHomeConfig(targetCodexHome, {
            env: {
                ...process.env,
                CODEX_HOME: sourceCodexHome,
            },
        });

        expect(readFileSync(join(targetCodexHome, '.codex-global-state.json'), 'utf-8')).toBe('{"activeAccount":"acct_123"}');
        expect(readFileSync(join(targetCodexHome, 'installation_id'), 'utf-8')).toBe('install-123');
        expect(readFileSync(join(targetCodexHome, 'state_5.sqlite'), 'utf-8')).toBe('sqlite-main');
        expect(readFileSync(join(targetCodexHome, 'state_5.sqlite-wal'), 'utf-8')).toBe('sqlite-wal');
        expect(readFileSync(join(targetCodexHome, 'session_index.jsonl'), 'utf-8')).toBe('{"session":"abc"}\n');
        expect(readFileSync(join(targetCodexHome, 'sqlite', 'codex-dev.db'), 'utf-8')).toBe('sqlite-dev-db');
    });
});
