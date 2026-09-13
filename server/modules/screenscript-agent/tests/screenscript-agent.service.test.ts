import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { ProviderRunFunction } from '@/shared/index.js';

import { createScreenscriptAgentService } from '../screenscript-agent.service.js';

test('ScreenScript service materializes verified images and applies the isolated Codex profile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screenscript-agent-service-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runsRoot = path.join(root, 'runs');
  const codexHome = path.join(root, 'codex-home');
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  await writeFile(path.join(codexHome, 'auth.json'), '{}', { mode: 0o600 });
  const bytes = Buffer.from('not-a-real-jpeg-but-hash-verified');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let capturedPrompt = '';
  let capturedOptions: Record<string, any> = {};

  const service = createScreenscriptAgentService({
    fileSystem: await import('node:fs/promises'),
    queryCodex: (async (prompt, options, writer) => {
      capturedPrompt = prompt;
      capturedOptions = options;
      writer.setSessionId?.('session-1');
      writer.send({ kind: 'complete', success: true, exitCode: 0 });
    }) as ProviderRunFunction,
    models: { getProviderModels: async () => ({ DEFAULT: 'gpt-test', OPTIONS: [{ value: 'gpt-test' }] }) },
    runsRoot,
    codexHome,
    processEnvironment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', GOOGLE_API_KEY: 'must-not-leak' },
  });

  await service.runTurn({
    runId: 'run-123',
    message: 'SCREENSCRIPT_MODE: agent_run\nReturn JSON.',
    model: 'gpt-test',
    effort: 'high',
    evidence: [{ id: 'frame-0001', mimeType: 'image/jpeg', sha256, dataBase64: bytes.toString('base64') }],
  }, { send: () => undefined });

  assert.match(capturedPrompt, /^SCREENSCRIPT_MODE: agent_run/);
  assert.equal(capturedOptions.permissionMode, 'isolatedReadOnly');
  assert.equal(capturedOptions.codexEnvironment.GOOGLE_API_KEY, undefined);
  assert.equal(capturedOptions.codexEnvironment.CODEX_HOME, await realpath(codexHome));
  assert.equal(capturedOptions.codexEnvironment.HOME, path.join(await realpath(runsRoot), 'run-123', '.home'));
  assert.equal(capturedOptions.images.length, 1);
  const filesystemPermissions = capturedOptions.codexConfigOverrides.find((value: string) => value.includes('.filesystem='));
  assert.match(filesystemPermissions, /":root"="deny"/);
  assert.match(filesystemPermissions, /":minimal"="read"/);
  assert.match(filesystemPermissions, /run-123/);
  assert.match(filesystemPermissions, /codex-home"="deny"/);
  assert.ok(capturedOptions.codexConfigOverrides.includes('permissions.screenscript_agent.network.enabled=false'));
  assert.deepEqual(await readFile(capturedOptions.images[0].path), bytes);
  const evidenceRoot = path.join(runsRoot, 'run-123', 'evidence');
  const turnDirectory = (await readdir(evidenceRoot)).find((name) => name.startsWith('turn-'))!;
  const manifest = JSON.parse(await readFile(path.join(evidenceRoot, turnDirectory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((file: any) => file.id), ['frame-0001']);
  assert.match(await readFile(path.join(codexHome, 'config.toml'), 'utf8'), /sandbox_mode = "read-only"/);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(await realpath(runsRoot), 'run-123', 'controller-session.json'), 'utf8')),
    { run_id: 'run-123', session_id: 'session-1', model: 'gpt-test' },
  );

  await service.runTurn({
    runId: 'run-123', message: 'SCREENSCRIPT_MODE: agent_run\nContinue.', model: 'gpt-test', sessionId: 'session-1', evidence: [],
  }, { send: () => undefined });
  await assert.rejects(() => service.runTurn({
    runId: 'run-other', message: 'SCREENSCRIPT_MODE: agent_run\nContinue.', model: 'gpt-test', sessionId: 'session-1', evidence: [],
  }, { send: () => undefined }), /SESSION_BINDING_MISSING/);

  assert.equal(await service.removeRun('run-123'), true);
  await assert.rejects(() => access(path.join(runsRoot, 'run-123')), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  assert.equal(await service.removeRun('run-123'), false);
  await assert.rejects(() => service.removeRun('../escape'), /REQUEST_INVALID/);
});

test('ScreenScript service rejects traversal, bad hashes, unlisted models and missing dedicated auth', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screenscript-agent-reject-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const service = createScreenscriptAgentService({
    fileSystem: await import('node:fs/promises'),
    queryCodex: (async (...args: Parameters<ProviderRunFunction>) => { calls.push(args); }) as ProviderRunFunction,
    models: { getProviderModels: async () => ({ DEFAULT: 'gpt-test', OPTIONS: [{ value: 'gpt-test' }] }) },
    runsRoot: path.join(root, 'runs'),
    codexHome: path.join(root, 'missing-auth'),
    processEnvironment: {},
  });
  const valid = { runId: 'run-1', message: 'Return JSON', model: 'gpt-test' };

  await assert.rejects(() => service.runTurn({ ...valid, runId: '../escape' }, { send: () => undefined }), /REQUEST_INVALID/);
  await assert.rejects(() => service.runTurn({ ...valid, model: 'unknown' }, { send: () => undefined }), /MODEL_INVALID/);
  await assert.rejects(() => service.runTurn({ ...valid, evidence: [{ id: 'frame', mimeType: 'image/jpeg', sha256: '0'.repeat(64), dataBase64: Buffer.from('bad').toString('base64') }] }, { send: () => undefined }), /EVIDENCE_INVALID/);
  await assert.rejects(() => service.runTurn(valid, { send: () => undefined }), /CODEX_AUTH_MISSING/);
  assert.equal(calls.length, 0);
});
