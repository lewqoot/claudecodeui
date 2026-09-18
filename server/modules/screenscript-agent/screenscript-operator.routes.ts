import express from 'express';

import type { createScreenscriptAgentAuthService } from './screenscript-agent-auth.service.js';
import type { createScreenscriptAgentUsageService } from './screenscript-agent-usage.service.js';
import type { ScreenscriptRunRegistry } from './screenscript-run-registry.js';

const STREAM_HEARTBEAT_MS = 15_000;

type ScreenscriptOperatorRouterDependencies = {
  enabled: boolean;
  service: ReturnType<typeof createScreenscriptAgentAuthService> & ReturnType<typeof createScreenscriptAgentUsageService>;
  /**
   * Live view of the turns the private worker channel is executing. It is
   * owner-visible only: the browser learns event content, never a channel key.
   */
  runs: Pick<ScreenscriptRunRegistry, 'isRunId' | 'listRuns' | 'getRun' | 'subscribe'>;
};

function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Builds the CloudCLI-owner-only routes used by the Settings screen: account
 * recovery, plan limits and the live ScreenScript run feed. The server
 * entrypoint wraps this router in CloudCLI authentication; the browser never
 * receives either private worker-channel secret.
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

  router.get('/usage', async (_request, response) => {
    if (!available(response)) return;
    try {
      response.status(200).json(await dependencies.service.readRateLimits());
    } catch {
      response.status(502).json({ error: 'SCREENSCRIPT_AGENT_USAGE_FAILED' });
    }
  });

  // Newest first; the screen polls this while it is open.
  router.get('/runs', (_request, response) => {
    if (!available(response)) return;
    response.status(200).json({ runs: dependencies.runs.listRuns() });
  });

  router.get('/runs/:runId', (request, response) => {
    if (!available(response)) return;
    const runId = String(request.params.runId ?? '');
    if (!dependencies.runs.isRunId(runId)) {
      response.status(400).json({ error: 'SCREENSCRIPT_RUN_ID_INVALID' });
      return;
    }
    const detail = dependencies.runs.getRun(runId);
    if (!detail) {
      response.status(404).json({ error: 'SCREENSCRIPT_RUN_NOT_FOUND' });
      return;
    }
    response.status(200).json(detail);
  });

  // Server-sent events: the whole history is replayed on connect, so opening the
  // screen late still shows how the turn got here, then live events follow.
  router.get('/runs/:runId/stream', (request, response) => {
    if (!available(response)) return;
    const runId = String(request.params.runId ?? '');
    if (!dependencies.runs.isRunId(runId)) {
      response.status(400).json({ error: 'SCREENSCRIPT_RUN_ID_INVALID' });
      return;
    }
    const detail = dependencies.runs.getRun(runId);
    if (!detail) {
      response.status(404).json({ error: 'SCREENSCRIPT_RUN_NOT_FOUND' });
      return;
    }

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(sseFrame('run', detail.run));
    for (const event of detail.events) response.write(sseFrame('event', event));
    if (detail.run.status !== 'running') {
      response.write(sseFrame('done', detail.run));
      response.end();
      return;
    }

    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe: () => void = () => undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };

    unsubscribe = dependencies.runs.subscribe(runId, (message) => {
      if (closed) return;
      if (message.type === 'event') {
        response.write(sseFrame('event', message.event));
        return;
      }
      response.write(sseFrame('done', message.run));
      if (!response.writableEnded) response.end();
      cleanup();
    });
    heartbeat = setInterval(() => {
      if (!response.writableEnded) response.write(': ping\n\n');
    }, STREAM_HEARTBEAT_MS);
    request.on('close', cleanup);
  });

  return router;
}
