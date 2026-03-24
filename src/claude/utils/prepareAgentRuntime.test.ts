import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

import { prepareAgentRuntime } from './prepareAgentRuntime';

const originalEnv = process.env;

describe('prepareAgentRuntime', () => {
    beforeEach(() => {
        process.env = { ...originalEnv };
        delete process.env.AHA_TEST_REQUIRED;
        delete process.env.AHA_TEST_OPTIONAL;
        delete process.env.AHA_TEST_MISSING;
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('materializes env contract with launch override precedence', () => {
        process.env.AHA_TEST_OPTIONAL = 'optional-process';

        const prep = prepareAgentRuntime({
            envRequired: ['AHA_TEST_REQUIRED', 'AHA_TEST_MISSING'],
            envOptional: ['AHA_TEST_OPTIONAL'],
            envOverrides: {
                AHA_TEST_REQUIRED: 'from-override',
                AHA_TEST_EXTRA: 'extra-only',
            },
        });

        expect(prep.envFilePath).not.toBeNull();
        expect(prep.envVars).toEqual({
            AHA_TEST_REQUIRED: 'from-override',
            AHA_TEST_OPTIONAL: 'optional-process',
            AHA_TEST_EXTRA: 'extra-only',
        });
        expect(prep.build.missingRequiredEnv).toEqual(['AHA_TEST_MISSING']);
        expect(prep.build.warnings).toEqual([]);

        const payload = JSON.parse(readFileSync(prep.envFilePath!, 'utf-8'));
        expect(payload.required).toEqual(['AHA_TEST_REQUIRED', 'AHA_TEST_MISSING']);
        expect(payload.optional).toEqual(['AHA_TEST_OPTIONAL']);
        expect(payload.values).toEqual(prep.envVars);
        expect(payload.sources).toEqual({
            AHA_TEST_REQUIRED: 'launchOverride',
            AHA_TEST_OPTIONAL: 'processEnv',
            AHA_TEST_EXTRA: 'launchOverride',
        });
        expect(payload.missingRequired).toEqual(['AHA_TEST_MISSING']);

        prep.cleanup();
        expect(existsSync(prep.envFilePath!)).toBe(false);
    });

    it('cleans up both hooks settings and env files', () => {
        const prep = prepareAgentRuntime({
            hooks: {
                stop: [
                    {
                        command: 'echo done',
                    },
                ],
            },
            envOverrides: {
                AHA_TEST_REQUIRED: 'value',
            },
        });

        expect(prep.settingsPath).not.toBeNull();
        expect(prep.envFilePath).not.toBeNull();
        expect(prep.build.artifacts.settingsPath).toBe(prep.settingsPath);
        expect(prep.build.artifacts.envFilePath).toBe(prep.envFilePath);
        expect(existsSync(prep.settingsPath!)).toBe(true);
        expect(existsSync(prep.envFilePath!)).toBe(true);

        prep.cleanup();

        expect(existsSync(prep.settingsPath!)).toBe(false);
        expect(existsSync(prep.envFilePath!)).toBe(false);
    });
});
