import { spawn, type ChildProcess } from 'child_process';
import { logger } from '@/ui/logger';

const DEFAULT_PROXY_PORT = 7070;
const DEFAULT_PROXY_HOST = '127.0.0.1';
const HEALTH_RETRY_COUNT = 25;
const HEALTH_RETRY_MS = 200;

export type MozartSidecarPlan =
  | { mode: 'disabled'; reason: string }
  | { mode: 'external'; proxyUrl: string }
  | {
      mode: 'autostart';
      command: string;
      args: string[];
      proxyUrl: string;
      port: number;
      mcpUrl?: string;
    };

export type MozartSidecarHandle =
  | { mode: 'external'; proxyUrl: string }
  | { mode: 'spawned'; proxyUrl: string; process: ChildProcess };

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PROXY_PORT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return DEFAULT_PROXY_PORT;
  }
  return parsed;
}

export function planMozartSidecar(env: NodeJS.ProcessEnv = process.env): MozartSidecarPlan {
  if (env.MOZART_ENABLED !== '1') {
    return { mode: 'disabled', reason: 'MOZART_ENABLED is not 1' };
  }

  const configuredProxyUrl = env.MOZART_PROXY_URL?.trim();
  if (configuredProxyUrl) {
    return { mode: 'external', proxyUrl: configuredProxyUrl };
  }

  if (env.MOZART_SIDECAR_AUTOSTART === '0') {
    return { mode: 'disabled', reason: 'MOZART_SIDECAR_AUTOSTART=0' };
  }

  const port = parsePort(env.MOZART_PROXY_PORT);
  const proxyUrl = `http://${DEFAULT_PROXY_HOST}:${port}`;
  const mcpUrl = env.MOZART_MCP_URL?.trim() || undefined;
  const command = (env.MOZART_SIDECAR_BIN || env.MOZART_SIDECAR_CMD || 'mozart').trim();
  const args = ['serve', '--port', String(port)];
  if (mcpUrl) {
    args.push('--mcp-url', mcpUrl);
  }

  return {
    mode: 'autostart',
    command,
    args,
    proxyUrl,
    port,
    mcpUrl,
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(proxyUrl: string): Promise<boolean> {
  for (let i = 0; i < HEALTH_RETRY_COUNT; i += 1) {
    try {
      const response = await fetch(`${proxyUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // retry
    }
    await sleep(HEALTH_RETRY_MS);
  }
  return false;
}

export async function startMozartSidecarForDaemon(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MozartSidecarHandle | null> {
  const plan = planMozartSidecar(env);

  if (plan.mode === 'disabled') {
    logger.debug(`[MOZART SIDECAR] Disabled: ${plan.reason}`);
    return null;
  }

  if (plan.mode === 'external') {
    logger.debug(`[MOZART SIDECAR] Using external proxy: ${plan.proxyUrl}`);
    return { mode: 'external', proxyUrl: plan.proxyUrl };
  }

  logger.debug(`[MOZART SIDECAR] Auto-starting: ${plan.command} ${plan.args.join(' ')}`);
  const sidecar = spawn(plan.command, plan.args, {
    stdio: 'ignore',
    detached: false,
    env: { ...process.env, MOZART_PORT: String(plan.port) },
  });

  sidecar.on('error', (error) => {
    logger.warn(`[MOZART SIDECAR] Spawn error: ${error.message}`);
  });

  const healthy = await waitForHealth(plan.proxyUrl);
  if (!healthy) {
    logger.warn(`[MOZART SIDECAR] Health check failed at ${plan.proxyUrl}; continuing without MOZART_PROXY_URL`);
    try {
      sidecar.kill('SIGTERM');
    } catch {
      // ignore
    }
    return null;
  }

  process.env.MOZART_PROXY_URL = plan.proxyUrl;
  logger.debug(`[MOZART SIDECAR] Ready: ${plan.proxyUrl}`);
  return { mode: 'spawned', proxyUrl: plan.proxyUrl, process: sidecar };
}

export async function stopMozartSidecar(handle: MozartSidecarHandle | null): Promise<void> {
  if (!handle || handle.mode !== 'spawned') {
    return;
  }

  const child = handle.process;
  if (child.killed || child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 3000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

