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

export declare const PUBLISH_PROTECTED_EXTENSIONS: string[]

export declare function isPublishProtectedArtifact(filePath: string): boolean

export declare function resolvePublishProtectionPolicy(
  env?: PublishProtectionEnv,
): PublishProtectionPolicy

export declare function collectPublishProtectedArtifacts(rootDir: string): Promise<string[]>

export declare function protectPublishArtifacts(
  options: ProtectPublishArtifactsOptions,
): Promise<string[]>
