/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { TrackedSession } from './types';
import { SpawnSessionOptions, SpawnSessionResult } from '@/modules/common/registerCommonHandlers';

export function startDaemonControlServer({
  getChildren,
  stopSession,
  stopTeamSessions,
  spawnSession,
  requestShutdown,
  onAhaSessionWebhook,
  onClaudeLocalSessionFound,
  getTeamPulse,
  onHeartbeatPing,
}: {
  getChildren: () => TrackedSession[];
  stopSession: (sessionId: string) => boolean;
  stopTeamSessions?: (teamId: string) => { stopped: number; errors: string[] };
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  requestShutdown: () => void;
  onAhaSessionWebhook: (sessionId: string, metadata: Metadata) => void;
  onClaudeLocalSessionFound?: (ahaSessionId: string, claudeLocalSessionId: string) => void;
  getTeamPulse?: (teamId: string) => Array<{
    sessionId: string;
    role: string;
    status: string;
    lastSeenMs: number;
    pid?: number;
    runtimeType?: string;
  }>;
  onHeartbeatPing?: (sessionId: string, teamId: string, role: string) => void;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = fastify({
      logger: false // We use our own logger
    });

    // Set up Zod type provider
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>();

    // Session reports itself after creation
    typed.post('/session-started', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          metadata: z.any() // Metadata type from API
        }),
        response: {
          200: z.object({
            status: z.literal('ok')
          })
        }
      }
    }, async (request) => {
      const { sessionId, metadata } = request.body;

      logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
      onAhaSessionWebhook(sessionId, metadata);

      return { status: 'ok' as const };
    });

    // Claude Code local session ID reported after SDK starts
    typed.post('/session-found', {
      schema: {
        body: z.object({
          ahaSessionId: z.string(),
          claudeLocalSessionId: z.string(),
        }),
        response: {
          200: z.object({ status: z.literal('ok') })
        }
      }
    }, async (request) => {
      const { ahaSessionId, claudeLocalSessionId } = request.body;
      logger.debug(`[CONTROL SERVER] Claude local session found: aha=${ahaSessionId} → local=${claudeLocalSessionId}`);
      if (onClaudeLocalSessionFound) {
        onClaudeLocalSessionFound(ahaSessionId, claudeLocalSessionId);
      }
      return { status: 'ok' as const };
    });

    // List all tracked sessions
    typed.post('/list', {
      schema: {
        response: {
          200: z.object({
            children: z.array(z.object({
              startedBy: z.string(),
              ahaSessionId: z.string(),
              pid: z.number()
            }))
          })
        }
      }
    }, async () => {
      const children = getChildren();
      logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
      return {
        children: children
          .filter(child => child.ahaSessionId !== undefined)
          .map(child => ({
            startedBy: child.startedBy,
            ahaSessionId: child.ahaSessionId!,
            pid: child.pid
          }))
      }
    });

    // List sessions for a specific team — used by supervisor to find CC log files
    typed.post('/list-team-sessions', {
      schema: {
        body: z.object({ teamId: z.string() }),
        response: {
          200: z.object({
            sessions: z.array(z.object({
              ahaSessionId: z.string(),
              claudeLocalSessionId: z.string().optional(),
              runtimeType: z.string().optional(),
              role: z.string().optional(),
              pid: z.number(),
            }))
          })
        }
      }
    }, async (request) => {
      const { teamId } = request.body;
      const children = getChildren();
      const sessions = children
        .filter(child => {
          const meta = child.ahaSessionMetadataFromLocalWebhook;
          const childTeamId = meta?.teamId || meta?.roomId;
          return childTeamId === teamId && child.ahaSessionId;
        })
        .map(child => ({
          ahaSessionId: child.ahaSessionId!,
          claudeLocalSessionId: child.claudeLocalSessionId,
          runtimeType: child.ahaSessionMetadataFromLocalWebhook?.flavor,
          role: child.ahaSessionMetadataFromLocalWebhook?.role,
          pid: child.pid,
        }));
      logger.debug(`[CONTROL SERVER] list-team-sessions for ${teamId}: ${sessions.length} sessions`);
      return { sessions };
    });

    // Stop specific session
    typed.post('/stop-session', {
      schema: {
        body: z.object({
          sessionId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean()
          })
        }
      }
    }, async (request) => {
      const { sessionId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
      const success = stopSession(sessionId);
      return { success };
    });

    // Stop all sessions for a team
    typed.post('/stop-team-sessions', {
      schema: {
        body: z.object({
          teamId: z.string()
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            stopped: z.number(),
            errors: z.array(z.string())
          })
        }
      }
    }, async (request) => {
      const { teamId } = request.body;

      logger.debug(`[CONTROL SERVER] Stop team sessions request: ${teamId}`);

      if (!stopTeamSessions) {
        logger.debug('[CONTROL SERVER] stopTeamSessions not available');
        return { success: false, stopped: 0, errors: ['Team session stopping not supported'] };
      }

      const result = stopTeamSessions(teamId);
      return {
        success: result.errors.length === 0,
        stopped: result.stopped,
        errors: result.errors
      };
    });

    // Spawn new session
    typed.post('/spawn-session', {
      schema: {
        body: z.object({
          directory: z.string(),
          sessionId: z.string().optional(),
          sessionTag: z.string().optional(),
          agent: z.enum(['claude', 'codex', 'ralph']).optional(),
          token: z.string().optional(),
          parentSessionId: z.string().optional(),
          executionPlane: z.enum(['mainline', 'bypass']).optional(),
          specId: z.string().optional(),
          teamId: z.string().optional(),
          role: z.string().optional(),
          sessionName: z.string().optional(),
          env: z.record(z.string()).optional(),
        }),
        response: {
          200: z.object({
            success: z.boolean(),
            sessionId: z.string().optional(),
            approvedNewDirectoryCreation: z.boolean().optional()
          }),
          409: z.object({
            success: z.boolean(),
            requiresUserApproval: z.boolean().optional(),
            actionRequired: z.string().optional(),
            directory: z.string().optional()
          }),
          500: z.object({
            success: z.boolean(),
            error: z.string().optional()
          })
        }
      }
    }, async (request, reply) => {
      const { directory, sessionId, sessionTag, agent, token, parentSessionId, executionPlane, specId, teamId, role, sessionName, env } = request.body;

      logger.debug(`[CONTROL SERVER] Spawn session request: dir=${directory}, sessionId=${sessionId || 'new'}`);
      const result = await spawnSession({ directory, sessionId, sessionTag, agent, token, parentSessionId, executionPlane, specId, teamId, role, sessionName, env });

      switch (result.type) {
        case 'success':
          // Check if sessionId exists, if not return error
          if (!result.sessionId) {
            reply.code(500);
            return {
              success: false,
              error: 'Failed to spawn session: no session ID returned'
            };
          }
          return {
            success: true,
            sessionId: result.sessionId,
            approvedNewDirectoryCreation: true
          };
        
        case 'requestToApproveDirectoryCreation':
          reply.code(409); // Conflict - user input needed
          return { 
            success: false,
            requiresUserApproval: true,
            actionRequired: 'CREATE_DIRECTORY',
            directory: result.directory
          };
        
        case 'error':
          reply.code(500);
          return { 
            success: false,
            error: result.errorMessage
          };
      }
    });

    // Stop daemon
    typed.post('/stop', {
      schema: {
        response: {
          200: z.object({
            status: z.string()
          })
        }
      }
    }, async () => {
      logger.debug('[CONTROL SERVER] Stop daemon request received');

      // Give time for response to arrive
      setTimeout(() => {
        logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
        requestShutdown();
      }, 50);

      return { status: 'stopping' };
    });

    // Heartbeat ping from MCP tool calls — lightweight, fire-and-forget
    typed.post('/heartbeat-ping', {
      schema: {
        body: z.object({
          sessionId: z.string(),
          teamId: z.string(),
          role: z.string(),
        }),
      }
    }, async (request) => {
      const { sessionId, teamId, role } = request.body;
      onHeartbeatPing?.(sessionId, teamId, role);
      return { ok: true };
    });

    // Team pulse — returns liveness status of all agents in a team
    typed.post('/team-pulse', {
      schema: {
        body: z.object({ teamId: z.string() }),
        response: {
          200: z.object({
            teamId: z.string(),
            members: z.array(z.object({
              sessionId: z.string(),
              role: z.string(),
              status: z.string(),
              lastSeenMs: z.number(),
              pid: z.number().optional(),
              runtimeType: z.string().optional(),
            })),
            summary: z.string(),
          })
        }
      }
    }, async (request) => {
      const { teamId } = request.body;
      const members = getTeamPulse?.(teamId) ?? [];
      const alive = members.filter(m => m.status === 'alive').length;
      const suspect = members.filter(m => m.status === 'suspect').length;
      const dead = members.filter(m => m.status === 'dead').length;
      const summary = members.length === 0
        ? 'No agents tracked'
        : `${alive} alive, ${suspect} suspect, ${dead} dead (${members.length} total)`;
      logger.debug(`[CONTROL SERVER] team-pulse for ${teamId}: ${summary}`);
      return { teamId, members, summary };
    });

    // Help request — spawn a help-agent for the requesting session
    typed.post('/help-request', {
      schema: {
        body: z.object({
          teamId: z.string(),
          sessionId: z.string(),
          type: z.string(),
          description: z.string(),
          severity: z.string(),
        }),
      },
    }, async (request, reply) => {
      const { teamId, sessionId, type, description, severity } = request.body;
      logger.debug(`[CONTROL SERVER] Help request from ${sessionId}: ${type} (${severity})`);

      try {
        const result = await spawnSession({
          directory: process.cwd(),
          agent: 'claude',
          teamId,
          role: 'help-agent',
          sessionName: 'Help Agent',
          executionPlane: 'bypass',
          env: {
            AHA_HELP_TARGET_SESSION: sessionId,
            AHA_HELP_TYPE: type,
            AHA_HELP_DESCRIPTION: description,
            AHA_HELP_SEVERITY: severity,
          },
        });

        if (result.type === 'success') {
          return { success: true, helpAgentSessionId: result.sessionId };
        }
        return { success: false, error: 'Failed to spawn help-agent' };
      } catch (error) {
        reply.code(500);
        return { success: false, error: String(error) };
      }
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
