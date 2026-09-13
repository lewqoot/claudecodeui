import assert from 'node:assert/strict';
import test from 'node:test';

import { Codex } from '@openai/codex-sdk';
import type { Thread, ThreadOptions } from '@openai/codex-sdk';

import { codexRuntime } from '@/modules/providers/list/codex/codex-runtime.provider.js';
import type { ProviderRuntimeContext } from '@/shared/index.js';

for (const resumed of [false, true]) {
  for (const permissionMode of [undefined, 'default', 'unknown', 'acceptEdits', 'bypassPermissions']) {
    test(`Codex ${resumed ? 'resumes' : 'starts'} with supported permissions (${permissionMode ?? 'omitted'})`, async (t) => {
      let capturedOptions: ThreadOptions | undefined;
      let capturedPrompt: unknown;
      const messages: unknown[] = [];
      const thread = {
        id: 'native-thread',
        async runStreamed(prompt: unknown) {
          capturedPrompt = prompt;
          return { events: (async function* () {
            yield { type: 'thread.started', thread_id: 'native-thread' };
          })() };
        },
      } as unknown as Thread;

      const start = t.mock.method(Codex.prototype, 'startThread', (options?: ThreadOptions) => {
        capturedOptions = options;
        return thread;
      });
      const resume = t.mock.method(Codex.prototype, 'resumeThread', (id: string, options?: ThreadOptions) => {
        assert.equal(id, 'native-thread');
        capturedOptions = options;
        return thread;
      });
      const context: ProviderRuntimeContext = {
        resolveProviderSessionId: () => resumed ? 'native-thread' : null,
        resolveResumeModel: async () => 'test-model',
        getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
        normalizeMessage: () => [],
        isProviderInstalled: async () => true,
      };

      await codexRuntime.run('hey there', {
        sessionId: resumed ? 'app-session' : undefined,
        permissionMode,
        cwd: process.cwd(),
      }, { isWebSocketWriter: true, send: (message) => messages.push(message) }, context);

      assert.equal(start.mock.callCount(), resumed ? 0 : 1);
      assert.equal(resume.mock.callCount(), resumed ? 1 : 0);
      assert.equal(capturedPrompt, 'hey there');
      assert.equal(capturedOptions?.sandboxMode, permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write');
      assert.equal(capturedOptions?.approvalPolicy, permissionMode === 'acceptEdits' || permissionMode === 'bypassPermissions' ? 'never' : 'on-request');
      assert.ok(messages.some((message: any) => message.kind === 'complete' && message.exitCode === 0));
      assert.ok(!messages.some((message: any) => message.kind === 'error'));
    });
  }
}

test('Codex isolated mode uses a sanitized client environment and disables network tools', async (t) => {
  let capturedThreadOptions: ThreadOptions | undefined;
  let capturedClientOptions: Record<string, unknown> | undefined;
  const thread = {
    id: 'isolated-thread',
    async runStreamed() {
      return { events: (async function* () {
        yield { type: 'thread.started', thread_id: 'isolated-thread' };
      })() };
    },
  } as unknown as Thread;

  t.mock.method(Codex.prototype, 'startThread', function (this: Codex, options?: ThreadOptions) {
    capturedThreadOptions = options;
    capturedClientOptions = (this as unknown as { options: Record<string, unknown> }).options;
    return thread;
  });
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async () => 'test-model',
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'test-model' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const environment = { PATH: '/usr/bin:/bin', HOME: '/isolated/home', CODEX_HOME: '/isolated/codex' };
  const config = { default_permissions: 'screenscript_agent' };
  const configOverrides = ['permissions.screenscript_agent.filesystem={":root"="deny","/run"="read"}'];

  await codexRuntime.run('return json', {
    permissionMode: 'isolatedReadOnly',
    cwd: '/run',
    codexEnvironment: environment,
    codexConfig: config,
    codexConfigOverrides: configOverrides,
  }, { isSSEStreamWriter: true, send: () => undefined }, context);

  assert.equal(capturedThreadOptions?.sandboxMode, 'read-only');
  assert.equal(capturedThreadOptions?.approvalPolicy, 'never');
  assert.equal(capturedThreadOptions?.networkAccessEnabled, false);
  assert.equal(capturedThreadOptions?.webSearchMode, 'disabled');
  assert.deepEqual(capturedClientOptions?.env, environment);
  assert.deepEqual(capturedClientOptions?.config, config);
  assert.deepEqual(capturedClientOptions?.configOverrides, configOverrides);
});
