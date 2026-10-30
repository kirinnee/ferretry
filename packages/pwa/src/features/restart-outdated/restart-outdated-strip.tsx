/**
 * THE ONE "RESTART OUTDATED (N)" BUTTON, at the head of the sessions bar's list.
 *
 * Why here and not in Settings: the mark that says a ferret is outdated is on the rows of this very list, so
 * the action sits beside the thing it fixes; Settings is a place a person visits to change a preference, not
 * to act on a ferret. It is drawn only while something is outdated (or while it has an answer to show), so a
 * machine whose ferrets are all current carries nothing extra.
 *
 * It never restarts on its own: a person presses it. The daemon restarts the idle ferrets now and queues the
 * busy ones for their next idle moment — never forcing past what a ferret is running — and the strip says
 * which was which, in the same two halves `fy restart` prints.
 */
import type { RestartRequest, RestartResult, SessionView } from '@ferretry/protocol';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';
import { OUTDATED_REQUEST, outdatedViews, restartButtonLabel, restartSummary } from './outdated-model.ts';
import { useRestartOverlay } from './restart-overlay.tsx';

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly result: RestartResult }
  | { readonly kind: 'failed'; readonly message: string };

export interface RestartOutdatedStripProps {
  /** This machine's sessions; the strip counts the ones carrying the daemon's `outdated`. */
  readonly sessions: readonly SessionView[] | null;
  /** Sends the restart to this machine's daemon. Absent: the strip draws nothing. */
  readonly onRestart?: (request: RestartRequest) => Promise<RestartResult>;
}

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'the daemon could not be reached';

export function RestartOutdatedStrip({ sessions, onRestart }: RestartOutdatedStripProps) {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const { overlay, record, clear } = useRestartOverlay();
  const count = outdatedViews(sessions, overlay).length;
  if (onRestart === undefined || (count === 0 && outcome.kind === 'idle')) return null;

  const dismiss = (): void => {
    clear();
    setOutcome({ kind: 'idle' });
  };

  const press = (): void => {
    setOutcome({ kind: 'running' });
    onRestart(OUTDATED_REQUEST).then(
      result => {
        record(result);
        setOutcome({ kind: 'done', result });
      },
      (error: unknown) => setOutcome({ kind: 'failed', message: failureMessage(error) }),
    );
  };

  return (
    <div className="fy-restart-outdated" data-restart-outdated="">
      {count === 0 ? null : (
        <button
          className="kt-btn kt-btn--sm fy-restart-outdated__button"
          data-restart-outdated-button=""
          disabled={outcome.kind === 'running'}
          onClick={press}
          title="Restart every ferret on older instructions, keeping its conversation. A busy ferret waits for its next idle moment."
          type="button"
        >
          <RotateCw aria-hidden="true" size={13} />
          <span>{outcome.kind === 'running' ? 'Restarting…' : restartButtonLabel(count)}</span>
        </button>
      )}
      {outcome.kind === 'done' ? (
        <p className="fy-restart-outdated__result" data-restart-outdated-result="" role="status">
          <span>{restartSummary(outcome.result)}</span>
          <button className="fy-restart-outdated__dismiss" onClick={dismiss} type="button">
            Dismiss
          </button>
        </p>
      ) : null}
      {outcome.kind === 'failed' ? (
        <p className="fy-restart-outdated__result" data-restart-outdated-failed="" role="alert">
          <span>Could not restart: {outcome.message}.</span>
          <button className="fy-restart-outdated__dismiss" onClick={() => setOutcome({ kind: 'idle' })} type="button">
            Dismiss
          </button>
        </p>
      ) : null}
    </div>
  );
}
