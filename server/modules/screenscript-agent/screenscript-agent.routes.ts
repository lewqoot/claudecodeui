import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import type { ProviderRuntimeWriter } from '@/shared/index.js';

import { publicAgentErrorCode } from './screenscript-agent-errors.js';
import type { ScreenscriptRunProjects } from './screenscript-run-projects.service.js';
import type { ScreenscriptRunRegistry } from './screenscript-run-registry.js';

type ScreenscriptAgentService = {
  authProgress(): {
    phase: string; verificationUrl: string | null; userCode: string | null; expiresAt: number | null; error: string | null;
  };
  cancelAuthLogin(): {
    phase: string; verificationUrl: string | null; userCode: string | null; expiresAt: number | null; error: string | null;
  };
  readAuthStatus(): Promise<{
    signedIn: boolean; detail: string; email: string | null; authMode: string | null; error: string | null;
  }>;
  startAuthLogin(): Promise<{
    phase: string; verificationUrl: string | null; userCode: string | null; expiresAt: number | null; error: string | null;
  }>;
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
  /**
   * Live feed of the turns this channel executes; the CloudCLI operator screen
   * reads the same registry, so recording here is what makes a run visible.
   */
  runs: Pick<ScreenscriptRunRegistry, 'beginRun' | 'recordWriter' | 'endRun' | 'forgetRun'>;
  /**
   * Registers the run workspace as a CloudCLI project, which is what puts the
   * run folder (and later its conversation) into the sidebar.
   */
  runProjects: Pick<ScreenscriptRunProjects, 'ensureRunProject' | 'archiveRunProject'>;
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

  router.get('/auth/account', async (request, response) => {
    if (!authorize(request, response)) return;
    try {
      response.status(200).json(await dependencies.service.readAuthStatus());
    } catch {
      response.status(502).json({ error: 'SCREENSCRIPT_AGENT_AUTH_STATUS_FAILED' });
    }
  });

  router.get('/auth/progress', (request, response) => {
    if (!authorize(request, response)) return;
    response.status(200).json(dependencies.service.authProgress());
  });

  router.post('/auth/start', async (request, response) => {
    if (!authorize(request, response)) return;
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

  router.post('/auth/cancel', (request, response) => {
    if (!authorize(request, response)) return;
    response.status(200).json(dependencies.service.cancelAuthLogin());
  });

  router.delete('/:runId', async (request, response) => {
    if (!authorize(request, response)) return;
    try {
      const removed = await dependencies.service.removeRun(request.params.runId);
      if (removed) {
        dependencies.runs.forgetRun(request.params.runId);
        dependencies.runProjects.archiveRunProject(request.params.runId);
      }
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
    // The operator screen watches the same turn through this registry; the
    // worker keeps receiving the stream unchanged.
    dependencies.runs.beginRun({ runId: request.body.runId, model: request.body.model });
    // Registering the workspace as a project is what makes the run show up as a
    // folder in the sidebar while it works. It is a convenience projection, so a
    // failure here must never keep the worker's turn from starting.
    try {
      await dependencies.runProjects.ensureRunProject(request.body.runId);
    } catch (error) {
      console.warn('[Screenscript] Run project registration failed', {
        runId: request.body.runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const recordingWriter = dependencies.runs.recordWriter(request.body.runId, writer);

    let failure: unknown = null;
    try {
      await dependencies.service.runTurn({
        runId: request.body.runId,
        message: request.body.message,
        model: request.body.model,
        effort: typeof request.body.effort === 'string' ? request.body.effort : undefined,
        sessionId: typeof request.body.sessionId === 'string' ? request.body.sessionId : null,
        evidence: Array.isArray(request.body.evidence) ? request.body.evidence : [],
      }, recordingWriter);
    } catch (error) {
      failure = error;
      recordingWriter.send({
        kind: 'error',
        role: 'error',
        content: publicAgentErrorCode(error),
      });
      recordingWriter.send({ kind: 'complete', success: false, exitCode: 1 });
    } finally {
      dependencies.runs.endRun(request.body.runId, {
        ok: failure === null,
        errorCode: failure === null ? null : publicAgentErrorCode(failure),
      });
      recordingWriter.end();
    }
  });

  return router;
}
