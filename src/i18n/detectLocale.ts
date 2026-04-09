/**
 * Locale detection for aha-cli i18n.
 *
 * Priority chain:
 * 1. AHA_LANG env var (explicit override)
 * 2. LANG / LC_ALL env var (system locale)
 * 3. Intl API (runtime default)
 * 4. Fallback to 'en'
 */

export type SupportedLocale = 'en' | 'zh';

const SUPPORTED_LOCALES: ReadonlySet<string> = new Set(['en', 'zh']);

let cachedLocale: SupportedLocale | null = null;

/**
 * Detect the user's preferred locale from environment.
 * Returns a supported locale code ('en' or 'zh').
 */
export function detectLocale(): SupportedLocale {
  if (cachedLocale) return cachedLocale;

  const raw =
    process.env.AHA_LANG ||
    process.env.LC_ALL ||
    process.env.LANG ||
    tryIntlLocale() ||
    'en';

  const normalized = normalizeLocale(raw);
  cachedLocale = normalized;
  return normalized;
}

/**
 * Override the detected locale (e.g. from user config).
 */
export function setLocale(locale: SupportedLocale): void {
  cachedLocale = locale;
}

/**
 * Reset cached locale (useful for testing).
 */
export function resetLocaleCache(): void {
  cachedLocale = null;
}

function normalizeLocale(raw: string): SupportedLocale {
  // Extract language code: "zh_CN.UTF-8" → "zh", "en-US" → "en"
  const lang = raw.split(/[._-]/)[0]?.toLowerCase() || 'en';
  return SUPPORTED_LOCALES.has(lang) ? (lang as SupportedLocale) : 'en';
}

function tryIntlLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}
