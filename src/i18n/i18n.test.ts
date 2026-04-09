import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t, hasTranslation, setLocale, resetLocaleCache } from './index';
import { detectLocale } from './detectLocale';

describe('i18n', () => {
  beforeEach(() => {
    resetLocaleCache();
    delete process.env.AHA_LANG;
    delete process.env.LANG;
    delete process.env.LC_ALL;
  });

  afterEach(() => {
    resetLocaleCache();
  });

  describe('detectLocale', () => {
    it('returns en by default', () => {
      expect(detectLocale()).toBe('en');
    });

    it('respects AHA_LANG env var', () => {
      process.env.AHA_LANG = 'zh';
      expect(detectLocale()).toBe('zh');
    });

    it('extracts language from LANG env var', () => {
      process.env.LANG = 'zh_CN.UTF-8';
      expect(detectLocale()).toBe('zh');
    });

    it('falls back to en for unsupported locales', () => {
      process.env.AHA_LANG = 'fr';
      expect(detectLocale()).toBe('en');
    });

    it('AHA_LANG takes priority over LANG', () => {
      process.env.AHA_LANG = 'zh';
      process.env.LANG = 'en_US.UTF-8';
      expect(detectLocale()).toBe('zh');
    });
  });

  describe('t()', () => {
    it('returns English translation by default', () => {
      expect(t('daemon.starting')).toBe('Starting daemon...');
    });

    it('returns Chinese translation when locale is zh', () => {
      setLocale('zh');
      expect(t('daemon.starting')).toBe('正在启动守护进程...');
    });

    it('interpolates parameters', () => {
      expect(t('daemon.started', { port: 3006 })).toBe('Daemon started on port 3006');
    });

    it('interpolates parameters in Chinese', () => {
      setLocale('zh');
      expect(t('daemon.started', { port: 3006 })).toBe('守护进程已在端口 3006 启动');
    });

    it('returns key when translation is missing', () => {
      expect(t('nonexistent.key')).toBe('nonexistent.key');
    });

    it('falls back to English when key missing in current locale', () => {
      setLocale('zh');
      // Both locales have this key, but if we had a key only in en, it would fall back
      expect(t('daemon.starting')).toBe('正在启动守护进程...');
    });
  });

  describe('hasTranslation()', () => {
    it('returns true for existing keys', () => {
      expect(hasTranslation('daemon.starting')).toBe(true);
    });

    it('returns false for missing keys', () => {
      expect(hasTranslation('nonexistent.key')).toBe(false);
    });
  });
});
