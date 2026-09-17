import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import readline from 'node:readline';

const REQUEST_TIMEOUT_MS = 15_000;

export type RateWindow = {
  kind: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: string | null;
};

export type RateLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  windows: RateWindow[];
};

export type RateLimitsData = {
  limits: RateLimit[];
};

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type JsonRecord = Record<string, unknown>;

type SpawnLike = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;

type UsageDependencies = {
  codexHome: string;
  codexBin: string;
  processEnvironment: NodeJS.ProcessEnv;
  spawnProcess?: SpawnLike;
};

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function nonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeWindow(kind: RateWindow['kind'], value: unknown): RateWindow | null {
  const raw = record(value);
  if (!raw) return null;
  const usedPercent = nonNegativeNumber(raw.usedPercent);
  const windowDurationMins = nonNegativeNumber(raw.windowDurationMins);
  if (usedPercent === null || windowDurationMins === null) return null;
  const resetSeconds = nonNegativeNumber(raw.resetsAt);
  return {
    kind,
    usedPercent: Math.min(100, usedPercent),
    windowDurationMins,
    resetsAt: resetSeconds === null ? null : new Date(resetSeconds * 1000).toISOString(),
  };
}

function normalizeLimit(value: unknown, fallbackId: string): RateLimit | null {
  const raw = record(value);
  if (!raw) return null;
  const windows = [normalizeWindow('primary', raw.primary), normalizeWindow('secondary', raw.secondary)]
    .filter((window): window is RateWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    id: nullableString(raw.limitId) ?? fallbackId,
    name: nullableString(raw.limitName),
    planType: nullableString(raw.planType),
    windows,
  };
}

/** Converts the `account/rateLimits/read` response into the shape the Settings card renders. */
export function normalizeRateLimits(value: unknown): RateLimitsData {
  const result = record(value) ?? {};
  const byId = record(result.rateLimitsByLimitId);
  const candidates = byId ? Object.entries(byId) : [['codex', result.rateLimits] as const];
  const limits = candidates
    .map(([id, limit]) => normalizeLimit(limit, id))
    .filter((limit): limit is RateLimit => limit !== null);
  return { limits };
}

/**
 * Reads Codex plan-limit windows for the isolated ScreenScript production profile by talking
 * to `codex app-server --stdio` with CODEX_HOME/HOME pointed at that profile instead of the
 * operator's own account. One short-lived process per read; no session is kept between calls.
 */
export function createScreenscriptAgentUsageService(dependencies: UsageDependencies) {
  const codexHome = dependencies.codexHome;
  const spawnProcess: SpawnLike = dependencies.spawnProcess
    ?? ((command, args, options) => spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] }));
  const environment = (): NodeJS.ProcessEnv => ({
    ...dependencies.processEnvironment,
    CODEX_HOME: codexHome,
    HOME: codexHome,
  });

  return {
    async readRateLimits(): Promise<RateLimitsData> {
      const child = spawnProcess(dependencies.codexBin, ['app-server', '--stdio'], { env: environment() });
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
      let nextId = 1;
      let stderrTail = '';

      const send = (method: string, params: JsonRecord, expectResponse: boolean): Promise<unknown> => {
        if (!expectResponse) {
          child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
          return Promise.resolve(undefined);
        }
        const id = nextId;
        nextId += 1;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin?.write(`${JSON.stringify({ method, id, params })}\n`);
        });
      };

      const failPending = (error: Error) => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      };

      const lines = readline.createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        let message: RpcResponse;
        try {
          message = JSON.parse(line) as RpcResponse;
        } catch {
          return;
        }
        if (typeof message.id !== 'number') return;
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? 'Codex app-server error'));
        else waiter.resolve(message.result);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000);
      });
      child.once('error', (error: Error) => failPending(error));
      child.once('exit', (code, signal) => {
        const detail = stderrTail.trim();
        failPending(new Error(`Codex app-server exited (${signal ?? code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`));
      });

      const timeout = setTimeout(() => {
        failPending(new Error('Codex app-server request timed out.'));
        child.kill();
      }, REQUEST_TIMEOUT_MS);

      try {
        await send('initialize', {
          clientInfo: { name: 'cloudcli_screenscript_production_usage', title: 'CloudCLI ScreenScript Production Usage', version: '1.0.0' },
          capabilities: { optOutNotificationMethods: ['account/rateLimits/updated'] },
        }, true);
        await send('initialized', {}, false);
        const result = await send('account/rateLimits/read', {}, true);
        return normalizeRateLimits(result);
      } finally {
        clearTimeout(timeout);
        lines.close();
        if (!child.killed) child.kill();
      }
    },
  };
}
