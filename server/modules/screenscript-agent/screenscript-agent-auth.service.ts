import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmod, readFile } from 'node:fs/promises';
import path from 'node:path';

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;
const BARE_COLOUR_PATTERN = /\[[0-9;]+m/g;
const CODE_TIMEOUT_MS = 30_000;
const SESSION_TIMEOUT_MS = 16 * 60_000;

type LoginPhase = 'idle' | 'starting' | 'waiting' | 'success' | 'failed';

type LoginState = {
  phase: LoginPhase;
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  error: string | null;
};

type AccountStatus = {
  signedIn: boolean;
  detail: string;
  email: string | null;
  authMode: string | null;
  error: string | null;
};

type SpawnLike = (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess;

type AuthDependencies = {
  codexHome: string;
  codexBin: string;
  processEnvironment: NodeJS.ProcessEnv;
  spawnProcess?: SpawnLike;
  now?: () => number;
};

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '').replace(BARE_COLOUR_PATTERN, '');
}

function parseVerificationUrl(output: string): string | null {
  const match = stripAnsi(output).match(/https:\/\/auth\.openai\.com\/\S*/);
  return match ? match[0].replace(/[.,)\]]+$/, '') : null;
}

function parseUserCode(output: string): string | null {
  return stripAnsi(output).match(/\b[A-Z0-9]{4}-[A-Z0-9]{4,8}\b/)?.[0] ?? null;
}

function decodeJwtPayload(token: unknown): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readIdentity(codexHome: string): Promise<{ email: string | null; authMode: string | null }> {
  try {
    const value = JSON.parse(await readFile(path.join(codexHome, 'auth.json'), 'utf8')) as Record<string, unknown>;
    const tokens = value.tokens && typeof value.tokens === 'object' ? value.tokens as Record<string, unknown> : null;
    const claims = decodeJwtPayload(tokens?.id_token);
    return {
      email: typeof claims?.email === 'string' ? claims.email : null,
      authMode: typeof value.auth_mode === 'string'
        ? value.auth_mode
        : tokens ? 'chatgpt' : typeof value.OPENAI_API_KEY === 'string' ? 'apikey' : null,
    };
  } catch {
    return { email: null, authMode: null };
  }
}

/**
 * Manages device authorization for the dedicated ScreenScript Codex profile.
 * The ScreenScript agent module uses it to let a trusted operator replace a
 * broken server login without exposing OAuth tokens or the CloudCLI UI.
 */
export function createScreenscriptAgentAuthService(dependencies: AuthDependencies) {
  const codexHome = path.resolve(dependencies.codexHome);
  const now = dependencies.now ?? Date.now;
  const spawnProcess: SpawnLike = dependencies.spawnProcess
    ?? ((command, args, options) => spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] }));
  const environment = (): NodeJS.ProcessEnv => ({
    ...dependencies.processEnvironment,
    CODEX_HOME: codexHome,
    HOME: codexHome,
  });
  let state: LoginState = { phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null };
  let child: ChildProcess | null = null;
  let output = '';
  let sessionTimer: NodeJS.Timeout | null = null;

  const snapshot = (): LoginState => ({ ...state });
  const cleanup = () => {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = null;
    child?.kill();
    child = null;
  };
  const fail = (message: string) => {
    state = { ...state, phase: 'failed', error: stripAnsi(message).slice(-600) };
  };

  return {
    authProgress(): LoginState {
      return snapshot();
    },

    cancelAuthLogin(): LoginState {
      if (state.phase === 'starting' || state.phase === 'waiting') {
        cleanup();
        state = { phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null };
      }
      return snapshot();
    },

    async readAuthStatus(): Promise<AccountStatus> {
      return new Promise((resolve) => {
        let text = '';
        let settled = false;
        const finish = async (status: AccountStatus) => {
          if (settled) return;
          settled = true;
          const identity = await readIdentity(codexHome);
          resolve({ ...status, ...identity });
        };
        let statusChild: ChildProcess;
        try {
          statusChild = spawnProcess(dependencies.codexBin, ['login', 'status'], { env: environment() });
        } catch (error) {
          void finish({ signedIn: false, detail: '', email: null, authMode: null, error: error instanceof Error ? error.message : 'codex unavailable' });
          return;
        }
        const timer = setTimeout(() => {
          statusChild.kill();
          void finish({ signedIn: false, detail: '', email: null, authMode: null, error: 'codex login status timed out' });
        }, 15_000);
        statusChild.stdout?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        statusChild.stderr?.on('data', (chunk: Buffer) => { text += chunk.toString(); });
        statusChild.on('error', (error: Error) => {
          clearTimeout(timer);
          void finish({ signedIn: false, detail: '', email: null, authMode: null, error: error.message });
        });
        statusChild.on('close', (code: number | null) => {
          clearTimeout(timer);
          const detail = stripAnsi(text).trim();
          const signedIn = code === 0 && !/not logged in/i.test(detail);
          void finish({ signedIn, detail: detail || (signedIn ? 'Logged in' : 'Not logged in'), email: null, authMode: null, error: null });
        });
      });
    },

    async startAuthLogin(): Promise<LoginState> {
      if (state.phase === 'starting' || state.phase === 'waiting') return snapshot();
      cleanup();
      output = '';
      state = { phase: 'starting', verificationUrl: null, userCode: null, expiresAt: null, error: null };
      try {
        child = spawnProcess(dependencies.codexBin, ['login', '--device-auth'], { env: environment() });
      } catch (error) {
        fail(error instanceof Error ? error.message : 'Failed to start codex');
        return snapshot();
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(codeTimer);
          resolve(snapshot());
        };
        const codeTimer = setTimeout(() => {
          if (state.phase === 'starting') {
            fail('Codex did not print a login link within 30 seconds.');
            cleanup();
          }
          settle();
        }, CODE_TIMEOUT_MS);
        const consume = (chunk: Buffer) => {
          output += chunk.toString();
          if (state.phase === 'starting') {
            const verificationUrl = parseVerificationUrl(output);
            const userCode = parseUserCode(output);
            if (verificationUrl && userCode) {
              state = { phase: 'waiting', verificationUrl, userCode, expiresAt: now() + 15 * 60_000, error: null };
              settle();
            }
          }
          if (/successfully logged in/i.test(stripAnsi(output))) {
            state = { ...state, phase: 'success', error: null };
            void Promise.all([
              chmod(codexHome, 0o700),
              chmod(path.join(codexHome, 'auth.json'), 0o600),
            ]).catch(() => undefined);
            settle();
          }
        };
        child?.stdout?.on('data', consume);
        child?.stderr?.on('data', consume);
        child?.on('error', (error: Error) => { fail(error.message); settle(); });
        child?.on('close', (code: number | null) => {
          child = null;
          if (state.phase !== 'success' && state.phase !== 'failed') {
            fail(stripAnsi(output).trim().split('\n').slice(-3).join(' ') || `codex login exited with code ${code ?? 'unknown'}`);
          }
          settle();
        });
        sessionTimer = setTimeout(() => {
          if (state.phase === 'waiting') {
            fail('The one-time code expired. Start the login again.');
            cleanup();
          }
        }, SESSION_TIMEOUT_MS);
      });
    },
  };
}
