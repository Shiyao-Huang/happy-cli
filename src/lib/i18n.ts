/**
 * Internationalization (i18n) Module for aha-cli
 *
 * Provides multi-language support for user-facing strings
 * Part of R0d: i18n pass implementation
 *
 * Languages supported:
 * - en: English (default)
 * - zh: 中文 (Chinese)
 */

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// Default language
const DEFAULT_LANG = 'en'

// Supported languages
export type SupportedLanguage = 'en' | 'zh'

// Translation strings
const translations: Record<SupportedLanguage, Record<string, string>> = {
  en: {
    // General
    'app.name': 'Aha CLI',
    'app.description': 'Claude Code wrapper with team collaboration',
    'app.version': 'Version {version}',

    // Commands
    'cmd.auth.description': 'Authentication management',
    'cmd.daemon.description': 'Background service management',
    'cmd.teams.description': 'Team management & adaptive composition',
    'cmd.doctor.description': 'Run diagnostics or cleanup stray processes',
    'cmd.codex.description': 'Start team collaboration mode',

    // Auth messages
    'auth.login.success': 'Authentication successful',
    'auth.login.failed': 'Authentication failed',
    'auth.logout.success': 'Logged out successfully',
    'auth.device_code.title': 'Device Code Authentication',
    'auth.device_code.your_code': 'Your device code: {code}',
    'auth.device_code.expires': 'Expires in {minutes} minutes',
    'auth.device_code.waiting': 'Waiting for verification',
    'auth.device_code.browser_opened': 'Browser opened',
    'auth.device_code.browser_failed': 'Could not open browser automatically',

    // Daemon messages
    'daemon.started': 'Daemon started successfully',
    'daemon.stopped': 'Daemon stopped',
    'daemon.already_running': 'Daemon already running with matching version',
    'daemon.not_running': 'No daemon running',
    'daemon.start_timeout': 'Daemon start timed out after 5s',

    // Error messages
    'error.auth_required': 'Not authenticated. Please run "aha auth login" first.',
    'error.network': 'Network connection failed. Please check your internet.',
    'error.unknown': 'An unexpected error occurred.',
    'error.suggestion': 'Run "aha doctor" for diagnostics',

    // Success messages
    'success.notification_sent': 'Push notification sent successfully!',
    'success.session_created': 'Session created successfully',

    // Help text
    'help.usage': 'Usage:',
    'help.examples': 'Examples:',
    'help.options': 'Options:',
    'help.commands': 'Available Commands:',
    'help.more_info': 'For command-specific help, run:',

    // Status
    'status.working': 'Working...',
    'status.done': 'Done',
    'status.cancelled': 'Cancelled',
  },

  zh: {
    // General
    'app.name': 'Aha CLI',
    'app.description': 'Claude Code 团队协作包装器',
    'app.version': '版本 {version}',

    // Commands
    'cmd.auth.description': '认证管理',
    'cmd.daemon.description': '后台服务管理',
    'cmd.teams.description': '团队管理与自适应组合',
    'cmd.doctor.description': '运行诊断或清理异常进程',
    'cmd.codex.description': '启动团队协作模式',

    // Auth messages
    'auth.login.success': '认证成功',
    'auth.login.failed': '认证失败',
    'auth.logout.success': '已成功登出',
    'auth.device_code.title': '设备码认证',
    'auth.device_code.your_code': '您的设备码: {code}',
    'auth.device_code.expires': '{minutes} 分钟后过期',
    'auth.device_code.waiting': '等待验证',
    'auth.device_code.browser_opened': '浏览器已打开',
    'auth.device_code.browser_failed': '无法自动打开浏览器',

    // Daemon messages
    'daemon.started': '守护进程启动成功',
    'daemon.stopped': '守护进程已停止',
    'daemon.already_running': '守护进程已运行且版本匹配',
    'daemon.not_running': '守护进程未运行',
    'daemon.start_timeout': '守护进程启动超时 (5秒)',

    // Error messages
    'error.auth_required': '未认证。请先运行 "aha auth login"。',
    'error.network': '网络连接失败。请检查您的网络。',
    'error.unknown': '发生意外错误。',
    'error.suggestion': '运行 "aha doctor" 进行诊断',

    // Success messages
    'success.notification_sent': '推送通知发送成功！',
    'success.session_created': '会话创建成功',

    // Help text
    'help.usage': '用法：',
    'help.examples': '示例：',
    'help.options': '选项：',
    'help.commands': '可用命令：',
    'help.more_info': '获取命令详细帮助，请运行：',

    // Status
    'status.working': '工作中...',
    'status.done': '完成',
    'status.cancelled': '已取消',
  }
}

/**
 * Get the current language setting
 * Priority: AHA_LANG env var > settings file > default
 */
export function getCurrentLanguage(): SupportedLanguage {
  // Check environment variable first
  const envLang = process.env.AHA_LANG
  if (envLang === 'zh' || envLang === 'en') {
    return envLang
  }

  // Check for Chinese locale
  const locale = process.env.LANG || process.env.LC_ALL || ''
  if (locale.includes('zh_') || locale.includes('zh-CN') || locale.includes('zh_TW')) {
    return 'zh'
  }

  return DEFAULT_LANG
}

/**
 * Translate a key to the current language
 * @param key - Translation key (e.g., 'auth.login.success')
 * @param params - Optional parameters for string interpolation
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = getCurrentLanguage()
  const translation = translations[lang]?.[key] ?? translations[DEFAULT_LANG][key] ?? key

  if (params) {
    return Object.entries(params).reduce(
      (str, [paramKey, value]) => str.replace(`{${paramKey}}`, String(value)),
      translation
    )
  }

  return translation
}

/**
 * Get all translations for a language
 */
export function getTranslations(lang: SupportedLanguage): Record<string, string> {
  return translations[lang]
}

/**
 * Check if a key exists in translations
 */
export function hasTranslation(key: string): boolean {
  return key in translations[DEFAULT_LANG]
}

// Export for convenience
export const i18n = {
  t,
  getCurrentLanguage,
  getTranslations,
  hasTranslation
}