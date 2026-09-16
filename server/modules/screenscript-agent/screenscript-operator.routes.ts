import express from 'express';

import type { createScreenscriptAgentAuthService } from './screenscript-agent-auth.service.js';

type ScreenscriptOperatorRouterDependencies = {
  enabled: boolean;
  service: ReturnType<typeof createScreenscriptAgentAuthService>;
};

/**
 * Builds the CloudCLI-owner-only account-recovery routes used by the Settings
 * screen. The server entrypoint wraps this router in CloudCLI authentication;
 * the browser never receives either private worker-channel secret.
 */
export function createScreenscriptOperatorRouter(
  dependencies: ScreenscriptOperatorRouterDependencies,
): express.Router {
  const router = express.Router();

  const available = (response: express.Response): boolean => {
    if (dependencies.enabled) return true;
    response.status(503).json({ error: 'SCREENSCRIPT_AGENT_CHANNEL_DISABLED' });
    return false;
  };

  router.get('/account', async (_request, response) => {
    if (!available(response)) return;
    try {
      response.status(200).json(await dependencies.service.readAuthStatus());
    } catch {
      response.status(502).json({ error: 'SCREENSCRIPT_AGENT_AUTH_STATUS_FAILED' });
    }
  });

  router.get('/progress', (_request, response) => {
    if (!available(response)) return;
    response.status(200).json(dependencies.service.authProgress());
  });

  router.post('/start', async (request, response) => {
    if (!available(response)) return;
    if (request.body?.confirmPausedRuns !== true) {
      response.status(409).json({ error: 'SCREENSCRIPT_AGENT_AUTH_PAUSE_CONFIRMATION_REQUIRED' });
      return;
    }
    try {
      response.status(200).json(await dependencies.service.startAuthLogin());
    } catch {
      response.status(502).json({ error: 'SCREENSCRIPT_AGENT_AUTH_START_FAILED' });
    }
  });

  router.post('/cancel', (_request, response) => {
    if (!available(response)) return;
    response.status(200).json(dependencies.service.cancelAuthLogin());
  });

  return router;
}
