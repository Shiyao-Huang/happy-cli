import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import packageJson from '../package.json'
import { z } from 'zod'

export const DEFAULT_SERVER_URL = 'https://aha-agi.com/api'
export const DEFAULT_WEBAPP_URL = 'https://aha-agi.com/webappv3'
export const DEFAULT_GENOME_HUB_URL = 'https://aha-agi.com/genome'

const persistentCliConfigSchema = z.object({
  serverUrl: z.string().url().optional(),
  webappUrl: z.string().url().optional(),
  /**
   * Enable model selection feature (default: false)
   * When false: use machine's local config (env vars, allows MiniMax/GLM)
   * When true: use model routing system (genome/KV rules)
   */
  enableModelSelection: z.boolean().optional().default(false)
}).passthrough()

export type PersistentCliConfig = z.infer<typeof persistentCliConfigSchema>

function deriveGenomeHubUrl(serverUrl: string): string {
  const normalizedServerUrl = serverUrl.replace(/\/$/, '')
  if (normalizedServerUrl.endsWith('/genome')) {
    return normalizedServerUrl
  }

  if (normalizedServerUrl.endsWith('/api')) {
    return normalizedServerUrl.replace(/\/api$/, '/genome')
  }

  return `${normalizedServerUrl}/genome`
}

export function expandHomePath(path: string): string {
  return path.replace(/^~/, homedir())
}

export function resolveDefaultAhaHomeDir(packageName: string = packageJson.name): string {
  if (packageName === 'cc-aha-cli-v3') {
    return join(homedir(), '.aha-v3')
  }

  return join(homedir(), '.aha')
}

export function resolveAhaHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  packageName: string = packageJson.name
): string {
  if (env.AHA_HOME_DIR) {
    return expandHomePath(env.AHA_HOME_DIR)
  }

  return resolveDefaultAhaHomeDir(packageName)
}

export function resolvePersistentConfigFile(
  env: NodeJS.ProcessEnv = process.env,
  packageName: string = packageJson.name
): string {
  if (env.AHA_CONFIG_FILE) {
    return expandHomePath(env.AHA_CONFIG_FILE)
  }

  return join(resolveAhaHomeDir(env, packageName), 'config.json')
}

export function readPersistentCliConfig(configFile: string): PersistentCliConfig {
  if (!existsSync(configFile)) {
    return persistentCliConfigSchema.parse({})
  }

  const content = readFileSync(configFile, 'utf8')
  const parsed = JSON.parse(content)
  return persistentCliConfigSchema.parse(parsed)
}

export function writePersistentCliConfig(
  configFile: string,
  patch: Partial<PersistentCliConfig>
): PersistentCliConfig {
  let current: Record<string, unknown> = {}

  if (existsSync(configFile)) {
    current = JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown>
  }

  const nextConfig = persistentCliConfigSchema.parse({
    ...current,
    ...patch,
  })

  mkdirSync(dirname(configFile), { recursive: true })
  writeFileSync(configFile, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(configFile, 0o600)
  } catch {
    // Best effort on platforms/filesystems that do not support chmod.
  }

  return nextConfig
}

/**
 * Inject GENOME_HUB_URL into env from AHA_SERVER_URL if not already set.
 * Convention: replace trailing /api with /genome.
 * Call this ONCE at startup — never derive at usage time.
 */
export function injectGenomeHubUrlFromServerUrl(env: NodeJS.ProcessEnv = process.env): void {
  if (env.GENOME_HUB_URL) return
  const serverUrl = env.AHA_SERVER_URL
  if (serverUrl) {
    env.GENOME_HUB_URL = deriveGenomeHubUrl(serverUrl)
  }
}

export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  persistentConfig: PersistentCliConfig = persistentCliConfigSchema.parse({})
): {
  serverUrl: string
  webappUrl: string
  genomeHubUrl: string
} {
  const serverUrl = env.AHA_SERVER_URL || persistentConfig.serverUrl || DEFAULT_SERVER_URL
  return {
    serverUrl,
    webappUrl: env.AHA_WEBAPP_URL || persistentConfig.webappUrl || DEFAULT_WEBAPP_URL,
    genomeHubUrl: env.GENOME_HUB_URL || deriveGenomeHubUrl(serverUrl),
  }
}

/**
 * Read genomeHubPublishKey from the aha settings file (~/.aha/settings.json).
 * Returns empty string if the file is missing or the key is not set.
 */
export function readPublishKeyFromSettings(settingsFile: string): string {
  try {
    if (!existsSync(settingsFile)) return ''
    const raw = readFileSync(settingsFile, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return typeof parsed.genomeHubPublishKey === 'string' ? parsed.genomeHubPublishKey : ''
  } catch {
    return ''
  }
}
