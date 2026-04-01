import { afterEach, describe, expect, it } from 'vitest';
import { withWindowsHide } from '@/utils/windowsProcessOptions';

describe('withWindowsHide', () => {
    const originalPlatform = process.platform;

    afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('injects windowsHide on Windows when not explicitly set', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });

        expect(withWindowsHide({ stdio: 'pipe' })).toEqual({
            stdio: 'pipe',
            windowsHide: true,
        });
    });

    it('preserves explicit windowsHide values', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });

        expect(withWindowsHide({ stdio: 'pipe', windowsHide: false })).toEqual({
            stdio: 'pipe',
            windowsHide: false,
        });
    });

    it('keeps non-Windows options unchanged', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' });

        expect(withWindowsHide({ stdio: 'pipe' })).toEqual({
            stdio: 'pipe',
        });
    });
});
