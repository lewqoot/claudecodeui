import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createScreenscriptAgentAuthService } from '../screenscript-agent-auth.service.js';

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough; stderr: PassThrough; killed: boolean; kill(): boolean;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

test('dedicated ScreenScript auth starts device login and returns only the official link and one-time code', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screenscript-agent-auth-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = childProcess();
  let capturedEnv: NodeJS.ProcessEnv = {};
  const service = createScreenscriptAgentAuthService({
    codexHome: root,
    codexBin: '/codex',
    processEnvironment: { PATH: '/bin' },
    now: () => 1_000,
    spawnProcess: (_command, args, options) => {
      assert.deepEqual(args, ['login', '--device-auth']);
      capturedEnv = options.env;
      queueMicrotask(() => child.stdout.write('Open https://auth.openai.com/codex/device and enter ABCD-EFGH\n'));
      return child as never;
    },
  });
  const state = await service.startAuthLogin();
  assert.equal(capturedEnv.CODEX_HOME, root);
  assert.equal(state.phase, 'waiting');
  assert.equal(state.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(state.userCode, 'ABCD-EFGH');
  assert.equal(state.expiresAt, 901_000);
  assert.equal(JSON.stringify(state).includes('token'), false);
  service.cancelAuthLogin();
  assert.equal(child.killed, true);
});

test('dedicated ScreenScript auth status exposes identity but never stored tokens', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'screenscript-agent-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const claims = Buffer.from(JSON.stringify({ email: 'replacement@example.test' })).toString('base64url');
  await writeFile(path.join(root, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `x.${claims}.y`, access_token: 'secret-value' } }), { mode: 0o600 });
  const child = childProcess();
  const service = createScreenscriptAgentAuthService({
    codexHome: root,
    codexBin: '/codex',
    processEnvironment: {},
    spawnProcess: (_command, args) => {
      assert.deepEqual(args, ['login', 'status']);
      queueMicrotask(() => {
        child.stdout.write('Logged in using ChatGPT\n');
        child.emit('close', 0);
      });
      return child as never;
    },
  });
  const status = await service.readAuthStatus();
  assert.deepEqual(status, {
    signedIn: true,
    detail: 'Logged in using ChatGPT',
    email: 'replacement@example.test',
    authMode: 'chatgpt',
    error: null,
  });
  assert.equal(JSON.stringify(status).includes('secret-value'), false);
});
