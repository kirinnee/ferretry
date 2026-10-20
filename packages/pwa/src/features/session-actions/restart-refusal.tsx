/**
 * What a Restart that the daemon paused looks like, and the one way past it.
 *
 * The daemon refuses to restart a CLI when something the agent is running could not be shown to be
 * safe to stop. The refusal is the default and stays the default: the panel opens with Cancel focused,
 * says in plain words what is running, and offers "Restart anyway" as a separate, deliberate press.
 * That press asks the daemon again with `forceInflight`, which the daemon journals.
 *
 * `useRestartRefusal` is shared by every surface that can restart a ferret — the header's Actions
 * menu, the sessions bar, and the transcript notice — so they cannot disagree about what a paused
 * restart looks like.
 */

import type { MigrationRefusal, SessionView } from '@ferretry/protocol';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../shell/primitives.tsx';
import { RestartRefused, restartRefusedSentence } from './session-operations.ts';

export function RestartRefusalPanel({
  refusal,
  busy,
  failure,
  onCancel,
  onRestartAnyway,
}: {
  readonly refusal: MigrationRefusal;
  readonly busy: boolean;
  readonly failure: string | null;
  readonly onCancel: () => void;
  readonly onRestartAnyway: () => void;
}) {
  const cancel = useRef<HTMLButtonElement | null>(null);
  useEffect(() => cancel.current?.focus(), []);
  const blockers = refusal.items.filter(item => item.blocks);
  const helpers = refusal.restartsWithCli;
  return (
    <section aria-label="Restart paused" className="fy-restart-refusal" data-restart-refusal="" role="alert">
      <p className="fy-restart-refusal__lead">{restartRefusedSentence(refusal)}</p>
      <ul className="fy-restart-refusal__list">
        {blockers.map((item, index) => (
          // The daemon lists items in a fixed order and nothing reorders them, so position is identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: stable, append-free list
          <li data-verdict={item.verdict} key={index}>
            <span>{item.title}</span>
            {item.detail === undefined ? null : <code className="fy-restart-refusal__code">{item.detail}</code>}
            {item.age === undefined ? null : <span className="fy-restart-refusal__age">running {item.age}</span>}
          </li>
        ))}
      </ul>
      {helpers === 0 ? null : (
        <p className="fy-restart-refusal__note">
          {helpers === 1
            ? '1 helper process belongs to the agent and restarts with it.'
            : `${helpers} helper processes belong to the agent and restart with it.`}
        </p>
      )}
      <p className="fy-restart-refusal__note">
        Restarting anyway stops what is listed above. Anything it was in the middle of is lost.
      </p>
      {failure === null ? null : <p className="fy-restart-refusal__failure">{failure}</p>}
      <div className="fy-restart-refusal__foot">
        <Button data-restart-refusal-cancel="" disabled={busy} onClick={onCancel} ref={cancel} type="button">
          Cancel
        </Button>
        <Button data-restart-refusal-anyway="" disabled={busy} onClick={onRestartAnyway} type="button" variant="danger">
          {busy ? 'Restarting…' : 'Restart anyway'}
        </Button>
      </div>
    </section>
  );
}

/**
 * Holds one paused restart. `capture` takes whatever a restart threw: a refusal that names what is
 * running is held and answers true, so the caller treats the restart as handled and shows `panel`;
 * anything else answers false and stays the caller's to report.
 */
export function useRestartRefusal(
  publish: (view: SessionView) => void,
  /** What the held refusal is about; a different one drops it. */
  scope: string,
): {
  readonly capture: (reason: unknown) => boolean;
  readonly panel: ReactNode;
} {
  const [held, setHeld] = useState<RestartRefused | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope is the reset trigger
  useEffect(() => {
    setHeld(null);
    setBusy(false);
    setFailure(null);
  }, [scope]);
  const capture = useCallback((reason: unknown): boolean => {
    if (!(reason instanceof RestartRefused)) return false;
    setHeld(reason);
    setFailure(null);
    return true;
  }, []);
  const restartAnyway = (): void => {
    if (held === null || busy) return;
    setBusy(true);
    setFailure(null);
    held
      .restartAnyway()
      .then(view => {
        setHeld(null);
        publish(view);
      })
      .catch((reason: unknown) =>
        setFailure(`Restart anyway failed: ${reason instanceof Error ? reason.message : String(reason)}`),
      )
      .finally(() => setBusy(false));
  };
  const panel =
    held === null ? null : (
      <RestartRefusalPanel
        busy={busy}
        failure={failure}
        onCancel={() => setHeld(null)}
        onRestartAnyway={restartAnyway}
        refusal={held.refusal}
      />
    );
  return { capture, panel };
}
