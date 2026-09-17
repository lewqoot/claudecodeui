import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { createScreenscriptAgentUsageService } from '../screenscript-agent-usage.service.js';

function childProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; killed: boolean; kill(): boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function respondToRpc(child: ReturnType<typeof childProcess>, rateLimitsResult: unknown) {
  let buffered = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      const message = JSON.parse(line) as { id?: number; method: string };
      if (message.method === 'initialize') {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
      } else if (message.method === 'account/rateLimits/read') {
        child.stdout.write(`${JSON.stringify({ id: message.id, result: rateLimitsResult })}\n`);
      }
      newlineIndex = buffered.indexOf('\n');
    }
  });
}

test('reads plan-limit windows using CODEX_HOME/HOME scoped to the isolated profile', async () => {
  const child = childProcess();
  let capturedEnv: NodeJS.ProcessEnv = {};
  respondToRpc(child, {
    rateLimitsByLimitId: {
      codex: {
        limitName: 'ChatGPT Plus',
        planType: 'plus',
        primary: { usedPercent: 12.4, windowDurationMins: 300, resetsAt: 1_700_000_000 },
        secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: 1_700_500_000 },
      },
    },
  });
  const service = createScreenscriptAgentUsageService({
    codexHome: '/data/.codex-screenscript-agent',
    codexBin: '/codex',
    processEnvironment: { PATH: '/bin' },
    spawnProcess: (_command, args, options) => {
      assert.deepEqual(args, ['app-server', '--stdio']);
      capturedEnv = options.env;
      return child as never;
    },
  });

  const result = await service.readRateLimits();

  assert.equal(capturedEnv.CODEX_HOME, '/data/.codex-screenscript-agent');
  assert.equal(capturedEnv.HOME, '/data/.codex-screenscript-agent');
  assert.deepEqual(result, {
    limits: [{
      id: 'codex',
      name: 'ChatGPT Plus',
      planType: 'plus',
      windows: [
        { kind: 'primary', usedPercent: 12.4, windowDurationMins: 300, resetsAt: new Date(1_700_000_000 * 1000).toISOString() },
        { kind: 'secondary', usedPercent: 100, windowDurationMins: 10_080, resetsAt: new Date(1_700_500_000 * 1000).toISOString() },
      ],
    }],
  });
  assert.equal(child.killed, true);
});

test('rejects when the isolated profile has no session and the app-server exits', async () => {
  const child = childProcess();
  const service = createScreenscriptAgentUsageService({
    codexHome: '/data/.codex-screenscript-agent',
    codexBin: '/codex',
    processEnvironment: {},
    spawnProcess: () => {
      queueMicrotask(() => {
        child.stderr.write('Error: not signed in\n');
        child.emit('exit', 1, null);
      });
      return child as never;
    },
  });

  await assert.rejects(service.readRateLimits(), /Codex app-server exited/);
});
