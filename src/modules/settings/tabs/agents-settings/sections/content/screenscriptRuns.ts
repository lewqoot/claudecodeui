/**
 * Client-side view model for the live ScreenScript run feed.
 *
 * Kept free of React so the merge rules (which decide whether Codex updated a
 * row in place or produced a new one) can be unit-tested on their own.
 */

export type ScreenscriptRunStatus = 'running' | 'completed' | 'failed';

export type ScreenscriptRunEvent = {
  seq: number;
  at: number;
  kind: string;
  messageId: string | null;
  label: string;
  text: string;
  isError: boolean;
  payload?: unknown;
};

export type ScreenscriptRunSnapshot = {
  runId: string;
  status: ScreenscriptRunStatus;
  startedAt: number;
  updatedAt: number;
  finishedAt: number | null;
  sessionId: string | null;
  model: string | null;
  eventCount: number;
  droppedEvents: number;
  lastLabel: string | null;
  errorCode: string | null;
  truncated: boolean;
};

export type ScreenscriptRunDetail = {
  run: ScreenscriptRunSnapshot;
  events: ScreenscriptRunEvent[];
};

/**
 * Codex reuses a row id while a tool call is still running, so an update must
 * replace the row it already sent instead of appending a second copy.
 */
export function mergeRunEvent(
  events: ScreenscriptRunEvent[],
  next: ScreenscriptRunEvent,
): ScreenscriptRunEvent[] {
  if (!next.messageId) return [...events, next];
  const index = events.findIndex((event) => event.messageId === next.messageId);
  if (index < 0) return [...events, next];
  const merged = [...events];
  merged[index] = next;
  return merged;
}

/** Local wall-clock time of one event, stable across locales for the log column. */
export function formatRunClock(value: number): string {
  const date = new Date(value);
  const pad = (part: number): string => String(part).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Prefers a run that is still working, so opening Settings lands on live work. */
export function pickDefaultRunId(runs: ScreenscriptRunSnapshot[]): string | null {
  return runs.find((run) => run.status === 'running')?.runId ?? runs[0]?.runId ?? null;
}

/** Keeps the DOM bounded when a long turn produced thousands of events. */
export function tailEvents(events: ScreenscriptRunEvent[], limit = 500): ScreenscriptRunEvent[] {
  return events.length > limit ? events.slice(events.length - limit) : events;
}

export function stringifyRunPayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? '';
  } catch {
    return '';
  }
}
