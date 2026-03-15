/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';

/**
 * Session tracking for daemon
 */
export interface TrackedSession {
  startedBy: 'daemon' | string;
  ahaSessionId?: string;
  ahaSessionMetadataFromLocalWebhook?: Metadata;
  /** Local Claude Code session file ID (from onSessionFound callback). Used to locate CC JSONL logs. */
  claudeLocalSessionId?: string;
  pid: number;
  childProcess?: ChildProcess;
  error?: string;
  directoryCreated?: boolean;
  message?: string;
}