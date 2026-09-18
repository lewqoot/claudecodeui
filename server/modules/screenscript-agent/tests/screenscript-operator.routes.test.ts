import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createScreenscriptOperatorRouter } from '../screenscript-operator.routes.js';
import { createScreenscriptRunRegistry } from '../screenscript-run-registry.js';

type OperatorOptions = Parameters<typeof createScreenscriptOperatorRouter>[0];

function service(overrides: Partial<OperatorOptions['service']> = {}): OperatorOptions['service'] {
  return {
    authProgress: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    cancelAuthLogin: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    readAuthStatus: async () => ({ signedIn: true, detail: 'Logged in using ChatGPT', email: 'production@example.test', authMode: 'chatgpt', error: null }),
    startAuthLogin: async () => ({ phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 1, error: null }),
    readRateLimits: async () => ({ limits: [{ id: 'codex', name: null, planType: 'plus', windows: [{ kind: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: null }] }] }),
    ...overrides,
  };
}

async function withServer(
  options: Omit<OperatorOptions, 'runs'> & { runs?: OperatorOptions['runs'] },
  run: (url: string) => Promise<void>,
) {
  const { runs: providedRuns, ...rest } = options;
  const app = express();
  app.use(express.json());
  app.use('/api/screenscript-operator', createScreenscriptOperatorRouter({ runs: providedRuns ?? createScreenscriptRunRegistry(), ...rest }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/screenscript-operator`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

type SseFrame = { event: string; data: string };

/** Reads named SSE frames from a streaming response, skipping comment heartbeats. */
function frameReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return {
    async next(): Promise<SseFrame> {
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary >= 0) {
          const raw = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = raw.split('\n');
          const event = lines.find((line) => line.startsWith('event: '));
          const data = lines.find((line) => line.startsWith('data: '));
          if (!event || !data) continue;
          return { event: event.slice('event: '.length), data: data.slice('data: '.length) };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('stream ended before the expected frame');
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    },
  };
}

test('CloudCLI Settings recovery exposes only dedicated account identity and the device-auth handoff', async () => {
  let starts = 0;
  await withServer({
    enabled: true,
    service: service({
      async startAuthLogin() {
        starts += 1;
        return { phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 123, error: null };
      },
    }),
  }, async (url) => {
    const account = await fetch(`${url}/account`);
    assert.equal(account.status, 200);
    const accountPayload = await account.json() as { email: string; detail: string };
    assert.deepEqual(accountPayload, { signedIn: true, detail: 'Logged in using ChatGPT', email: 'production@example.test', authMode: 'chatgpt', error: null });
    assert.equal(JSON.stringify(accountPayload).includes('token'), false);

    const unconfirmed = await fetch(`${url}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unconfirmed.status, 409);
    assert.equal(starts, 0);

    const start = await fetch(`${url}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmPausedRuns: true }) });
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), { phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 123, error: null });
    assert.equal(starts, 1);
  });
});

test('CloudCLI Settings recovery remains unavailable when the ScreenScript channel is disabled', async () => {
  await withServer({ enabled: false, service: service() }, async (url) => {
    const response = await fetch(`${url}/account`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'SCREENSCRIPT_AGENT_CHANNEL_DISABLED' });
  });
});

test('CloudCLI Settings recovery exposes plan-limit windows for the isolated profile', async () => {
  await withServer({ enabled: true, service: service() }, async (url) => {
    const response = await fetch(`${url}/usage`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      limits: [{ id: 'codex', name: null, planType: 'plus', windows: [{ kind: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: null }] }],
    });
  });
});

test('CloudCLI Settings recovery reports a safe error when the isolated profile cannot be reached', async () => {
  await withServer({
    enabled: true,
    service: service({ readRateLimits: async () => { throw new Error('Codex app-server exited (1). auth.json missing'); } }),
  }, async (url) => {
    const response = await fetch(`${url}/usage`);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'SCREENSCRIPT_AGENT_USAGE_FAILED' });
  });
});

test('CloudCLI Settings runs surface lists recorded turns and replays a single run', async () => {
  const runs = createScreenscriptRunRegistry();
  runs.beginRun({ runId: 'ss2-alpha', model: 'gpt-5-codex' });
  runs.record('ss2-alpha', { kind: 'text', id: 'm1', content: 'анализ исходников' });
  runs.record('ss2-alpha', { kind: 'tool_use', id: 't1', toolName: 'Bash', toolInput: { command: 'ffprobe' } });
  runs.endRun('ss2-alpha', { ok: false, errorCode: 'SCREENSCRIPT_AGENT_CODEX_LIMIT_REACHED' });

  await withServer({ enabled: true, service: service(), runs }, async (url) => {
    const list = await fetch(`${url}/runs`);
    assert.equal(list.status, 200);
    const payload = await list.json() as { runs: Array<{ runId: string; status: string; eventCount: number; errorCode: string | null }> };
    assert.equal(payload.runs.length, 1);
    assert.equal(payload.runs[0].runId, 'ss2-alpha');
    assert.equal(payload.runs[0].status, 'failed');
    assert.equal(payload.runs[0].eventCount, 2);
    assert.equal(payload.runs[0].errorCode, 'SCREENSCRIPT_AGENT_CODEX_LIMIT_REACHED');

    const detail = await fetch(`${url}/runs/ss2-alpha`);
    assert.equal(detail.status, 200);
    const body = await detail.json() as { run: { runId: string }; events: Array<{ kind: string; label: string }> };
    assert.equal(body.run.runId, 'ss2-alpha');
    assert.deepEqual(body.events.map((event) => event.kind), ['text', 'tool_use']);
    assert.equal(body.events[1].label, 'Bash');

    const missing = await fetch(`${url}/runs/ss2-unknown`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'SCREENSCRIPT_RUN_NOT_FOUND' });

    const invalid = await fetch(`${url}/runs/${encodeURIComponent('bad id')}`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'SCREENSCRIPT_RUN_ID_INVALID' });
  });
});

test('CloudCLI Settings runs surface stays unavailable when the ScreenScript channel is disabled', async () => {
  await withServer({ enabled: false, service: service() }, async (url) => {
    const list = await fetch(`${url}/runs`);
    assert.equal(list.status, 503);
    assert.deepEqual(await list.json(), { error: 'SCREENSCRIPT_AGENT_CHANNEL_DISABLED' });

    const stream = await fetch(`${url}/runs/ss2-alpha/stream`);
    assert.equal(stream.status, 503);
  });
});

test('CloudCLI Settings run stream replays history, follows live events and ends with the run', async () => {
  const runs = createScreenscriptRunRegistry();
  runs.beginRun({ runId: 'ss2-live', model: 'gpt-5-codex' });
  runs.record('ss2-live', { kind: 'text', id: 'm1', content: 'первый' });

  await withServer({ enabled: true, service: service(), runs }, async (url) => {
    const response = await fetch(`${url}/runs/ss2-live/stream`);
    assert.equal(response.status, 200);
    const frames = frameReader(response.body as ReadableStream<Uint8Array>);
    try {
      const opened = await frames.next();
      assert.equal(opened.event, 'run');
      assert.equal((JSON.parse(opened.data) as { runId: string }).runId, 'ss2-live');

      const replayed = await frames.next();
      assert.equal(replayed.event, 'event');
      assert.equal((JSON.parse(replayed.data) as { text: string }).text, 'первый');

      // A late subscriber must see events recorded after it connected.
      runs.record('ss2-live', { kind: 'tool_use', id: 't1', toolName: 'Bash', toolInput: { command: 'ls' } });
      const live = await frames.next();
      assert.equal(live.event, 'event');
      assert.equal((JSON.parse(live.data) as { label: string }).label, 'Bash');

      runs.endRun('ss2-live', { ok: true });
      const done = await frames.next();
      assert.equal(done.event, 'done');
      assert.equal((JSON.parse(done.data) as { status: string }).status, 'completed');
    } finally {
      await frames.close();
    }
  });
});
