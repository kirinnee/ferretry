/**
 * "RESTART OUTDATED (N)": the press lives in the sessions bar's ⋯ menu, its answer in a line under the bar's head.
 *
 * Why the bar and not Settings: the mark that says a ferret is outdated is on the rows of this very list, so
 * the action sits beside the thing it fixes; Settings is a place a person visits to change a preference, not
 * to act on a ferret. It is offered only while something is outdated (or while it has an answer to show), so a
 * machine whose ferrets are all current carries nothing extra. The menu keeps it out of the list's way and a
 * count badge on the ⋯ keeps it findable.
 *
 * It never restarts on its own: a person presses it. The daemon restarts the idle ferrets now and queues the
 * busy ones for their next idle moment — never forcing past what a ferret is running — and the line says
 * which was which, in the same two halves `fy restart` prints.
 */
import type { RestartRequest, RestartResult, SessionView } from '@ferretry/protocol';
import { useState } from 'react';
import { OUTDATED_REQUEST, outdatedViews, restartSummary } from './outdated-model.ts';
import { useRestartOverlay } from './restart-overlay.tsx';

type Outcome =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'done'; readonly result: RestartResult }
  | { readonly kind: 'failed'; readonly message: string };

export interface RestartOutdated {
  /** How many ferrets a press would act on (outdated, not already restarted or queued). */
  readonly count: number;
  /** False when the host cannot restart: nothing is offered, whatever the ferrets' marks say. */
  readonly available: boolean;
  readonly running: boolean;
  readonly press: () => void;
  readonly outcome: Outcome;
  readonly dismiss: () => void;
}

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message !== '' ? error.message : 'the daemon could not be reached';

/** The restart's state, kept once by the bar so the menu that presses it and the line that answers agree. */
export function useRestartOutdated(
  sessions: readonly SessionView[] | null,
  onRestart?: (request: RestartRequest) => Promise<RestartResult>,
): RestartOutdated {
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'idle' });
  const { overlay, record, clear } = useRestartOverlay();
  const count = outdatedViews(sessions, overlay).length;

  const dismiss = (): void => {
    clear();
    setOutcome({ kind: 'idle' });
  };

  const press = (): void => {
    if (onRestart === undefined) return;
    setOutcome({ kind: 'running' });
    onRestart(OUTDATED_REQUEST).then(
      result => {
        record(result);
        setOutcome({ kind: 'done', result });
      },
      (error: unknown) => setOutcome({ kind: 'failed', message: failureMessage(error) }),
    );
  };

  return { count, available: onRestart !== undefined, running: outcome.kind === 'running', press, outcome, dismiss };
}

/** What the last press did, until dismissed. Draws nothing while there is no answer to show. */
export function RestartOutdatedResult({ restart }: { readonly restart: RestartOutdated }) {
  const { outcome, dismiss } = restart;
  if (outcome.kind === 'done') {
    return (
      <div className="fy-restart-outdated" data-restart-outdated="">
        <p className="fy-restart-outdated__result" data-restart-outdated-result="" role="status">
          <span>{restartSummary(outcome.result)}</span>
          <button className="fy-restart-outdated__dismiss" onClick={dismiss} type="button">
            Dismiss
          </button>
        </p>
      </div>
    );
  }
  if (outcome.kind === 'failed') {
    return (
      <div className="fy-restart-outdated" data-restart-outdated="">
        <p className="fy-restart-outdated__result" data-restart-outdated-failed="" role="alert">
          <span>Could not restart: {outcome.message}.</span>
          <button className="fy-restart-outdated__dismiss" onClick={dismiss} type="button">
            Dismiss
          </button>
        </p>
      </div>
    );
  }
  return null;
}
