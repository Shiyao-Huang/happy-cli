/**
 * Daemon-specific types (not related to API/server communication)
 */

import { Metadata } from '@/api/types';
import { ChildProcess } from 'child_process';
import { SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';

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
  /** Original spawn options, stored so the daemon can respawn the agent on crash. */
  spawnOptions?: Omit<SpawnSessionOptions, 'onPidKnown' | 'token'>;
  /** Number of times this agent has been respawned after unexpected exit (0 = original spawn). */
  respawnCount?: number;
  /** Set to true when the session was explicitly stopped via stopSession/stopTeamSessions. */
  intentionallyStopped?: boolean;
}