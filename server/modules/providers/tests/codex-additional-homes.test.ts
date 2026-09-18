import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { CodexSessionSynchronizer } from '@/modules/providers/list/codex/codex-session-synchronizer.provider.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

async function withIsolatedDatabase(runTest: () => void | Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'codex-additional-homes-db-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await initializeDatabase();

  try {
    await runTest();
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

/**
 * Writes one Codex rollout under an explicit home, the way an isolated profile
 * (for example the ScreenScript agent profile) does.
 */
const writeRollout = async (
  home: string,
  sessionId: string,
  workspacePath: string,
  message?: string,
): Promise<string> => {
  const sessionsDirectory = path.join(home, 'sessions', '2026', '09', '18');
  await mkdir(sessionsDirectory, { recursive: true });
  const lines = [JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd: workspacePath } })];
  if (message) {
    lines.push(JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message } }));
  }
  const filePath = path.join(sessionsDirectory, `rollout-${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

test('Codex synchronizer indexes conversations from profiles named in CODEX_ADDITIONAL_HOMES', { concurrency: false }, async () => {
  const defaultHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-default-'));
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-agent-'));
  const workspacePath = path.join(defaultHome, 'workspaces', 'screenscript-agent-runs', 'ss2-run-1');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(defaultHome);
  const previousAdditionalHomes = process.env.CODEX_ADDITIONAL_HOMES;
  process.env.CODEX_ADDITIONAL_HOMES = agentHome;

  try {
    await writeRollout(agentHome, 'codex-agent-1', workspacePath, 'анализ исходников');
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      assert.equal(await synchronizer.synchronize(), 1);

      const session = sessionsDb.getSessionById('codex-agent-1');
      assert.equal(session?.provider, 'codex');
      assert.equal(session?.project_path, workspacePath);
      assert.equal(session?.jsonl_path, path.join(agentHome, 'sessions', '2026', '09', '18', 'rollout-codex-agent-1.jsonl'));
    });
  } finally {
    if (previousAdditionalHomes === undefined) {
      delete process.env.CODEX_ADDITIONAL_HOMES;
    } else {
      process.env.CODEX_ADDITIONAL_HOMES = previousAdditionalHomes;
    }
    restoreHomeDir();
    await rm(defaultHome, { recursive: true, force: true });
    await rm(agentHome, { recursive: true, force: true });
  }
});

test('Codex synchronizer indexes one watched file from an extra profile', { concurrency: false }, async () => {
  const defaultHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-default-'));
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-agent-'));
  const workspacePath = path.join(defaultHome, 'workspaces', 'screenscript-agent-runs', 'ss2-run-2');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(defaultHome);
  const previousAdditionalHomes = process.env.CODEX_ADDITIONAL_HOMES;
  process.env.CODEX_ADDITIONAL_HOMES = agentHome;

  try {
    const filePath = await writeRollout(agentHome, 'codex-agent-2', workspacePath);
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      assert.equal(await synchronizer.synchronizeFile(filePath), 'codex-agent-2');
      assert.equal(sessionsDb.getSessionById('codex-agent-2')?.project_path, workspacePath);
    });
  } finally {
    if (previousAdditionalHomes === undefined) {
      delete process.env.CODEX_ADDITIONAL_HOMES;
    } else {
      process.env.CODEX_ADDITIONAL_HOMES = previousAdditionalHomes;
    }
    restoreHomeDir();
    await rm(defaultHome, { recursive: true, force: true });
    await rm(agentHome, { recursive: true, force: true });
  }
});

test('Codex synchronizer keeps the default profile when no extra homes are configured', { concurrency: false }, async () => {
  const defaultHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-default-'));
  const workspacePath = path.join(defaultHome, 'workspaces', 'my');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(defaultHome);
  const previousAdditionalHomes = process.env.CODEX_ADDITIONAL_HOMES;
  delete process.env.CODEX_ADDITIONAL_HOMES;

  try {
    // The app's own profile is `~/.codex`, not the home itself.
    await writeRollout(path.join(defaultHome, '.codex'), 'codex-default-1', workspacePath);
    await withIsolatedDatabase(async () => {
      assert.equal(await new CodexSessionSynchronizer().synchronize(), 1);
      assert.equal(sessionsDb.getSessionById('codex-default-1')?.project_path, workspacePath);
    });
  } finally {
    if (previousAdditionalHomes !== undefined) {
      process.env.CODEX_ADDITIONAL_HOMES = previousAdditionalHomes;
    }
    restoreHomeDir();
    await rm(defaultHome, { recursive: true, force: true });
  }
});

test('Codex synchronizer reads a newly configured profile in full despite the global scan cursor', { concurrency: false }, async () => {
  const defaultHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-default-'));
  const agentHome = await mkdtemp(path.join(os.tmpdir(), 'codex-home-agent-'));
  const workspacePath = path.join(defaultHome, 'workspaces', 'screenscript-agent-runs', 'ss2-run-3');
  await mkdir(workspacePath, { recursive: true });
  const restoreHomeDir = patchHomeDir(defaultHome);
  const previousAdditionalHomes = process.env.CODEX_ADDITIONAL_HOMES;
  process.env.CODEX_ADDITIONAL_HOMES = agentHome;

  try {
    await writeRollout(agentHome, 'codex-agent-3', workspacePath);
    await withIsolatedDatabase(async () => {
      const synchronizer = new CodexSessionSynchronizer();
      // A cursor that already sits past the transcript must not hide a profile
      // the process is seeing for the first time.
      assert.equal(await synchronizer.synchronize(new Date(Date.now() + 60_000)), 1);
      assert.equal(sessionsDb.getSessionById('codex-agent-3')?.project_path, workspacePath);
      // Later passes respect the cursor again instead of re-reading the profile.
      assert.equal(await synchronizer.synchronize(new Date(Date.now() + 120_000)), 0);
    });
  } finally {
    if (previousAdditionalHomes === undefined) {
      delete process.env.CODEX_ADDITIONAL_HOMES;
    } else {
      process.env.CODEX_ADDITIONAL_HOMES = previousAdditionalHomes;
    }
    restoreHomeDir();
    await rm(defaultHome, { recursive: true, force: true });
    await rm(agentHome, { recursive: true, force: true });
  }
});
