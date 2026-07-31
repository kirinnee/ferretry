import type { SessionStatus } from '@ferretry/protocol';
import { useEffect, useState } from 'react';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { isTerminalSessionStatus } from '../lib/session-screens.ts';

interface SessionRuntimeApi {
  /** The host must invoke the runtime route through this exact paired daemon. */
  compact(daemon: DaemonConnection, sessionId: string): Promise<void>;
}

export interface SessionCommandControlsProps {
  readonly api: SessionRuntimeApi;
  readonly canControl: boolean;
  readonly daemon: DaemonConnection;
  readonly open: boolean;
  readonly promptReady: boolean;
  readonly sessionId: string;
  readonly status: SessionStatus;
}

type RuntimeFailure = { readonly code?: unknown; readonly message?: unknown; readonly status?: unknown };

/** Older daemons reject the action before touching a live harness; make that verdict explicit. */
export const isSessionCommandUnsupported = (failure: unknown): boolean => {
  if (typeof failure !== 'object' || failure === null) return false;
  const { code, message, status } = failure as RuntimeFailure;
  return (status === 404 && code === 'unknown_route') || (status === 400 && /runtime action/i.test(String(message)));
};

const failureMessage = (failure: unknown): string => {
  if (failure instanceof Error) return failure.message;
  const runtimeFailure = failure as RuntimeFailure | null;
  return typeof runtimeFailure?.message === 'string' ? runtimeFailure.message : String(failure);
};

/**
 * Idle-only context compaction. The API accepts the paired daemon explicitly:
 * a same-named session on a second daemon can never receive this action.
 */
export function SessionCommandControls({
  api,
  canControl,
  daemon,
  open,
  promptReady,
  sessionId,
  status,
}: SessionCommandControlsProps) {
  const terminal = isTerminalSessionStatus(status);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);

  // Scope identity is the trigger: it clears any result from a same-named
  // session when the paired daemon changes, even though the body only writes state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope reset trigger, see above
  useEffect(() => {
    setSending(false);
    setFailure(null);
    setNotice(null);
    setRestartRequired(false);
  }, [daemon.daemonId, sessionId]);

  useEffect(() => {
    if (open) setRestartRequired(false);
  }, [open]);

  const ready = canControl && !terminal && promptReady && !restartRequired && !sending;

  const compact = async () => {
    if (!ready) return;
    setSending(true);
    setFailure(null);
    setNotice(null);
    try {
      await api.compact(daemon, sessionId);
      setNotice('Compacting context. Watch the transcript for completion; the conversation remains available.');
    } catch (cause) {
      if (isSessionCommandUnsupported(cause)) setRestartRequired(true);
      else setFailure(failureMessage(cause));
    } finally {
      setSending(false);
    }
  };

  if (terminal) {
    return (
      <section aria-label="Session context" className="fy-session-context" data-daemon-id={daemon.daemonId}>
        <h2>Session context</h2>
        <p>Compacting context needs a running session. Resume or relaunch this session first.</p>
      </section>
    );
  }

  if (!canControl) {
    return (
      <section aria-label="Session context" className="fy-session-context" data-daemon-id={daemon.daemonId}>
        <h2>Session context</h2>
        <p>This paired daemon is read-only, so it cannot compact the running session.</p>
      </section>
    );
  }

  return (
    <section aria-label="Session context" className="fy-session-context" data-daemon-id={daemon.daemonId}>
      <h2>Session context</h2>
      <p>Compact the running model’s context in place. This does not move accounts or relaunch the pane.</p>
      {!promptReady ? (
        <p className="fy-session-context-warning">Wait for an idle prompt. This command never queues.</p>
      ) : null}
      {restartRequired ? (
        <p className="fy-session-context-warning" role="alert">
          Daemon restart required to enable /compact. Nothing was changed.
        </p>
      ) : (
        <button
          aria-label="Compact this session’s context"
          disabled={!ready}
          onClick={() => void compact()}
          type="button"
        >
          <span>{sending ? 'Compacting…' : 'Compact context'}</span>
          <small>Summarise to reclaim context. Keeps the conversation.</small>
        </button>
      )}
      {notice ? (
        <p className="fy-session-context-notice" role="status">
          {notice}
        </p>
      ) : null}
      {failure ? (
        <p className="fy-session-context-error" role="alert">
          {failure}
        </p>
      ) : null}
    </section>
  );
}
