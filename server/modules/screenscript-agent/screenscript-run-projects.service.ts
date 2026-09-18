import fs from 'node:fs/promises';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { createProject } from '@/modules/projects/index.js';

/**
 * ScreenScript runs live as their own workspace directories under the agent
 * runs root. The CloudCLI sidebar lists projects from the database, so a run
 * only becomes visible as a folder once its path is registered here.
 */
export type ScreenscriptRunProjects = {
  projectPathFor(runId: string): string;
  ensureRunProject(runId: string, ticket?: string | null): Promise<void>;
  registerExistingRunProjects(): Promise<number>;
  archiveRunProject(runId: string): void;
};

type ProjectRow = {
  isArchived?: number | boolean | null;
  custom_project_name?: string | null;
};

type Dependencies = {
  runsRoot: string;
  enabled: boolean;
  createRunProject?: (projectPath: string, customName: string) => Promise<void>;
  getProjectByPath?: (projectPath: string) => ProjectRow | null;
  renameProjectByPath?: (projectPath: string, customName: string) => void;
  archiveProjectByPath?: (projectPath: string, isArchived: boolean) => void;
  listRunIds?: () => Promise<string[]>;
};

const defaultDependencies = {
  createRunProject: async (projectPath: string, customName: string): Promise<void> => {
    await createProject({ projectPath, customName });
  },
  getProjectByPath: (projectPath: string): ProjectRow | null => projectsDb.getProjectPath(projectPath),
  renameProjectByPath: (projectPath: string, customName: string): void => {
    projectsDb.updateCustomProjectName(projectPath, customName);
  },
  archiveProjectByPath: (projectPath: string, isArchived: boolean): void => {
    projectsDb.updateProjectIsArchived(projectPath, isArchived);
  },
  listRunIds: async (runsRoot: string): Promise<string[]> => {
    const entries = await fs.readdir(runsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  },
};

/**
 * The worker's project name is the input Jira ticket (`GAGAPPQ-26`). It is the
 * only human-meaningful handle an operator has for a run folder whose path is a
 * generated `ss2-…` id, so it leads the sidebar label.
 */
const TICKET_PATTERN = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

function normalizeTicket(ticket: string | null | undefined): string {
  const value = typeof ticket === 'string' ? ticket.trim().toUpperCase() : '';
  return TICKET_PATTERN.test(value) ? value : '';
}

function runProjectName(runId: string, ticket: string | null | undefined): string {
  const normalized = normalizeTicket(ticket);
  return normalized ? `${normalized} · ${runId}` : `ScreenScript · ${runId}`;
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

/**
 * Registers one project per run workspace so a live run shows up in the sidebar
 * as its own folder, and archives that folder once its workspace is removed.
 *
 * Project rows are derived state for a convenience surface: a refused or
 * concurrent registration must never interrupt the agent turn itself, so every
 * failure is logged and swallowed.
 */
export function createScreenscriptRunProjectsService(dependencies: Dependencies): ScreenscriptRunProjects {
  const runsRoot = path.resolve(dependencies.runsRoot);
  const createRunProject = dependencies.createRunProject ?? defaultDependencies.createRunProject;
  const getProjectByPath = dependencies.getProjectByPath ?? defaultDependencies.getProjectByPath;
  const renameProjectByPath = dependencies.renameProjectByPath ?? defaultDependencies.renameProjectByPath;
  const archiveProjectByPath = dependencies.archiveProjectByPath ?? defaultDependencies.archiveProjectByPath;
  const listRunIds = dependencies.listRunIds
    ?? (() => defaultDependencies.listRunIds(runsRoot));

  const projectPathFor = (runId: string): string => path.join(runsRoot, runId);

  const ensureRunProject = async (runId: string, ticket?: string | null): Promise<void> => {
    if (!dependencies.enabled || !runId) return;
    const projectPath = projectPathFor(runId);
    const ticketValue = normalizeTicket(ticket);
    const desiredName = runProjectName(runId, ticketValue);
    const existing = getProjectByPath(projectPath);
    // An archived row is reactivated by createProject, which is what a resumed
    // run needs: its folder must come back to the sidebar, not stay hidden.
    if (!existing || existing.isArchived) {
      try {
        await createRunProject(projectPath, desiredName);
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'PROJECT_ALREADY_EXISTS') {
          console.warn('[Screenscript] Could not register the run project', { runId, code });
        }
      }
    }
    if (!ticketValue) return;
    // The folder may already be registered under the old `ScreenScript · …`
    // label (a run started before this feature, or a paused run resumed later).
    // Relabel it so the sidebar shows the ticket for the run currently working.
    const current = getProjectByPath(projectPath);
    if (current && current.custom_project_name !== desiredName) {
      try {
        renameProjectByPath(projectPath, desiredName);
      } catch (error) {
        console.warn('[Screenscript] Could not relabel the run project', {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  return {
    projectPathFor,

    ensureRunProject,

    /**
     * Picks up run folders that already exist on disk (runs started before this
     * feature, or while the process was restarting) so their conversations are
     * reachable from the sidebar too.
     */
    async registerExistingRunProjects(): Promise<number> {
      if (!dependencies.enabled) return 0;
      let runIds: string[];
      try {
        runIds = await listRunIds();
      } catch (error) {
        const code = errorCode(error);
        if (code !== 'ENOENT') {
          console.warn('[Screenscript] Could not scan the runs root for existing runs', { code });
        }
        return 0;
      }

      let registered = 0;
      for (const runId of runIds) {
        const before = getProjectByPath(projectPathFor(runId));
        await ensureRunProject(runId);
        const after = getProjectByPath(projectPathFor(runId));
        if (!before && after) registered += 1;
      }
      return registered;
    },

    archiveRunProject(runId: string): void {
      if (!dependencies.enabled || !runId) return;
      try {
        archiveProjectByPath(projectPathFor(runId), true);
      } catch (error) {
        console.warn('[Screenscript] Could not archive the run project', {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
