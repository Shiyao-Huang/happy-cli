import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readPersistentCliConfig,
  readPublishKeyFromSettings,
  resolveAhaHomeDir,
  resolvePersistentConfigFile,
  resolveServerConfig
} from '@/configurationResolver'

describe('configurationResolver', () => {
  let tempDir: string | null = null

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('uses a separate default home dir for aha-v3', () => {
    expect(resolveAhaHomeDir({}, 'cc-aha-cli-v3')).toBe(join(homedir(), '.aha-v3'))
  })

  it('uses the classic home dir for non-v3 packages', () => {
    expect(resolveAhaHomeDir({}, 'cc-aha-cli-v2')).toBe(join(homedir(), '.aha'))
  })

  it('resolves the persistent config file from aha home dir', () => {
    expect(resolvePersistentConfigFile({}, 'cc-aha-cli-v3')).toBe(join(homedir(), '.aha-v3', 'config.json'))
  })

  it('reads persistent config values from disk', () => {
    tempDir = mkdtempSync(join(process.cwd(), 'tmp-config-'))
    const configFile = join(tempDir, 'config.json')

    writeFileSync(configFile, JSON.stringify({
      serverUrl: 'http://localhost:3005',
      webappUrl: 'http://localhost:8081'
    }))

    expect(readPersistentCliConfig(configFile)).toEqual({
      serverUrl: 'http://localhost:3005',
      webappUrl: 'http://localhost:8081',
      enableModelSelection: false,
    })
  })

  it('prefers environment variables over persistent config values', () => {
    expect(resolveServerConfig({
      AHA_SERVER_URL: 'http://localhost:3005',
      AHA_WEBAPP_URL: 'http://localhost:8081'
    }, {
      serverUrl: 'https://ahaagi.com/api',
      webappUrl: 'https://ahaagi.com/webappv3',
      enableModelSelection: false,
    })).toEqual({
      serverUrl: 'http://localhost:3005',
      webappUrl: 'http://localhost:8081'
    })
  })

  it('uses ahaagi production defaults when nothing is configured', () => {
    expect(resolveServerConfig({}, { enableModelSelection: false })).toEqual({
      serverUrl: 'https://ahaagi.com/api',
      webappUrl: 'https://ahaagi.com/webappv3'
    })
  })

  describe('readPublishKeyFromSettings', () => {
    it('returns the genomeHubPublishKey from settings.json', () => {
      tempDir = mkdtempSync(join(process.cwd(), 'tmp-settings-'))
      const settingsFile = join(tempDir, 'settings.json')
      writeFileSync(settingsFile, JSON.stringify({ genomeHubPublishKey: 'aha-official-2026' }))
      expect(readPublishKeyFromSettings(settingsFile)).toBe('aha-official-2026')
    })

    it('returns empty string when settings.json is missing', () => {
      expect(readPublishKeyFromSettings('/nonexistent/path/settings.json')).toBe('')
    })

    it('returns empty string when genomeHubPublishKey is absent', () => {
      tempDir = mkdtempSync(join(process.cwd(), 'tmp-settings-'))
      const settingsFile = join(tempDir, 'settings.json')
      writeFileSync(settingsFile, JSON.stringify({ onboardingCompleted: false }))
      expect(readPublishKeyFromSettings(settingsFile)).toBe('')
    })
  })
})
