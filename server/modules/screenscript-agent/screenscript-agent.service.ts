import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

import type { ProviderRunFunction, ProviderRuntimeWriter } from '@/shared/index.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const ALLOWED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const MAX_EVIDENCE_FILES = 120;
const MAX_EVIDENCE_FILE_BYTES = 3 * 1024 * 1024;
const MAX_EVIDENCE_TOTAL_BYTES = 32 * 1024 * 1024;

const EVIDENCE_TYPES = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
]);

type EvidenceInput = {
  id: string;
  mimeType: string;
  sha256: string;
  dataBase64: string;
};

type TurnInput = {
  runId: string;
  message: string;
  model: string;
  effort?: string;
  sessionId?: string | null;
  evidence?: EvidenceInput[];
};

type ServiceDependencies = {
  fileSystem: typeof import('node:fs/promises');
  queryCodex: ProviderRunFunction;
  models: {
    getProviderModels(provider: 'codex'): Promise<{
      DEFAULT: string;
      OPTIONS: Array<{ value: string }>;
    }>;
  };
  runsRoot: string;
  codexHome: string;
  processEnvironment: NodeJS.ProcessEnv;
};

function exactChild(root: string, name: string): string {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, name);
  if (path.dirname(candidate) !== resolvedRoot || path.basename(candidate) !== name) {
    throw new Error('SCREENSCRIPT_AGENT_PATH_INVALID');
  }
  return candidate;
}

function tomlQuoted(value: string): string {
  return JSON.stringify(value);
}

function decodeEvidence(value: EvidenceInput): { bytes: Buffer; extension: string } {
  const extension = EVIDENCE_TYPES.get(value.mimeType);
  if (!extension || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value.id)
    || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.dataBase64)) {
    throw new Error('SCREENSCRIPT_AGENT_EVIDENCE_INVALID');
  }
  const bytes = Buffer.from(value.dataBase64, 'base64');
  if (!bytes.length || bytes.length > MAX_EVIDENCE_FILE_BYTES
    || createHash('sha256').update(bytes).digest('hex') !== value.sha256) {
    throw new Error('SCREENSCRIPT_AGENT_EVIDENCE_INVALID');
  }
  return { bytes, extension };
}

function isolatedEnvironment(source: NodeJS.ProcessEnv, workspace: string, codexHome: string): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: path.join(workspace, '.home'),
    TMPDIR: path.join(workspace, '.tmp'),
    CODEX_HOME: codexHome,
    PATH: source.PATH || '/usr/local/bin:/usr/bin:/bin',
  };
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
    if (typeof source[key] === 'string' && source[key]) environment[key] = source[key]!;
  }
  return environment;
}

/**
 * Executes one ScreenScript controller turn in a run-only workspace.
 * The module assembly uses this service so the HTTP route never handles files,
 * provider permissions, credentials, or evidence materialization itself.
 */
export function createScreenscriptAgentService(dependencies: ServiceDependencies) {
  const runsRoot = path.resolve(dependencies.runsRoot);
  const codexHome = path.resolve(dependencies.codexHome);

  return {
    async removeRun(runId: string): Promise<boolean> {
      if (!RUN_ID_PATTERN.test(runId)) throw new Error('SCREENSCRIPT_AGENT_REQUEST_INVALID');
      await dependencies.fileSystem.mkdir(runsRoot, { recursive: true, mode: 0o700 });
      const canonicalRunsRoot = await dependencies.fileSystem.realpath(runsRoot);
      const requestedWorkspace = exactChild(canonicalRunsRoot, runId);
      let workspace: string;
      try {
        workspace = await dependencies.fileSystem.realpath(requestedWorkspace);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
      if (workspace !== requestedWorkspace) throw new Error('SCREENSCRIPT_AGENT_WORKSPACE_SYMLINK_REFUSED');
      await dependencies.fileSystem.rm(workspace, { recursive: true, force: false });
      return true;
    },
    async runTurn(input: TurnInput, writer: ProviderRuntimeWriter): Promise<void> {
      if (!RUN_ID_PATTERN.test(input.runId) || !input.message.trim() || input.message.length > 2_000_000) {
        throw new Error('SCREENSCRIPT_AGENT_REQUEST_INVALID');
      }
      if (input.sessionId && !SESSION_ID_PATTERN.test(input.sessionId)) {
        throw new Error('SCREENSCRIPT_AGENT_SESSION_INVALID');
      }
      if (input.effort && !ALLOWED_EFFORTS.has(input.effort)) {
        throw new Error('SCREENSCRIPT_AGENT_EFFORT_INVALID');
      }
      const catalog = await dependencies.models.getProviderModels('codex');
      const model = input.model || catalog.DEFAULT;
      if (!catalog.OPTIONS.some((option) => option.value === model) && model !== catalog.DEFAULT) {
        throw new Error('SCREENSCRIPT_AGENT_MODEL_INVALID');
      }

      const evidence = input.evidence ?? [];
      if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE_FILES) {
        throw new Error('SCREENSCRIPT_AGENT_EVIDENCE_LIMIT');
      }
      const decoded = evidence.map((item) => ({ item, ...decodeEvidence(item) }));
      if (decoded.reduce((total, item) => total + item.bytes.length, 0) > MAX_EVIDENCE_TOTAL_BYTES) {
        throw new Error('SCREENSCRIPT_AGENT_EVIDENCE_LIMIT');
      }

      await dependencies.fileSystem.mkdir(runsRoot, { recursive: true, mode: 0o700 });
      const canonicalRunsRoot = await dependencies.fileSystem.realpath(runsRoot);
      const canonicalCodexHome = await dependencies.fileSystem.realpath(codexHome)
        .catch(() => { throw new Error('SCREENSCRIPT_AGENT_CODEX_AUTH_MISSING'); });
      const authPath = path.join(canonicalCodexHome, 'auth.json');
      await dependencies.fileSystem.access(authPath, fsConstants.R_OK)
        .catch(() => { throw new Error('SCREENSCRIPT_AGENT_CODEX_AUTH_MISSING'); });
      const [codexHomeInfo, authInfo] = await Promise.all([
        dependencies.fileSystem.stat(canonicalCodexHome),
        dependencies.fileSystem.stat(authPath),
      ]);
      if (!codexHomeInfo.isDirectory() || !authInfo.isFile()
        || (codexHomeInfo.mode & 0o077) !== 0 || (authInfo.mode & 0o077) !== 0) {
        throw new Error('SCREENSCRIPT_AGENT_CODEX_AUTH_PERMISSIONS_INVALID');
      }
      // This profile is dedicated to ScreenScript. Replacing its config keeps
      // user MCP servers, skills, and unrelated tool credentials out of runs;
      // auth.json and provider-managed session data remain intact.
      await dependencies.fileSystem.writeFile(
        path.join(canonicalCodexHome, 'config.toml'),
        'sandbox_mode = "read-only"\napproval_policy = "never"\nweb_search = "disabled"\n',
        { mode: 0o600 },
      );
      const requestedWorkspace = exactChild(canonicalRunsRoot, input.runId);
      await dependencies.fileSystem.mkdir(requestedWorkspace, { recursive: true, mode: 0o700 });
      const workspace = await dependencies.fileSystem.realpath(requestedWorkspace);
      if (workspace !== requestedWorkspace) throw new Error('SCREENSCRIPT_AGENT_WORKSPACE_SYMLINK_REFUSED');
      const isControllerTurn = input.message.startsWith('SCREENSCRIPT_MODE: agent_run\n');
      const controllerCheckpointPath = path.join(workspace, 'controller-session.json');
      if (input.sessionId) {
        if (!isControllerTurn) throw new Error('SCREENSCRIPT_AGENT_SESSION_SCOPE_INVALID');
        let checkpoint: { run_id?: unknown; session_id?: unknown; model?: unknown };
        try {
          checkpoint = JSON.parse(await dependencies.fileSystem.readFile(controllerCheckpointPath, 'utf8'));
        } catch {
          throw new Error('SCREENSCRIPT_AGENT_SESSION_BINDING_MISSING');
        }
        if (checkpoint.run_id !== input.runId || checkpoint.session_id !== input.sessionId || checkpoint.model !== model) {
          throw new Error('SCREENSCRIPT_AGENT_SESSION_SCOPE_INVALID');
        }
      }
      const evidenceDirectory = path.join(workspace, 'evidence');
      await Promise.all([
        dependencies.fileSystem.mkdir(path.join(workspace, '.home'), { recursive: true, mode: 0o700 }),
        dependencies.fileSystem.mkdir(path.join(workspace, '.tmp'), { recursive: true, mode: 0o700 }),
        dependencies.fileSystem.mkdir(evidenceDirectory, { recursive: true, mode: 0o700 }),
      ]);
      if (await dependencies.fileSystem.realpath(evidenceDirectory) !== evidenceDirectory) {
        throw new Error('SCREENSCRIPT_AGENT_WORKSPACE_SYMLINK_REFUSED');
      }
      const turnEvidenceDirectory = await dependencies.fileSystem.mkdtemp(path.join(evidenceDirectory, 'turn-'));

      const images = await Promise.all(decoded.map(async ({ item, bytes, extension }, index) => {
        const filename = `${String(index + 1).padStart(3, '0')}-${item.sha256}${extension}`;
        const imagePath = path.join(turnEvidenceDirectory, filename);
        await dependencies.fileSystem.writeFile(imagePath, bytes, { mode: 0o600, flag: 'wx' });
        return { path: imagePath, name: item.id, mimeType: item.mimeType, size: bytes.length };
      }));

      const manifest = evidence.map((item, index) => ({
        order: index + 1,
        id: item.id,
        sha256: item.sha256,
        mime_type: item.mimeType,
      }));
      await dependencies.fileSystem.writeFile(
        path.join(turnEvidenceDirectory, 'manifest.json'),
        `${JSON.stringify({ schema: 'screenscript-agent-evidence-v1', run_id: input.runId, files: manifest }, null, 2)}\n`,
        { mode: 0o600 },
      );

      const permissions = `permissions.screenscript_agent.filesystem={":root"="deny",":minimal"="read",${tomlQuoted(workspace)}="read",${tomlQuoted(canonicalCodexHome)}="deny"}`;
      let capturedControllerSession: string | null = null;
      let checkpointWrite = Promise.resolve();
      let checkpointFailure: unknown = null;
      const captureControllerSession = (sessionId: unknown) => {
        if (!isControllerTurn || capturedControllerSession || typeof sessionId !== 'string' || !SESSION_ID_PATTERN.test(sessionId)) return;
        capturedControllerSession = sessionId;
        const temporaryPath = `${controllerCheckpointPath}.${randomUUID()}.tmp`;
        checkpointWrite = dependencies.fileSystem.writeFile(
          temporaryPath,
          `${JSON.stringify({ run_id: input.runId, session_id: sessionId, model })}\n`,
          { mode: 0o600, flag: 'wx' },
        ).then(() => dependencies.fileSystem.rename(temporaryPath, controllerCheckpointPath))
          .catch((error) => { checkpointFailure = error; });
      };
      const isolatedWriter: ProviderRuntimeWriter = {
        userId: writer.userId,
        isSSEStreamWriter: writer.isSSEStreamWriter,
        isWebSocketWriter: writer.isWebSocketWriter,
        send(data) {
          if (data && typeof data === 'object') captureControllerSession((data as { sessionId?: unknown }).sessionId);
          writer.send(data);
        },
        setSessionId(sessionId) {
          captureControllerSession(sessionId);
          writer.setSessionId?.(sessionId);
        },
      };
      await dependencies.queryCodex(input.message, {
        projectPath: workspace,
        cwd: workspace,
        sessionId: input.sessionId || null,
        model,
        effort: input.effort,
        images,
        permissionMode: 'isolatedReadOnly',
        codexEnvironment: isolatedEnvironment(dependencies.processEnvironment, workspace, canonicalCodexHome),
        codexConfig: { default_permissions: 'screenscript_agent', allow_login_shell: false },
        codexConfigOverrides: [
          'permissions.screenscript_agent.extends=":read-only"',
          permissions,
          'permissions.screenscript_agent.network.enabled=false',
        ],
      }, isolatedWriter);
      await checkpointWrite;
      if (checkpointFailure) throw checkpointFailure;
    },
  };
}
