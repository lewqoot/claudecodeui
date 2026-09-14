import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createScreenscriptAgentRouter } from '../screenscript-agent.routes.js';

type RouterOptions = Parameters<typeof createScreenscriptAgentRouter>[0];

function service(overrides: Partial<RouterOptions['service']> = {}): RouterOptions['service'] {
  return {
    authProgress: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    cancelAuthLogin: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    readAuthStatus: async () => ({ signedIn: true, detail: 'Logged in using ChatGPT', email: 'agent@example.test', authMode: 'chatgpt', error: null }),
    startAuthLogin: async () => ({ phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 1, error: null }),
    runTurn: async () => undefined,
    removeRun: async () => false,
    ...overrides,
  };
}

async function withServer(
  options: Parameters<typeof createScreenscriptAgentRouter>[0],
  run: (url: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/screenscript-agent', createScreenscriptAgentRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/screenscript-agent`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('ScreenScript route requires both the CloudCLI API key and its dedicated channel secret', async () => {
  await withServer({ enabled: true, apiSecret: 'api-secret', channelSecret: 'channel-secret', service: service() }, async (url) => {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'wrong-secret' },
      body: JSON.stringify({ runId: 'run-1', message: 'Return JSON', model: 'gpt-test' }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'SCREENSCRIPT_AGENT_CHANNEL_FORBIDDEN' });

    const wrongApiKey = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-api-key', 'x-screenscript-agent-key': 'channel-secret' },
      body: JSON.stringify({ runId: 'run-1', message: 'Return JSON', model: 'gpt-test' }),
    });
    assert.equal(wrongApiKey.status, 403);
  });
});

test('ScreenScript route streams only the isolated service result', async () => {
  const calls: any[] = [];
  await withServer({
    enabled: true, apiSecret: 'api-secret',
    channelSecret: 'channel-secret',
    service: service({
      async removeRun() { return false; },
      async runTurn(input, writer) {
        calls.push(input);
        writer.setSessionId?.('session-1');
        writer.send({ kind: 'text', role: 'assistant', content: '{"action":"prepare"}', sessionId: 'session-1' });
        writer.send({ kind: 'complete', success: true, exitCode: 0, sessionId: 'session-1' });
      },
    }),
  }, async (url) => {
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'channel-secret' },
      body: JSON.stringify({ runId: 'run-1', message: 'Return JSON', model: 'gpt-test', evidence: [] }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /\\"action\\":\\"prepare\\"/);
    assert.match(body, /"type":"done"/);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, 'run-1');
});

test('ScreenScript route removes only the requested isolated run through the authenticated channel', async () => {
  const removedRunIds: string[] = [];
  await withServer({
    enabled: true, apiSecret: 'api-secret',
    channelSecret: 'channel-secret',
    service: service({
      async runTurn() {},
      async removeRun(runId) { removedRunIds.push(runId); return true; },
    }),
  }, async (url) => {
    const denied = await fetch(`${url}/run-1`, { method: 'DELETE', headers: { 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'wrong' } });
    assert.equal(denied.status, 403);
    const response = await fetch(`${url}/run-1`, { method: 'DELETE', headers: { 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'channel-secret' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removed: true });
  });
  assert.deepEqual(removedRunIds, ['run-1']);
});

test('ScreenScript auth recovery is private and requires explicit paused-run confirmation', async () => {
  let starts = 0;
  await withServer({
    enabled: true, apiSecret: 'api-secret', channelSecret: 'channel-secret',
    service: service({
      async startAuthLogin() {
        starts += 1;
        return { phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 123, error: null };
      },
    }),
  }, async (url) => {
    const headers = { 'content-type': 'application/json', 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'channel-secret' };
    const denied = await fetch(`${url}/auth/account`, { headers: { 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'wrong' } });
    assert.equal(denied.status, 403);

    const account = await fetch(`${url}/auth/account`, { headers });
    assert.equal(account.status, 200);
    assert.deepEqual(await account.json(), { signedIn: true, detail: 'Logged in using ChatGPT', email: 'agent@example.test', authMode: 'chatgpt', error: null });

    const unconfirmed = await fetch(`${url}/auth/start`, { method: 'POST', headers, body: '{}' });
    assert.equal(unconfirmed.status, 409);
    assert.equal(starts, 0);

    const started = await fetch(`${url}/auth/start`, { method: 'POST', headers, body: JSON.stringify({ confirmPausedRuns: true }) });
    assert.equal(started.status, 200);
    assert.equal((await started.json() as { userCode: string }).userCode, 'ABCD-EFGH');
    assert.equal(starts, 1);
  });
});

test('ScreenScript route maps provider auth failures to a safe actionable code', async () => {
  await withServer({
    enabled: true, apiSecret: 'api-secret', channelSecret: 'channel-secret',
    service: service({ async runTurn() { throw new Error('401 Unauthorized: token_revoked with internal provider details'); } }),
  }, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'channel-secret' },
      body: JSON.stringify({ runId: 'run-1', message: 'Return JSON', model: 'gpt-test' }),
    });
    const body = await response.text();
    assert.match(body, /SCREENSCRIPT_AGENT_CODEX_AUTH_INVALID/);
    assert.doesNotMatch(body, /internal provider details/);
  });
});
