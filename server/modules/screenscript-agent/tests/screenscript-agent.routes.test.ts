import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createScreenscriptAgentRouter } from '../screenscript-agent.routes.js';

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
  await withServer({ enabled: true, apiSecret: 'api-secret', channelSecret: 'channel-secret', service: { runTurn: async () => undefined, removeRun: async () => false } }, async (url) => {
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
    service: {
      async removeRun() { return false; },
      async runTurn(input, writer) {
        calls.push(input);
        writer.setSessionId?.('session-1');
        writer.send({ kind: 'text', role: 'assistant', content: '{"action":"prepare"}', sessionId: 'session-1' });
        writer.send({ kind: 'complete', success: true, exitCode: 0, sessionId: 'session-1' });
      },
    },
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
    service: {
      async runTurn() {},
      async removeRun(runId) { removedRunIds.push(runId); return true; },
    },
  }, async (url) => {
    const denied = await fetch(`${url}/run-1`, { method: 'DELETE', headers: { 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'wrong' } });
    assert.equal(denied.status, 403);
    const response = await fetch(`${url}/run-1`, { method: 'DELETE', headers: { 'x-api-key': 'api-secret', 'x-screenscript-agent-key': 'channel-secret' } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { removed: true });
  });
  assert.deepEqual(removedRunIds, ['run-1']);
});
