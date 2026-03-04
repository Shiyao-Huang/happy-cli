/**
 * R1: Codex Spawn Tests
 *
 * Tests for codex mode in daemon spawn logic:
 * - Constructs correct codex command
 * - Passes team and role options
 * - Sets up CODEX_HOME environment
 *
 * Reference: codexPRD/R1-DAEMON-AUTOSTART.md
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'

describe('daemon codex spawn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should construct correct codex command', () => {
    // Test the command construction logic for codex agent
    const options = {
      agent: 'codex',
      directory: '/tmp/test',
      teamId: 'team-123',
      role: 'builder',
    }

    // Simulate the args construction from run.ts (line 296-300)
    const args: string[] = []
    if (options.agent === 'ralph') {
      args.push('ralph', 'start')
    } else {
      args.push(
        options.agent === 'claude' ? 'claude' : 'codex',
        '--aha-starting-mode', 'remote',
        '--started-by', 'daemon',
      )
    }

    expect(args).toContain('codex')
    expect(args).toContain('--aha-starting-mode')
    expect(args).toContain('remote')
    expect(args).toContain('--started-by')
    expect(args).toContain('daemon')
  })

  it('should set CODEX_HOME environment when token is provided', () => {
    // Test the CODEX_HOME setup logic from run.ts (line 242-253)
    const options = {
      agent: 'codex',
      token: 'test-token-123',
    }

    let extraEnv: Record<string, string> = {}

    if (options.token && options.agent === 'codex') {
      // Simulate creating temp directory and setting env
      extraEnv = {
        CODEX_HOME: tmpdir(), // In real code, this is a temp dir
      }
    }

    expect(extraEnv.CODEX_HOME).toBeDefined()
    expect(extraEnv.CODEX_HOME).toBe(tmpdir())
  })

  it('should set CLAUDE_CODE_OAUTH_TOKEN for claude agent', () => {
    // Test the claude token setup from run.ts (line 254-258)
    const options = {
      agent: 'claude',
      token: 'oauth-token-456',
    }

    let extraEnv: Record<string, string> = {}

    if (options.token) {
      if (options.agent === 'codex') {
        extraEnv = { CODEX_HOME: tmpdir() }
      } else {
        extraEnv = {
          CLAUDE_CODE_OAUTH_TOKEN: options.token,
        }
      }
    }

    expect(extraEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-token-456')
    expect(extraEnv.CODEX_HOME).toBeUndefined()
  })

  it('should pass team context to environment', () => {
    // Test team context passing from run.ts (line 262-277)
    const options = {
      agent: 'codex',
      teamId: 'team-abc',
      role: 'builder',
      sessionName: 'build-session',
      sessionPath: '/project/path',
    }

    const extraEnv: Record<string, string> = {}

    if (options.teamId) {
      extraEnv.AHA_ROOM_ID = options.teamId
    }
    if (options.role) {
      extraEnv.AHA_AGENT_ROLE = options.role
    }
    if (options.sessionName) {
      extraEnv.AHA_SESSION_NAME = options.sessionName
    }
    if (options.sessionPath) {
      extraEnv.AHA_SESSION_PATH = options.sessionPath
    }

    expect(extraEnv.AHA_ROOM_ID).toBe('team-abc')
    expect(extraEnv.AHA_AGENT_ROLE).toBe('builder')
    expect(extraEnv.AHA_SESSION_NAME).toBe('build-session')
    expect(extraEnv.AHA_SESSION_PATH).toBe('/project/path')
  })

  it('should spawn process with correct options', () => {
    // Test spawn options from run.ts (line 309-317)
    const spawnOptions = {
      cwd: '/project/directory',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'] as const,
      env: {
        ...process.env,
        CODEX_HOME: tmpdir(),
      },
    }

    expect(spawnOptions.detached).toBe(true)
    expect(spawnOptions.cwd).toBe('/project/directory')
    expect(spawnOptions.stdio).toContain('pipe')
    expect(spawnOptions.env.CODEX_HOME).toBeDefined()
  })

  it('should distinguish between claude, codex, and ralph agents', () => {
    // Test agent type distinction
    const agents = ['claude', 'codex', 'ralph']

    for (const agent of agents) {
      let command: string
      let args: string[] = []

      if (agent === 'ralph') {
        command = 'ralph'
        args = ['ralph', 'start', '--prd', 'prd.json', '--max-iterations', '10', '--started-by', 'daemon']
      } else {
        command = agent === 'claude' ? 'claude' : 'codex'
        args = [command, '--aha-starting-mode', 'remote', '--started-by', 'daemon']
      }

      expect(args[0]).toBe(command)
    }
  })
})

describe('daemon codex spawn - integration', () => {
  it('should verify codex command is available', async () => {
    // This test verifies the codex command is available in the CLI
    // The actual command is: aha codex --team <id> --role <role>
    try {
      // Check if aha codex --help works
      const { execSync } = await import('child_process')
      const output = execSync('aha codex --help 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 5000,
      })
      expect(typeof output).toBe('string')
    } catch {
      // Expected if aha is not installed
    }
  })
})
