import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { createScreenscriptRunProjectsService } from '../screenscript-run-projects.service.js';

const RUNS_ROOT = '/data/workspaces/screenscript-agent-runs';

type ProjectRow = { isArchived: boolean };

function harness(overrides: {
  enabled?: boolean;
  rows?: Map<string, ProjectRow>;
  created?: Array<{ path: string; name: string }>;
  failCreate?: boolean;
  failArchive?: boolean;
  runIds?: string[];
} = {}) {
  const rows = overrides.rows ?? new Map<string, ProjectRow>();
  const created = overrides.created ?? [];
  const service = createScreenscriptRunProjectsService({
    runsRoot: RUNS_ROOT,
    enabled: overrides.enabled ?? true,
    getProjectByPath: (projectPath) => rows.get(projectPath) ?? null,
    createRunProject: async (projectPath, customName) => {
      if (overrides.failCreate) throw new Error('workspace registration exploded');
      created.push({ path: projectPath, name: customName });
      rows.set(projectPath, { isArchived: false });
    },
    archiveProjectByPath: (projectPath, isArchived) => {
      if (overrides.failArchive) throw new Error('project table closed');
      const row = rows.get(projectPath);
      if (row) row.isArchived = isArchived;
    },
    listRunIds: async () => overrides.runIds ?? [],
  });
  return { service, rows, created };
}

test('run projects service registers a run workspace once, named after the run', async () => {
  const { service, created } = harness();

  await service.ensureRunProject('ss2-alpha');
  await service.ensureRunProject('ss2-alpha');

  assert.equal(created.length, 1);
  assert.equal(created[0].path, path.join(RUNS_ROOT, 'ss2-alpha'));
  assert.equal(created[0].name, 'ScreenScript · ss2-alpha');
});

test('run projects service brings back an archived run folder for a resumed run', async () => {
  const archivedPath = path.join(RUNS_ROOT, 'ss2-beta');
  const { service, created, rows } = harness({ rows: new Map([[archivedPath, { isArchived: true }]]) });

  await service.ensureRunProject('ss2-beta');

  assert.equal(created.length, 1);
  assert.equal(rows.get(archivedPath)?.isArchived, false);
});

test('run projects service archives the folder once the worker deletes the workspace', () => {
  const projectPath = path.join(RUNS_ROOT, 'ss2-gamma');
  const { service, rows } = harness({ rows: new Map([[projectPath, { isArchived: false }]]) });

  service.archiveRunProject('ss2-gamma');

  assert.equal(rows.get(projectPath)?.isArchived, true);
});

test('run projects service picks up run folders that already exist on disk', async () => {
  const { service, created } = harness({ runIds: ['ss2-old', 'ss2-mu66ecde-6e6yxi46'] });

  assert.equal(await service.registerExistingRunProjects(), 2);
  assert.deepEqual(created.map((entry) => path.basename(entry.path)), ['ss2-old', 'ss2-mu66ecde-6e6yxi46']);
});

test('run projects service survives a broken project store without touching the turn', async () => {
  const { service } = harness({ failCreate: true, failArchive: true });

  await service.ensureRunProject('ss2-delta');
  service.archiveRunProject('ss2-delta');
});

test('run projects service does nothing while the ScreenScript channel is disabled', async () => {
  const { service, created } = harness({ enabled: false, runIds: ['ss2-old'] });

  await service.ensureRunProject('ss2-epsilon');
  service.archiveRunProject('ss2-epsilon');

  assert.equal(await service.registerExistingRunProjects(), 0);
  assert.deepEqual(created, []);
});
