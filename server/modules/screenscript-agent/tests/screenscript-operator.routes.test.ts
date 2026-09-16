import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express from 'express';

import { createScreenscriptOperatorRouter } from '../screenscript-operator.routes.js';

type OperatorOptions = Parameters<typeof createScreenscriptOperatorRouter>[0];

function service(overrides: Partial<OperatorOptions['service']> = {}): OperatorOptions['service'] {
  return {
    authProgress: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    cancelAuthLogin: () => ({ phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null }),
    readAuthStatus: async () => ({ signedIn: true, detail: 'Logged in using ChatGPT', email: 'production@example.test', authMode: 'chatgpt', error: null }),
    startAuthLogin: async () => ({ phase: 'waiting', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH', expiresAt: 1, error: null }),
    ...overrides,
  };
}

async function withServer(
  options: OperatorOptions,
  run: (url: string) => Promise<void>,
) {
  const app = express();
  app.use(express.json());
  app.use('/api/screenscript-operator', createScreenscriptOperatorRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/screenscript-operator`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
