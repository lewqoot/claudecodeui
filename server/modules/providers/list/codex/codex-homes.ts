import os from 'node:os';
import path from 'node:path';

/**
 * Codex writes its transcripts under `$CODEX_HOME/sessions`. The app's own home
 * is `~/.codex`, but isolated profiles (for example the ScreenScript agent
 * profile) live elsewhere, so operators can name them in
 * `CODEX_ADDITIONAL_HOMES` (comma-separated) to get their conversations into
 * the sidebar as well.
 */
function configuredHomes(): string[] {
  return (process.env.CODEX_ADDITIONAL_HOMES ?? '')
    .split(',')
    .map((home) => home.trim())
    .filter((home) => home.length > 0);
}

/** The profile Codex uses when nothing else is configured. */
export function defaultCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

/** Every profile this process indexes: the default one first, extras de-duplicated. */
export function codexHomes(): string[] {
  const homes = [defaultCodexHome()];
  for (const home of configuredHomes()) {
    const resolved = path.resolve(home);
    if (!homes.includes(resolved)) {
      homes.push(resolved);
    }
  }
  return homes;
}

/** The profile a transcript file belongs to; unknown paths fall back to the default home. */
export function codexHomeForFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  return codexHomes().find((home) => resolved.startsWith(`${path.resolve(home)}${path.sep}`))
    ?? defaultCodexHome();
}
