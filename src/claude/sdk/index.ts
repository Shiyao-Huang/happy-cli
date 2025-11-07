/**
 * Claude Code SDK integration for Happy CLI
 * Provides clean TypeScript implementation without Bun support
 */

export { query, createMonitoredQuery } from './query';
export { AbortError } from './types';
export type {
  QueryOptions,
  QueryPrompt,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKControlResponse,
  ControlRequest,
  InterruptRequest,
  SDKControlRequest,
  CanCallToolCallback,
  PermissionResult,
} from './types';

// Token monitoring and model management
export { TokenMonitor, getTokenMonitor, createNewMonitor } from './tokenMonitor';
export { ModelManager, getModelManager } from './modelManager';
