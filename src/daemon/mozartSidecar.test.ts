import { describe, expect, it } from 'vitest';
import { planMozartSidecar } from './mozartSidecar';

describe('planMozartSidecar', () => {
  it('disables when MOZART_ENABLED is not 1', () => {
    const plan = planMozartSidecar({ MOZART_ENABLED: '0' });
    expect(plan).toEqual({ mode: 'disabled', reason: 'MOZART_ENABLED is not 1' });
  });

  it('uses external proxy when MOZART_PROXY_URL is provided', () => {
    const plan = planMozartSidecar({
      MOZART_ENABLED: '1',
      MOZART_PROXY_URL: 'http://127.0.0.1:7071',
    });
    expect(plan).toEqual({ mode: 'external', proxyUrl: 'http://127.0.0.1:7071' });
  });

  it('autostarts with default command/port when enabled', () => {
    const plan = planMozartSidecar({ MOZART_ENABLED: '1' });
    expect(plan).toEqual({
      mode: 'autostart',
      command: 'mozart',
      args: ['serve', '--port', '7070'],
      proxyUrl: 'http://127.0.0.1:7070',
      port: 7070,
      mcpUrl: undefined,
    });
  });

  it('autostarts with custom bin + mcp url + custom port', () => {
    const plan = planMozartSidecar({
      MOZART_ENABLED: '1',
      MOZART_SIDECAR_BIN: '/tmp/mozart',
      MOZART_PROXY_PORT: '17070',
      MOZART_MCP_URL: 'http://127.0.0.1:5555',
    });
    expect(plan).toEqual({
      mode: 'autostart',
      command: '/tmp/mozart',
      args: ['serve', '--port', '17070', '--mcp-url', 'http://127.0.0.1:5555'],
      proxyUrl: 'http://127.0.0.1:17070',
      port: 17070,
      mcpUrl: 'http://127.0.0.1:5555',
    });
  });

  it('falls back to default port when MOZART_PROXY_PORT is invalid', () => {
    const plan = planMozartSidecar({
      MOZART_ENABLED: '1',
      MOZART_PROXY_PORT: 'invalid',
    });
    expect(plan).toMatchObject({
      mode: 'autostart',
      proxyUrl: 'http://127.0.0.1:7070',
      port: 7070,
    });
  });

  it('disables autostart when MOZART_SIDECAR_AUTOSTART=0', () => {
    const plan = planMozartSidecar({
      MOZART_ENABLED: '1',
      MOZART_SIDECAR_AUTOSTART: '0',
    });
    expect(plan).toEqual({ mode: 'disabled', reason: 'MOZART_SIDECAR_AUTOSTART=0' });
  });
});

