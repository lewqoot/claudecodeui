import * as fs from 'node:fs/promises';

import type { ProviderRunFunction } from '@/shared/index.js';
import { providerModelsService } from '@/modules/providers/index.js';

import { createScreenscriptAgentRouter } from './screenscript-agent.routes.js';
import { createScreenscriptAgentService } from './screenscript-agent.service.js';

type ModuleDependencies = {
  queryCodex: ProviderRunFunction;
  environment?: NodeJS.ProcessEnv;
};

/**
 * Assembles the private ScreenScript agent channel for the server entrypoint.
 * It is disabled unless both the feature flag and a dedicated secret exist.
 */
export function createScreenscriptAgentModule(dependencies: ModuleDependencies) {
  const environment = dependencies.environment ?? process.env;
  const enabled = environment.SCREENSCRIPT_AGENT_CHANNEL_ENABLED === 'true';
  const channelSecret = String(environment.SCREENSCRIPT_AGENT_CHANNEL_KEY ?? '');
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
  });
  return createScreenscriptAgentRouter({ enabled: enabled && Boolean(channelSecret), channelSecret, service });
}
