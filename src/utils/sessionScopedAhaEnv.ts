const SESSION_SCOPED_AHA_ENV_KEYS = [
  'AHA_RECOVER_SESSION_ID',
  'AHA_RESUME_SESSION_ID',
  'AHA_ROOM_ID',
  'AHA_ROOM_NAME',
  'AHA_AGENT_ROLE',
  'AHA_ROLE_LABEL',
  'AHA_SESSION_ID',
  'AHA_SESSION_NAME',
  'AHA_SESSION_PATH',
  'AHA_PARENT_SESSION_ID',
  'AHA_MEMBER_ID',
  'AHA_TEAM_MEMBER_ID',
  'AHA_SPEC_ID',
  'AHA_CANDIDATE_ID',
  'AHA_CANDIDATE_IDENTITY_JSON',
  'AHA_EXECUTION_PLANE',
  'AHA_AGENT_PROMPT',
  'AHA_AGENT_SCOPE_SUMMARY',
  'AHA_TASK_PROMPT',
  'AHA_AGENT_MODEL',
  'AHA_FALLBACK_AGENT_MODEL',
  'AHA_HELP_TARGET_SESSION',
  'AHA_HELP_TYPE',
  'AHA_HELP_DESCRIPTION',
  'AHA_HELP_SEVERITY',
  'AHA_SETTINGS_PATH',
  'AHA_AGENT_ENV_FILE_PATH',
  'AHA_AGENT_MCP_CONFIG_PATH',
  'AHA_AGENT_COMMANDS_DIR',
] as const;

export function stripSessionScopedAhaEnv(
  env: NodeJS.ProcessEnv,
  options: { stripClaudeCode?: boolean } = {},
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = { ...env };

  for (const key of SESSION_SCOPED_AHA_ENV_KEYS) {
    delete nextEnv[key];
  }

  if (options.stripClaudeCode) {
    delete nextEnv.CLAUDECODE;
  }

  return nextEnv;
}
