import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import type { ProviderRuntimeWriter } from '@/shared/index.js';

type ScreenscriptAgentService = {
  removeRun(runId: string): Promise<boolean>;
  runTurn(input: {
    runId: string;
    message: string;
    model: string;
    effort?: string;
    sessionId?: string | null;
    evidence?: Array<{ id: string; mimeType: string; sha256: string; dataBase64: string }>;
  }, writer: ProviderRuntimeWriter): Promise<void>;
};

type RouterDependencies = {
  enabled: boolean;
  apiSecret: string;
  channelSecret: string;
  service: ScreenscriptAgentService;
};

function sameSecret(presented: unknown, expected: string): boolean {
  if (typeof presented !== 'string' || !expected) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Creates the private ScreenScript-to-Codex route consumed only by the
 * ScreenScript worker. The module assembly supplies its isolated run service.
 */
export function createScreenscriptAgentRouter(dependencies: RouterDependencies): express.Router {
  const router = express.Router();

  const authorize = (request: express.Request, response: express.Response): boolean => {
    if (!dependencies.enabled) {
      response.status(503).json({ error: 'SCREENSCRIPT_AGENT_CHANNEL_DISABLED' });
      return false;
    }
    if (!sameSecret(request.headers['x-api-key'], dependencies.apiSecret)
      || !sameSecret(request.headers['x-screenscript-agent-key'], dependencies.channelSecret)) {
      response.status(403).json({ error: 'SCREENSCRIPT_AGENT_CHANNEL_FORBIDDEN' });
      return false;
    }
    return true;
  };

  router.delete('/:runId', async (request, response) => {
    if (!authorize(request, response)) return;
    try {
      const removed = await dependencies.service.removeRun(request.params.runId);
      response.status(200).json({ removed });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'SCREENSCRIPT_AGENT_FAILED' });
    }
  });

  router.post('/', async (request, response) => {
    if (!authorize(request, response)) return;
    if (!request.body || typeof request.body !== 'object'
      || typeof request.body.runId !== 'string'
      || typeof request.body.message !== 'string'
      || typeof request.body.model !== 'string') {
      return response.status(400).json({ error: 'SCREENSCRIPT_AGENT_REQUEST_INVALID' });
    }

    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-store');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    const writer: ProviderRuntimeWriter & { end(): void } = {
      isSSEStreamWriter: true,
      send(data) {
        if (!response.writableEnded) response.write(`data: ${JSON.stringify(data)}\n\n`);
      },
      setSessionId(sessionId) {
        this.send({ type: 'session-id', sessionId });
      },
      end() {
        if (!response.writableEnded) {
          response.write('data: {"type":"done"}\n\n');
          response.end();
        }
      },
    };

    try {
      await dependencies.service.runTurn({
        runId: request.body.runId,
        message: request.body.message,
        model: request.body.model,
        effort: typeof request.body.effort === 'string' ? request.body.effort : undefined,
        sessionId: typeof request.body.sessionId === 'string' ? request.body.sessionId : null,
        evidence: Array.isArray(request.body.evidence) ? request.body.evidence : [],
      }, writer);
    } catch (error) {
      writer.send({
        kind: 'error',
        role: 'error',
        content: error instanceof Error ? error.message : 'SCREENSCRIPT_AGENT_FAILED',
      });
      writer.send({ kind: 'complete', success: false, exitCode: 1 });
    } finally {
      writer.end();
    }
  });

  return router;
}
