const AGENT_ERROR_PREFIX = /^SCREENSCRIPT_AGENT_[A-Z0-9_]+$/;

/**
 * Maps an internal ScreenScript agent failure onto the small set of codes the
 * worker and the CloudCLI operator screen are allowed to see.
 *
 * Provider details (token contents, CLI arguments, stderr) must never leave the
 * process, so anything unrecognized collapses to a generic failure.
 */
export function publicAgentErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (AGENT_ERROR_PREFIX.test(message)) return message;
  if (/token_revoked|not logged in|login required|unauthori[sz]ed|\b401\b/i.test(message)) {
    return 'SCREENSCRIPT_AGENT_CODEX_AUTH_INVALID';
  }
  if (/usage limit|rate limit|quota|too many requests|\b429\b/i.test(message)) {
    return 'SCREENSCRIPT_AGENT_CODEX_LIMIT_REACHED';
  }
  return 'SCREENSCRIPT_AGENT_FAILED';
}
