/**
 * Lightweight i18n module for aha-cli.
 *
 * Usage:
 *   import { t } from '@/i18n';
 *   console.log(t('daemon.started', { port: 3006 }));
 *
 * Locale detection is automatic (see detectLocale.ts).
 * Override with AHA_LANG=zh or setLocale('zh').
 */

import { detectLocale, type SupportedLocale } from './detectLocale';
import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh.json' with { type: 'json' };

export { detectLocale, setLocale, resetLocaleCache } from './detectLocale';
export type { SupportedLocale } from './detectLocale';

type LocaleMessages = Record<string, string>;

const locales: Record<SupportedLocale, LocaleMessages> = { en, zh };

/**
 * Translate a key to the current locale.
 *
 * @param key - Dot-namespaced key, e.g. 'daemon.started'
 * @param params - Optional interpolation params, e.g. { port: 3006 }
 * @returns Translated string, or the key itself if not found
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const locale = detectLocale();
  let text = locales[locale]?.[key] || locales.en[key] || key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }

  return text;
}

/**
 * Check if a translation key exists in the current locale.
 */
export function hasTranslation(key: string): boolean {
  const locale = detectLocale();
  return key in (locales[locale] || {}) || key in locales.en;
}
