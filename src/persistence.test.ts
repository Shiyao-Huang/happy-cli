import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockConfiguration = vi.hoisted(() => ({
    ahaHomeDir: '',
    settingsFile: '',
}));

const mockHomeDir = vi.hoisted(() => ({
    value: '',
}));

vi.mock('@/configuration', () => ({
    configuration: mockConfiguration,
}));

vi.mock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return {
        ...actual,
        homedir: () => mockHomeDir.value,
    };
});

import { readSettings } from './persistence';

describe('readSettings', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), 'aha-persistence-'));
        mockHomeDir.value = join(root, 'home');
        mockConfiguration.ahaHomeDir = join(root, '.aha-v3');
        mockConfiguration.settingsFile = join(mockConfiguration.ahaHomeDir, 'settings.json');
        mkdirSync(mockConfiguration.ahaHomeDir, { recursive: true });
        mkdirSync(mockHomeDir.value, { recursive: true });
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('falls back to legacy ~/.aha/settings.json for missing genome-hub fields', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            onboardingCompleted: false,
            machineId: 'v3-machine',
        }));

        const legacyDir = join(mockHomeDir.value, '.aha');
        const legacySettingsFile = join(legacyDir, 'settings.json');

        mkdirSync(legacyDir, { recursive: true });
        writeFileSync(legacySettingsFile, JSON.stringify({
            onboardingCompleted: true,
            genomeHubSshHost: 'wow',
            genomeHubPublishKey: 'legacy-key',
        }));

        try {
            const settings = await readSettings();
            expect(settings.machineId).toBe('v3-machine');
            expect(settings.genomeHubSshHost).toBe('wow');
            expect(settings.genomeHubPublishKey).toBe('legacy-key');
        } finally {
            rmSync(legacySettingsFile, { force: true });
        }
    });

    it('prefers current v3 settings when genome-hub fields are already present', async () => {
        writeFileSync(mockConfiguration.settingsFile, JSON.stringify({
            onboardingCompleted: false,
            genomeHubSshHost: 'v3-wow',
            genomeHubPublishKey: 'v3-key',
        }));

        const settings = await readSettings();
        expect(settings.genomeHubSshHost).toBe('v3-wow');
        expect(settings.genomeHubPublishKey).toBe('v3-key');
    });
});
