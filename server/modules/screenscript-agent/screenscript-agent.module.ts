import * as fs from 'node:fs/promises';

import type { ProviderRunFunction } from '@/shared/index.js';
import { providerModelsService } from '@/modules/providers/index.js';

import { createScreenscriptAgentRouter } from './screenscript-agent.routes.js';
import { createScreenscriptAgentAuthService } from './screenscript-agent-auth.service.js';
import { createScreenscriptAgentService } from './screenscript-agent.service.js';
import { createScreenscriptAgentUsageService } from './screenscript-agent-usage.service.js';
import { createScreenscriptOperatorRouter } from './screenscript-operator.routes.js';
import { createScreenscriptRunProjectsService } from './screenscript-run-projects.service.js';
import { createScreenscriptRunRegistry } from './screenscript-run-registry.js';

type ModuleDependencies = {
  queryCodex: ProviderRunFunction;
  environment?: NodeJS.ProcessEnv;
};

/**
 * Assembles the private worker channel and the separately authenticated
 * CloudCLI Settings surfaces for the server entrypoint: account recovery, plan
 * limits and the live run feed, which share one in-process run registry.
 */
export function createScreenscriptAgentModule(dependencies: ModuleDependencies) {
  const environment = dependencies.environment ?? process.env;
  const enabled = environment.SCREENSCRIPT_AGENT_CHANNEL_ENABLED === 'true';
  const apiSecret = String(environment.CLOUDCLI_API_KEY ?? '');
  const channelSecret = String(environment.SCREENSCRIPT_AGENT_CHANNEL_KEY ?? '');
  if (enabled && apiSecret.length < 24) throw new Error('CLOUDCLI_API_KEY_INVALID');
  if (enabled && channelSecret.length < 32) throw new Error('SCREENSCRIPT_AGENT_CHANNEL_KEY_INVALID');
  const runsRoot = environment.SCREENSCRIPT_AGENT_RUNS_ROOT || '/data/workspaces/screenscript-agent-runs';
  const codexHome = environment.SCREENSCRIPT_AGENT_CODEX_HOME || '/data/.codex-screenscript-agent';
  const service = createScreenscriptAgentService({
    fileSystem: fs,
    queryCodex: dependencies.queryCodex,
    models: providerModelsService,
    runsRoot,
    codexHome,
    processEnvironment: environment,
    // The private channel calls Codex directly and never passes through the chat
    // send path, so this is the only place that records the real model on the
    // session row the sidebar and the composer read.
    recordSessionModel: ({ sessionId, model, effort }) => {
      providerModelsService.setSessionModel('codex', sessionId, model);
      if (effort) providerModelsService.setSessionEffort('codex', sessionId, effort);
    },
  });
  const codexBin = environment.SCREENSCRIPT_AGENT_CODEX_BIN || '/app/node_modules/.bin/codex';
  const authService = createScreenscriptAgentAuthService({
    codexHome,
    codexBin,
    processEnvironment: environment,
  });
  const usageService = createScreenscriptAgentUsageService({
    codexHome,
    codexBin,
    processEnvironment: environment,
  });
  const channelEnabled = enabled && Boolean(apiSecret) && Boolean(channelSecret);
  const runs = createScreenscriptRunRegistry();
  const runProjects = createScreenscriptRunProjectsService({ runsRoot, enabled: channelEnabled });
  return {
    workerRouter: createScreenscriptAgentRouter({
      enabled: channelEnabled,
      apiSecret,
      channelSecret,
      runs,
      runProjects,
      service: { ...service, ...authService },
    }),
    operatorRouter: createScreenscriptOperatorRouter({
      enabled: channelEnabled,
      runs,
      service: { ...authService, ...usageService },
    }),
    /**
     * Called once the database is ready: run folders that already exist on disk
     * (older runs, or runs that survived a restart) become sidebar projects.
     */
    registerExistingRunProjects: () => runProjects.registerExistingRunProjects(),
  };
}
