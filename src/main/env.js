'use strict';
// If Stormo (or one of its test tools) starts from inside a Claude Code session, it inherits that
// session's variables: id, token, permission mode, proxy address. The child terminals and CLIs
// would start out "configured like the parent session": here we strip them.

function stripInheritedClaudeSession(env = process.env) {
  if (!(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT || env.CLAUDE_CODE_SESSION_ID)) return 0;
  let removed = 0;
  for (const k of Object.keys(env)) {
    if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_') || k.startsWith('CLAUDE_AGENT_SDK_')
      || k === 'CLAUDE_EFFORT' || k === 'CLAUDE_PID' || k.startsWith('CLAUDE_PREVIEW_')
      || k.startsWith('MCP_CONNECTION_') || k.startsWith('MCP_SERVER_CONNECTION_') || k === 'ANTHROPIC_BASE_URL') {
      delete env[k];
      removed++;
    }
  }
  return removed;
}

module.exports = { stripInheritedClaudeSession };
