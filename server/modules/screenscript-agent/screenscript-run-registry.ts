import type { ProviderRuntimeWriter } from '@/shared/index.js';

// Run ids are minted by the ScreenScript worker (`ss2-…`), so the registry keeps
// the same conservative shape the private channel already enforces.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_MAX_RUNS = 25;
const DEFAULT_MAX_EVENTS_PER_RUN = 1_500;
const DEFAULT_MAX_PAYLOAD_CHARS = 16_000;
const MAX_TEXT_CHARS = 4_000;

export type ScreenscriptRunStatus = 'running' | 'completed' | 'failed';

/**
 * One normalized provider event, reduced to what a live feed needs to render.
 *
 * `messageId` mirrors the provider row id, which Codex reuses when it updates a
 * row in place (a running command's output streams into the same id), so the UI
 * can replace a row instead of appending a duplicate.
 */
export type ScreenscriptRunEvent = {
  seq: number;
  at: number;
  kind: string;
  messageId: string | null;
  label: string;
  text: string;
  isError: boolean;
  payload: unknown;
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

export type ScreenscriptRunMessage =
  | { type: 'event'; event: ScreenscriptRunEvent }
  | { type: 'end'; run: ScreenscriptRunSnapshot };

export type ScreenscriptRunInput = {
  runId: string;
  model?: string | null;
};

export type ScreenscriptRunOutcome = {
  ok: boolean;
  errorCode?: string | null;
};

export type ScreenscriptRunRegistryOptions = {
  maxRuns?: number;
  maxEventsPerRun?: number;
  maxPayloadChars?: number;
};

export type ScreenscriptRunRegistry = {
  isRunId(value: unknown): boolean;
  beginRun(input: ScreenscriptRunInput): void;
  record(runId: string, data: unknown): void;
  recordWriter<T extends ProviderRuntimeWriter>(runId: string, writer: T): T;
  setSessionId(runId: string, sessionId: string): void;
  endRun(runId: string, outcome: ScreenscriptRunOutcome): void;
  forgetRun(runId: string): void;
  listRuns(): ScreenscriptRunSnapshot[];
  getRun(runId: string): ScreenscriptRunDetail | null;
  subscribe(runId: string, listener: (message: ScreenscriptRunMessage) => void): () => void;
};

type RunRecord = {
  snapshot: ScreenscriptRunSnapshot;
  events: ScreenscriptRunEvent[];
  seq: number;
  /** Monotonic insertion order, so runs started in the same millisecond keep a stable newest-first order. */
  order: number;
  listeners: Set<(message: ScreenscriptRunMessage) => void>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function preview(value: unknown, limit: number): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return clip(value, limit);
  try {
    return clip(JSON.stringify(value) ?? '', limit);
  } catch {
    return '';
  }
}

/**
 * Keeps a payload only while it is small enough to be worth shipping to the
 * browser; larger ones are replaced by a preview so one huge tool result cannot
 * hold a run's whole history in server memory.
 */
function boundPayload(value: unknown, maxChars: number): unknown {
  const serialized = preview(value, maxChars);
  if (serialized.length <= maxChars) return value;
  return { truncated: true, preview: serialized };
}

function describeEvent(data: unknown, maxPayloadChars: number): Omit<ScreenscriptRunEvent, 'seq' | 'at'> {
  const record = asRecord(data);
  if (!record) {
    const text = preview(data, MAX_TEXT_CHARS);
    return {
      kind: 'event',
      messageId: null,
      label: 'event',
      text,
      isError: false,
      payload: boundPayload(data, maxPayloadChars),
    };
  }

  const kind = nonEmptyString(record.kind) ?? nonEmptyString(record.type) ?? 'event';
  const toolName = nonEmptyString(record.toolName);
  const content = nonEmptyString(record.content) ?? nonEmptyString(record.text);
  const text = clip(
    content
      ?? preview(record.toolInput ?? record.summary ?? record.message ?? '', MAX_TEXT_CHARS),
    MAX_TEXT_CHARS,
  );
  const toolResult = asRecord(record.toolResult);
  const isError = kind === 'error'
    || record.isError === true
    || record.itemType === 'error'
    || toolResult?.isError === true;

  let label: string;
  if (kind === 'tool_use') label = toolName ?? 'tool';
  else if (kind === 'tool_result') label = toolName ?? 'result';
  else if (kind === 'text') label = 'assistant';
  else if (kind === 'status') label = content ?? 'status';
  else if (kind === 'complete') label = 'complete';
  else if (kind === 'session_created') label = 'session';
  else label = kind;

  return {
    kind,
    messageId: nonEmptyString(record.id) ?? nonEmptyString(record.toolId),
    label,
    text,
    isError,
    payload: boundPayload(data, maxPayloadChars),
  };
}

/**
 * Holds the live view of ScreenScript agent runs for the CloudCLI operator UI.
 *
 * The state is deliberately in-process: it exists to watch a turn while it runs,
 * not to be a system of record. Supabase and the n8n ticket remain the durable
 * sources, so an empty registry after a restart is expected, not an error.
 */
export function createScreenscriptRunRegistry(
  options: ScreenscriptRunRegistryOptions = {},
): ScreenscriptRunRegistry {
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
  const maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN;
  const maxPayloadChars = options.maxPayloadChars ?? DEFAULT_MAX_PAYLOAD_CHARS;
  const runs = new Map<string, RunRecord>();
  let createdOrder = 0;

  function freshSnapshot(input: ScreenscriptRunInput): ScreenscriptRunSnapshot {
    const now = Date.now();
    return {
      runId: input.runId,
      status: 'running',
      startedAt: now,
      updatedAt: now,
      finishedAt: null,
      sessionId: null,
      model: nonEmptyString(input.model),
      eventCount: 0,
      droppedEvents: 0,
      lastLabel: null,
      errorCode: null,
      truncated: false,
    };
  }

  function evictFinishedRuns(): void {
    if (runs.size <= maxRuns) return;
    const finished = [...runs.values()]
      .filter((record) => record.snapshot.status !== 'running')
      .sort((left, right) => (left.snapshot.finishedAt ?? left.snapshot.startedAt) - (right.snapshot.finishedAt ?? right.snapshot.startedAt));
    for (const record of finished) {
      if (runs.size <= maxRuns) return;
      runs.delete(record.snapshot.runId);
    }
  }

  function record(runId: string, data: unknown): void {
    const entry = runs.get(runId);
    if (!entry) return;
    const described = describeEvent(data, maxPayloadChars);
    entry.seq += 1;
    const event: ScreenscriptRunEvent = { seq: entry.seq, at: Date.now(), ...described };
    entry.events.push(event);
    if (entry.events.length > maxEventsPerRun) {
      entry.events.splice(0, entry.events.length - maxEventsPerRun);
      entry.snapshot.droppedEvents += 1;
      entry.snapshot.truncated = true;
    }
    const sessionId = asRecord(data)?.sessionId;
    if (typeof sessionId === 'string' && sessionId) entry.snapshot.sessionId = sessionId;
    entry.snapshot.eventCount += 1;
    entry.snapshot.lastLabel = described.label;
    entry.snapshot.updatedAt = event.at;
    for (const listener of entry.listeners) listener({ type: 'event', event });
  }

  return {
    isRunId(value: unknown): boolean {
      return typeof value === 'string' && RUN_ID_PATTERN.test(value);
    },

    beginRun(input: ScreenscriptRunInput): void {
      if (!RUN_ID_PATTERN.test(input.runId)) return;
      const existing = runs.get(input.runId);
      if (existing) {
        // A second turn on the same run id (a resume) restarts the visible feed
        // but keeps the listeners that are already watching this run.
        existing.snapshot = freshSnapshot(input);
        existing.events = [];
        existing.seq = 0;
        return;
      }
      runs.set(input.runId, {
        snapshot: freshSnapshot(input),
        events: [],
        seq: 0,
        order: (createdOrder += 1),
        listeners: new Set(),
      });
      evictFinishedRuns();
    },

    record,

    recordWriter<T extends ProviderRuntimeWriter>(runId: string, writer: T): T {
      const wrapped = {
        ...writer,
        send(data: unknown) {
          record(runId, data);
          writer.send(data);
        },
        setSessionId(sessionId: string) {
          const entry = runs.get(runId);
          if (entry) entry.snapshot.sessionId = sessionId;
          writer.setSessionId?.(sessionId);
        },
      };
      return wrapped as T;
    },

    setSessionId(runId: string, sessionId: string): void {
      const entry = runs.get(runId);
      if (!entry || !sessionId) return;
      entry.snapshot.sessionId = sessionId;
      entry.snapshot.updatedAt = Date.now();
    },

    endRun(runId: string, outcome: ScreenscriptRunOutcome): void {
      const entry = runs.get(runId);
      if (!entry) return;
      entry.snapshot.status = outcome.ok ? 'completed' : 'failed';
      entry.snapshot.finishedAt = Date.now();
      entry.snapshot.updatedAt = entry.snapshot.finishedAt;
      entry.snapshot.errorCode = outcome.ok ? null : outcome.errorCode ?? 'SCREENSCRIPT_AGENT_FAILED';
      for (const listener of entry.listeners) listener({ type: 'end', run: entry.snapshot });
      evictFinishedRuns();
    },

    forgetRun(runId: string): void {
      runs.delete(runId);
    },

    listRuns(): ScreenscriptRunSnapshot[] {
      return [...runs.values()]
        .sort((left, right) => (right.snapshot.startedAt - left.snapshot.startedAt) || (right.order - left.order))
        .map((record) => record.snapshot);
    },

    getRun(runId: string): ScreenscriptRunDetail | null {
      const entry = runs.get(runId);
      if (!entry) return null;
      return { run: entry.snapshot, events: [...entry.events] };
    },

    subscribe(runId: string, listener: (message: ScreenscriptRunMessage) => void): () => void {
      const entry = runs.get(runId);
      if (!entry) return () => undefined;
      entry.listeners.add(listener);
      return () => { entry.listeners.delete(listener); };
    },
  };
}
