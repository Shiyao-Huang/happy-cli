import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

export function resolveServerConfig(
  env: NodeJS.ProcessEnv = process.env,
  persistentConfig: PersistentCliConfig = persistentCliConfigSchema.parse({})
): {
  serverUrl: string
  webappUrl: string
} {
  return {
    serverUrl: env.AHA_SERVER_URL || persistentConfig.serverUrl || DEFAULT_SERVER_URL,
    webappUrl: env.AHA_WEBAPP_URL || persistentConfig.webappUrl || DEFAULT_WEBAPP_URL
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
