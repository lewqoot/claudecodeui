import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, Radio, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Badge, Button } from '@/shared/ui';
import {
  formatRunClock,
  mergeRunEvent,
  pickDefaultRunId,
  stringifyRunPayload,
  tailEvents,
  type ScreenscriptRunEvent,
  type ScreenscriptRunSnapshot,
} from '@/modules/settings/tabs/agents-settings/sections/content/screenscriptRuns';

const RUNS_POLL_MS = 4_000;
const MAX_RENDERED_EVENTS = 500;

type StreamState = 'idle' | 'connecting' | 'live' | 'ended' | 'unavailable';

const STATUS_CLASS: Record<ScreenscriptRunSnapshot['status'], string> = {
  running: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

const STATUS_LABEL_KEY: Record<ScreenscriptRunSnapshot['status'], string> = {
  running: 'agents.screenscriptRuns.running',
  completed: 'agents.screenscriptRuns.completed',
  failed: 'agents.screenscriptRuns.failed',
};

function parseFrame<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

/** Renders the raw provider event only after the operator asks for it. */
function RunPayload({ payload, label }: { payload: unknown; label: string }) {
  const [open, setOpen] = useState(false);
  if (payload === undefined) return null;
  return (
    <div className="mt-1">
      <button
        type="button"
        className="text-xs text-muted-foreground hover:underline"
        onClick={() => setOpen((value) => !value)}
      >
        {label}
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted/60 p-2 text-xs text-muted-foreground">
          {stringifyRunPayload(payload)}
        </pre>
      )}
    </div>
  );
}

/**
 * Live view of the Codex turns the ScreenScript worker runs in the isolated
 * production profile. Without it those turns are invisible in CloudCLI: the
 * worker consumes the stream and the profile is deliberately separate.
 */
export default function ScreenScriptRunsCard() {
  const { t } = useTranslation('settings');
  const [runs, setRuns] = useState<ScreenscriptRunSnapshot[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<ScreenscriptRunEvent[]>([]);
  const [liveRun, setLiveRun] = useState<ScreenscriptRunSnapshot | null>(null);
  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);

  const refreshRuns = useCallback(async () => {
    try {
      const response = await api.screenscriptOperator.runs();
      const payload = await readApiJson<{ runs: ScreenscriptRunSnapshot[] }>(response);
      setRuns(payload.runs);
      setError(null);
      // Keep the operator's choice while it is still in the registry, otherwise
      // fall back to the newest running run.
      setSelectedRunId((current) => (
        current && payload.runs.some((run) => run.runId === current)
          ? current
          : pickDefaultRunId(payload.runs)
      ));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptRuns.unknownError'));
    }
  }, [t]);

  useEffect(() => {
    void refreshRuns();
    const timer = window.setInterval(() => { void refreshRuns(); }, RUNS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshRuns]);

  useEffect(() => {
    setEvents([]);
    setLiveRun(null);
    if (!selectedRunId) {
      setStreamState('idle');
      return undefined;
    }

    setStreamState('connecting');
    const source = new EventSource(api.screenscriptOperator.runStreamUrl(selectedRunId));
    source.addEventListener('run', (event) => {
      const snapshot = parseFrame<ScreenscriptRunSnapshot>(event);
      if (!snapshot) return;
      setLiveRun(snapshot);
      setStreamState(snapshot.status === 'running' ? 'live' : 'ended');
    });
    source.addEventListener('event', (event) => {
      const next = parseFrame<ScreenscriptRunEvent>(event);
      if (!next) return;
      setEvents((current) => mergeRunEvent(current, next));
    });
    source.addEventListener('done', (event) => {
      const snapshot = parseFrame<ScreenscriptRunSnapshot>(event);
      if (snapshot) setLiveRun(snapshot);
      setStreamState('ended');
      source.close();
    });
    source.onerror = () => {
      setStreamState('unavailable');
      source.close();
    };
    return () => source.close();
  }, [selectedRunId]);

  const visibleEvents = useMemo(() => tailEvents(events, MAX_RENDERED_EVENTS), [events]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !pinnedRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [visibleEvents, streamState]);

  const runningCount = runs.filter((run) => run.status === 'running').length;

  return (
    <section className="border-t border-border/50 pt-5" aria-labelledby="screenscript-runs-title">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 h-5 w-5 flex-none text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="screenscript-runs-title" className="font-medium text-foreground">
              {t('agents.screenscriptRuns.title')}
            </h4>
            <Badge
              variant="secondary"
              className={runningCount > 0 ? STATUS_CLASS.running : 'bg-muted text-muted-foreground'}
            >
              {t('agents.screenscriptRuns.runningCount', { count: runningCount })}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('agents.screenscriptRuns.description')}</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={isRefreshing}
          onClick={() => {
            setIsRefreshing(true);
            void refreshRuns().finally(() => setIsRefreshing(false));
          }}
        >
          <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />
          {t('agents.screenscriptRuns.refresh')}
        </Button>
        {selectedRunId && streamState === 'live' && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Radio className="h-3.5 w-3.5 animate-pulse text-primary" aria-hidden="true" />
            {t('agents.screenscriptRuns.streamLive')}
          </span>
        )}
        {selectedRunId && streamState === 'ended' && (
          <span className="text-xs text-muted-foreground">{t('agents.screenscriptRuns.streamEnded')}</span>
        )}
        {selectedRunId && streamState === 'unavailable' && (
          <span className="text-xs text-destructive" role="alert">{t('agents.screenscriptRuns.streamUnavailable')}</span>
        )}
      </div>

      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}

      {runs.length === 0 && !error && (
        <p className="mt-3 text-sm text-muted-foreground">{t('agents.screenscriptRuns.empty')}</p>
      )}

      {runs.length > 0 && (
        <div className="mt-3 space-y-2">
          <ul className="space-y-1" role="list">
            {runs.map((run) => (
              <li key={run.runId}>
                <button
                  type="button"
                  aria-pressed={run.runId === selectedRunId}
                  onClick={() => setSelectedRunId(run.runId)}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm ${
                    run.runId === selectedRunId
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-border/60 hover:bg-muted/50'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-foreground">{run.runId}</span>
                    <Badge variant="secondary" className={STATUS_CLASS[run.status]}>
                      {t(STATUS_LABEL_KEY[run.status])}
                    </Badge>
                    <span className="text-xs text-muted-foreground">{formatRunClock(run.startedAt)}</span>
                    <span className="text-xs text-muted-foreground">
                      {t('agents.screenscriptRuns.eventCount', { count: run.eventCount })}
                    </span>
                  </span>
                  {(run.lastLabel || run.errorCode) && (
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      {[run.lastLabel, run.errorCode].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>

          {selectedRunId && (
            <div className="rounded-lg border border-border/60">
              <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{selectedRunId}</span>
                {liveRun?.sessionId && (
                  <span>{t('agents.screenscriptRuns.session', { id: liveRun.sessionId })}</span>
                )}
                {liveRun?.model && <span>{liveRun.model}</span>}
                {liveRun?.truncated && <span>{t('agents.screenscriptRuns.truncated')}</span>}
              </div>
              <div
                ref={scrollRef}
                onScroll={(event) => {
                  const node = event.currentTarget;
                  pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
                }}
                className="max-h-80 overflow-auto px-3 py-2"
              >
                {visibleEvents.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">{t('agents.screenscriptRuns.waiting')}</p>
                )}
                {visibleEvents.map((event) => (
                  <div
                    key={event.messageId ?? `seq-${event.seq}`}
                    className={`border-b border-border/30 py-1.5 last:border-b-0 ${event.isError ? 'text-destructive' : ''}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-2 text-xs">
                      <span className="font-mono text-muted-foreground">{formatRunClock(event.at)}</span>
                      <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {event.label}
                      </span>
                      {event.text && (
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground">
                          {event.text}
                        </span>
                      )}
                    </div>
                    <RunPayload payload={event.payload} label={t('agents.screenscriptRuns.raw')} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
