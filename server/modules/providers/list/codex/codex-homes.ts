import os from 'node:os';
import path from 'node:path';

/**
 * Codex writes its transcripts under `$CODEX_HOME/sessions`. The default home is
 * whatever `CODEX_HOME` points at (the container sets it to `/data`), falling
 * back to `~/.codex`; isolated profiles such as the ScreenScript agent profile
 * live elsewhere and are named in `CODEX_ADDITIONAL_HOMES` (comma-separated) so
 * their conversations reach the sidebar too.
 */
function configuredHomes(): string[] {
  return (process.env.CODEX_ADDITIONAL_HOMES ?? '')
    .split(',')
    .map((home) => home.trim())
    .filter((home) => home.length > 0);
}

/** The profile Codex uses when nothing else is configured. */
export function defaultCodexHome(): string {
  const configured = (process.env.CODEX_HOME ?? '').trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex');
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

/**
 * The profile a transcript file belongs to; unknown paths fall back to the
 * default home. The longest matching prefix wins, because an extra profile can
 * live inside the default one (`/data` and `/data/.codex-screenscript-agent`).
 */
export function codexHomeForFile(filePath: string): string {
  const resolved = path.resolve(filePath);
  let match: string | null = null;
  for (const home of codexHomes()) {
    const base = path.resolve(home);
    if (!resolved.startsWith(`${base}${path.sep}`)) continue;
    if (match === null || base.length > path.resolve(match).length) match = home;
  }
  return match ?? defaultCodexHome();
}
