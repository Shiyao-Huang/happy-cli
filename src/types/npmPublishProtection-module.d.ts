declare module '../../scripts/lib/npmPublishProtection.mjs' {
  export type PublishProtectionMode = 'none' | 'obfuscate'

  export interface PublishProtectionPolicy {
    enabled: boolean
    mode: PublishProtectionMode
  }

  export interface PublishProtectionEnv {
    AHA_NPM_PUBLISH_ENCRYPTION?: string | undefined
    [key: string]: string | undefined
  }

  export interface ProtectPublishArtifactsOptions {
    rootDir: string
    transform: (code: string, filePath: string) => string | Promise<string>
  }

  export const PUBLISH_PROTECTED_EXTENSIONS: string[]

  export function isPublishProtectedArtifact(filePath: string): boolean

  export function resolvePublishProtectionPolicy(
    env?: PublishProtectionEnv,
  ): PublishProtectionPolicy

  export function collectPublishProtectedArtifacts(rootDir: string): Promise<string[]>

  export function protectPublishArtifacts(
    options: ProtectPublishArtifactsOptions,
  ): Promise<string[]>
}
