/**
 * Unified Runtime — Entry point for the SDK bridge
 *
 * This module provides the unified runtime interface that bridges
 * Claude Code and Codex runtimes behind a common abstraction.
 *
 * Architecture:
 * ┌──────────────────────────────────────────────────────┐
 * │                   RuntimeSession                      │
 * │  (unified interface: start/stop/invokeTool/switchMode)│
 * ├──────────────────┬───────────────────────────────────┤
 * │  Claude Runtime  │        Codex Runtime               │
 * │  (SDK + PTY)     │   (CodexMcpClient + STDIO)         │
 * ├──────────────────┴───────────────────────────────────┤
 * │              Mozart Bridge (CLI)                      │
 * │   mozart invoke --tool <name> --payload <json>        │
 * ├──────────────────────────────────────────────────────┤
 * │            Mozart Sidecar (HTTP)                      │
 * │   POST / method:tools/call (JSON-RPC 2.0)            │
 * └──────────────────────────────────────────────────────┘
 *
 * Usage:
 *   import { createRuntime } from '@/runtime';
 *   const runtime = createRuntime({ flavor: 'claude', ... });
 *   await runtime.start();
 */

export type { RuntimeFlavor, SessionMode, PermissionMode as RuntimePermissionMode } from './types';
export type { ToolResult, ToolInvocation, RuntimeSessionMetadata, RuntimeConfig, RuntimeCallbacks, RuntimeSession, RuntimeFactoryOptions, RuntimeFactory } from './types';
export { invokeMozartTool, checkMozartAvailable, getMozartVersion } from './mozartBridge';
export type { MozartBridgeConfig } from './mozartBridge';
export { registerBridgeTools } from './bridgeTools';
export { buildSessionMetadataFromEnv, resolvePermissionMode } from './sharedLifecycle';
export { buildRuntimeAhaMcpServers } from './mcpBridgeConfig';
export type { RuntimeBridgeTarget, RuntimeMcpServerConfig } from './mcpBridgeConfig';
