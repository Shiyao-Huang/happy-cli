import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  readPersistentCliConfig,
  readPublishKeyFromSettings,
  resolveAhaHomeDir,
  resolvePersistentConfigFile,
  resolveServerConfig,
  injectGenomeHubUrlFromServerUrl,
  writePersistentCliConfig,
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

  it('writes persistent config values while preserving unrelated settings', () => {
    tempDir = mkdtempSync(join(process.cwd(), 'tmp-config-'))
    const configFile = join(tempDir, 'nested', 'config.json')

    writePersistentCliConfig(configFile, {
      serverUrl: 'https://ahaagi.com/api',
      webappUrl: 'https://ahaagi.com/webappv3',
    })

    writePersistentCliConfig(configFile, {
      serverUrl: 'https://aha-agi.com/api',
    })

    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
      serverUrl: 'https://aha-agi.com/api',
      webappUrl: 'https://ahaagi.com/webappv3',
      enableModelSelection: false,
    })
  })

  it('prefers environment variables over persistent config values', () => {
    expect(resolveServerConfig({
      AHA_SERVER_URL: 'http://localhost:3005',
      AHA_WEBAPP_URL: 'http://localhost:8081'
    }, {
      serverUrl: 'https://aha-agi.com/api',
      webappUrl: 'https://aha-agi.com/webappv3',
      enableModelSelection: false,
    })).toEqual({
      serverUrl: 'http://localhost:3005',
      webappUrl: 'http://localhost:8081',
      genomeHubUrl: 'http://localhost:3005/genome',
    })
  })

  it('uses aha-agi production defaults when nothing is configured', () => {
    expect(resolveServerConfig({}, { enableModelSelection: false })).toEqual({
      serverUrl: 'https://aha-agi.com/api',
      webappUrl: 'https://aha-agi.com/webappv3',
      genomeHubUrl: 'https://aha-agi.com/genome',
    })
  })

  it('derives genomeHubUrl from AHA_SERVER_URL: /api → /genome', () => {
    expect(resolveServerConfig({
      AHA_SERVER_URL: 'https://aha-agi.com/api',
    }, { enableModelSelection: false })).toEqual({
      serverUrl: 'https://aha-agi.com/api',
      webappUrl: 'https://aha-agi.com/webappv3',
      genomeHubUrl: 'https://aha-agi.com/genome',
    })
  })

  it('prefers explicit GENOME_HUB_URL over AHA_SERVER_URL derivation', () => {
    expect(resolveServerConfig({
      AHA_SERVER_URL: 'https://aha-agi.com/api',
      GENOME_HUB_URL: 'https://custom-hub.com/v2',
    }, { enableModelSelection: false })).toEqual({
      serverUrl: 'https://aha-agi.com/api',
      webappUrl: 'https://aha-agi.com/webappv3',
      genomeHubUrl: 'https://custom-hub.com/v2',
    })
  })

  describe('injectGenomeHubUrlFromServerUrl', () => {
    it('injects GENOME_HUB_URL from AHA_SERVER_URL: /api → /genome', () => {
      const env: Record<string, string> = { AHA_SERVER_URL: 'https://aha-agi.com/api' }
      injectGenomeHubUrlFromServerUrl(env)
      expect(env.GENOME_HUB_URL).toBe('https://aha-agi.com/genome')
    })

    it('does not overwrite existing GENOME_HUB_URL', () => {
      const env: Record<string, string> = {
        AHA_SERVER_URL: 'https://aha-agi.com/api',
        GENOME_HUB_URL: 'https://custom.com/v2',
      }
      injectGenomeHubUrlFromServerUrl(env)
      expect(env.GENOME_HUB_URL).toBe('https://custom.com/v2')
    })

    it('does nothing when neither is set', () => {
      const env: Record<string, string> = {}
      injectGenomeHubUrlFromServerUrl(env)
      expect(env.GENOME_HUB_URL).toBeUndefined()
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
