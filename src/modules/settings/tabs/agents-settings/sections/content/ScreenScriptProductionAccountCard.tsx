import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, LogIn, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { api, readApiJson } from '@/shared/api';
import { Badge, Button } from '@/shared/ui';

type ProductionAccountStatus = {
  signedIn: boolean;
  detail: string;
  email: string | null;
  authMode: string | null;
  error: string | null;
};

type DeviceAuthProgress = {
  phase: 'idle' | 'starting' | 'waiting' | 'success' | 'failed';
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: number | null;
  error: string | null;
};

type RateWindow = {
  kind: 'primary' | 'secondary';
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: string | null;
};

type RateLimitsData = {
  limits: { id: string; name: string | null; planType: string | null; windows: RateWindow[] }[];
};

const INITIAL_PROGRESS: DeviceAuthProgress = {
  phase: 'idle', verificationUrl: null, userCode: null, expiresAt: null, error: null,
};

function formatWindowDuration(minutes: number): string {
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function formatResetCountdown(resetsAt: string | null): string | null {
  if (!resetsAt) return null;
  const remainingMs = Date.parse(resetsAt) - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** Rendered by the Codex Account settings panel to manage only the isolated ScreenScript production profile. */
export default function ScreenScriptProductionAccountCard() {
  const { t } = useTranslation('settings');
  // Keeps the non-secret production identity visible after a refresh or completed device login.
  const [account, setAccount] = useState<ProductionAccountStatus | null>(null);
  // Holds the short-lived device-auth handoff returned by the server; it is never persisted by the browser.
  const [progress, setProgress] = useState<DeviceAuthProgress>(INITIAL_PROGRESS);
  // Prevents duplicate start/cancel requests while a Settings action is still in flight.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Requires the operator to acknowledge that replacing an account must not interrupt a live run.
  const [pausedRunsConfirmed, setPausedRunsConfirmed] = useState(false);
  // Surfaces safe server failures without showing implementation details or credentials.
  const [error, setError] = useState<string | null>(null);
  // Plan-limit windows for the isolated profile; null while loading, undefined-like on fetch failure via usageError.
  const [usage, setUsage] = useState<RateLimitsData | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);

  const refreshUsage = useCallback(async () => {
    try {
      const response = await api.screenscriptOperator.usage();
      setUsage(await readApiJson<RateLimitsData>(response));
      setUsageError(null);
    } catch (caughtError) {
      setUsageError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.usageUnavailable'));
    }
  }, [t]);

  const refreshAccount = useCallback(async () => {
    const response = await api.screenscriptOperator.account();
    const nextAccount = await readApiJson<ProductionAccountStatus>(response);
    setAccount(nextAccount);
    if (nextAccount.signedIn) void refreshUsage();
  }, [refreshUsage]);

  const refreshProgress = useCallback(async () => {
    const response = await api.screenscriptOperator.progress();
    const nextProgress = await readApiJson<DeviceAuthProgress>(response);
    setProgress(nextProgress);
    if (nextProgress.phase === 'success') {
      await refreshAccount();
      setPausedRunsConfirmed(false);
    }
  }, [refreshAccount]);

  useEffect(() => {
    void refreshAccount().catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.unknownError'));
    });
    void refreshProgress().catch((caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.unknownError'));
    });
  }, [refreshAccount, refreshProgress, t]);

  useEffect(() => {
    if (progress.phase !== 'starting' && progress.phase !== 'waiting') return undefined;
    const timer = window.setInterval(() => {
      void refreshProgress().catch((caughtError) => {
        setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.unknownError'));
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [progress.phase, refreshProgress, t]);

  const startLogin = async () => {
    if (!pausedRunsConfirmed) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await api.screenscriptOperator.start();
      setProgress(await readApiJson<DeviceAuthProgress>(response));
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.unknownError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const cancelLogin = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      const response = await api.screenscriptOperator.cancel();
      setProgress(await readApiJson<DeviceAuthProgress>(response));
      setPausedRunsConfirmed(false);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('agents.screenscriptProduction.unknownError'));
    } finally {
      setIsSubmitting(false);
    }
  };

  const isWaiting = progress.phase === 'starting' || progress.phase === 'waiting';

  return (
    <section className="border-t border-border/50 pt-5" aria-labelledby="screenscript-production-account-title">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 flex-none text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="screenscript-production-account-title" className="font-medium text-foreground">
              {t('agents.screenscriptProduction.title')}
            </h4>
            <Badge variant="secondary" className={account?.signedIn ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' : 'bg-muted text-muted-foreground'}>
              {account?.signedIn ? t('agents.authStatus.connected') : t('agents.authStatus.notConnected')}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t('agents.screenscriptProduction.description')}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {account?.signedIn
              ? t('agents.authStatus.loggedInAs', { email: account.email || t('agents.authStatus.authenticatedUser') })
              : account?.error || t('agents.screenscriptProduction.notSignedIn')}
          </p>
        </div>
      </div>

      {account?.signedIn && (
        <div className="mt-4 space-y-3">
          <p className="text-sm font-medium text-foreground">{t('agents.screenscriptProduction.usageTitle')}</p>
          {usageError && <p className="text-sm text-destructive" role="alert">{usageError}</p>}
          {!usageError && usage?.limits.flatMap((limit) => limit.windows).map((window) => {
            const resetCountdown = formatResetCountdown(window.resetsAt);
            return (
              <div key={window.kind}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-muted-foreground">Codex · {formatWindowDuration(window.windowDurationMins)}</span>
                  <span className="text-muted-foreground">
                    {Math.round(window.usedPercent)}%
                    {resetCountdown ? ` · ${t('agents.screenscriptProduction.usageResetsIn', { time: resetCountdown })}` : ''}
                  </span>
                </div>
                <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={window.usedPercent >= 90 ? 'h-full bg-destructive' : window.usedPercent >= 70 ? 'h-full bg-amber-500' : 'h-full bg-primary'}
                    style={{ width: `${Math.min(100, window.usedPercent)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!isWaiting && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-foreground">
          <input
            type="checkbox"
            checked={pausedRunsConfirmed}
            onChange={(event) => setPausedRunsConfirmed(event.target.checked)}
            className="mt-0.5 h-4 w-4 accent-primary"
          />
          <span>{t('agents.screenscriptProduction.pauseConfirmation')}</span>
        </label>
      )}

      {progress.phase === 'waiting' && progress.verificationUrl && progress.userCode && (
        <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="text-sm font-medium text-foreground">{t('agents.screenscriptProduction.deviceStep')}</p>
          <p className="mt-1 break-all text-sm text-muted-foreground">{progress.verificationUrl}</p>
          <p className="mt-2 font-mono text-base font-semibold tracking-wide text-foreground">{progress.userCode}</p>
          <a
            href={progress.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            {t('agents.screenscriptProduction.openLogin')}
          </a>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {progress.phase === 'failed' && progress.error && <p className="mt-3 text-sm text-destructive" role="alert">{progress.error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {!isWaiting ? (
          <Button onClick={() => void startLogin()} disabled={!pausedRunsConfirmed || isSubmitting} size="sm">
            {isSubmitting ? <RefreshCw className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" /> : <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />}
            {account?.signedIn ? t('agents.screenscriptProduction.switchAccount') : t('agents.screenscriptProduction.connectAccount')}
          </Button>
        ) : (
          <Button variant="outline" onClick={() => void cancelLogin()} disabled={isSubmitting} size="sm">
            <X className="mr-2 h-4 w-4" aria-hidden="true" />
            {t('agents.screenscriptProduction.cancelLogin')}
          </Button>
        )}
        <Button variant="outline" onClick={() => void refreshAccount()} disabled={isSubmitting} size="sm">
          <RefreshCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {t('agents.screenscriptProduction.refreshStatus')}
        </Button>
      </div>
    </section>
  );
}
