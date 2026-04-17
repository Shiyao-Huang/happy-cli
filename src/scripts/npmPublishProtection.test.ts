import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  collectPublishProtectedArtifacts,
  protectPublishArtifacts,
  resolvePublishProtectionPolicy,
} from '../../scripts/lib/npmPublishProtection.mjs'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aha-npm-protect-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('resolvePublishProtectionPolicy', () => {
  it('disables obfuscation by default (AHA_NPM_PUBLISH_ENCRYPTION defaults to none)', () => {
    expect(resolvePublishProtectionPolicy({})).toEqual({
      enabled: false,
      mode: 'none',
    })
  })

  it('enables obfuscation when explicitly set', () => {
    expect(resolvePublishProtectionPolicy({ AHA_NPM_PUBLISH_ENCRYPTION: 'obfuscate' })).toEqual({
      enabled: true,
      mode: 'obfuscate',
    })
  })

  it('supports explicit disable env values', () => {
    expect(resolvePublishProtectionPolicy({ AHA_NPM_PUBLISH_ENCRYPTION: 'false' })).toEqual({
      enabled: false,
      mode: 'none',
    })
  })
})

describe('collectPublishProtectedArtifacts', () => {
  it('returns only JavaScript publish artifacts recursively', async () => {
    const root = await createTempDir()
    await mkdir(path.join(root, 'nested'), { recursive: true })
    await writeFile(path.join(root, 'index.mjs'), 'export const a = 1;\n', 'utf8')
    await writeFile(path.join(root, 'nested', 'worker.cjs'), 'module.exports = {};\n', 'utf8')
    await writeFile(path.join(root, 'nested', 'types.d.ts'), 'export type T = string;\n', 'utf8')
    await writeFile(path.join(root, 'README.md'), '# docs\n', 'utf8')

    await expect(collectPublishProtectedArtifacts(root)).resolves.toEqual([
      path.join(root, 'index.mjs'),
      path.join(root, 'nested', 'worker.cjs'),
    ])
  })
})

describe('protectPublishArtifacts', () => {
  it('rewrites only protected artifacts', async () => {
    const root = await createTempDir()
    await mkdir(path.join(root, 'nested'), { recursive: true })
    const jsFile = path.join(root, 'index.js')
    const typeFile = path.join(root, 'nested', 'index.d.ts')
    await writeFile(jsFile, 'console.log("hello");\n', 'utf8')
    await writeFile(typeFile, 'export declare const value: string;\n', 'utf8')

    const touched = await protectPublishArtifacts({
      rootDir: root,
      transform: (code: string, filePath: string) => `/* protected:${path.basename(filePath)} */\n${code}`,
    })

    expect(touched).toEqual([jsFile])
    await expect(readFile(jsFile, 'utf8')).resolves.toContain('protected:index.js')
    await expect(readFile(typeFile, 'utf8')).resolves.toBe('export declare const value: string;\n')
  })
})
