/**
 * `ferret.toolbar` › `status` — how this ferret is doing, as a shape and a word. A parked ferret says what it waits
 * for. (Whose turn it is belongs to Conversation's turn watcher, which draws it in its own `ferret.toolbar` panel beside
 * this one; the ferret record carries no turn.)
 */

import { Play, Square } from 'lucide-react';
import { useState } from 'react';
import type { FerretSummary } from '../../../contract/index.ts';
import type { FerretsClient } from '../../lib/client.ts';
import { StatusMark, statusMark } from '../../lib/status-mark.tsx';
import { resumeFerret, stopFerret } from './ferret-operations.ts';
import { reviveOffer } from './revive-offer.ts';

/** The word for a mark: its class and detail, the person's words rather than the daemon's. */
const statusWord = (ferret: FerretSummary): string => {
  const info = statusMark(ferret);
  const [, detail] = info.label.split(' — ');
  return detail ?? info.label;
};

export function FerretStatus({ ferret, compact }: { readonly ferret: FerretSummary; readonly compact: boolean }) {
  return (
    <span
      className="fy-ferret-status"
      data-ferret-state={ferret.state}
      data-ferret-status={statusMark(ferret).klass}
      title={statusMark(ferret).label}
    >
      <StatusMark ferret={ferret} />
      <span className={compact ? 'sr-only' : 'fy-ferret-status__word'}>{statusWord(ferret)}</span>
    </span>
  );
}

/**
 * START / STOP, WHERE THE STATE IS SAID: a stopped ferret that can come back shows a visible Resume beside "Stopped", and a
 * running one a quiet Stop (two steps: Stop, then "Yes, stop" — the same consequence the Actions menu's confirm names). The
 * menu keeps every act; this is only the owner's first reach for the two they look for ("where do I start/stop it?"). Whether
 * a button shows is the ONE rule the menu uses ({@link reviveOffer}); the daemon still decides who may.
 */
export function FerretLifecycle({
  client,
  ferret,
  reload,
  canControl = true,
  compact = false,
}: {
  readonly client: FerretsClient;
  readonly ferret: FerretSummary;
  readonly reload: () => Promise<unknown>;
  readonly canControl?: boolean;
  /** A phone's one scrolling toolbar line has no room for a second button: Resume stays (a stopped ferret needs it), Stop is the menu's. */
  readonly compact?: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const resumable = reviveOffer(ferret, canControl).offered;
  const stoppable = canControl && !compact && ferret.state !== 'stopped';
  if (!resumable && !stoppable) return null;

  const run = (work: () => Promise<void>, what: string): void => {
    setBusy(true);
    setFailure(null);
    void work()
      .then(() => reload())
      .catch((reason: unknown) =>
        setFailure(`${what} failed: ${reason instanceof Error ? reason.message : String(reason)}`),
      )
      .finally(() => {
        setBusy(false);
        setAsking(false);
      });
  };

  return (
    <span className="fy-ferret-lifecycle" data-ferret-lifecycle="">
      {resumable ? (
        <button
          className="fy-ferret-lifecycle__btn fy-ferret-lifecycle__btn--start"
          data-ferret-start=""
          disabled={busy}
          onClick={() => run(() => resumeFerret(client, ferret.id), 'Resume')}
          title={reviveOffer(ferret, canControl).reason}
          type="button"
        >
          <Play aria-hidden="true" size={14} />
          Resume
        </button>
      ) : asking ? (
        <>
          <button
            className="fy-ferret-lifecycle__btn fy-ferret-lifecycle__btn--danger"
            data-ferret-stop-confirm=""
            disabled={busy}
            onClick={() => run(() => stopFerret(client, ferret.id), 'Stop')}
            title="The CLI exits; the transcript stays."
            type="button"
          >
            Yes, stop
          </button>
          <button className="fy-ferret-lifecycle__btn" onClick={() => setAsking(false)} type="button">
            Keep running
          </button>
        </>
      ) : (
        <button
          className="fy-ferret-lifecycle__btn"
          data-ferret-stop=""
          onClick={() => setAsking(true)}
          title="Stop this ferret: the CLI exits, the transcript stays."
          type="button"
        >
          <Square aria-hidden="true" size={12} />
          Stop
        </button>
      )}
      {failure === null ? null : (
        <span className="fy-ferret-lifecycle__failure" data-ferret-lifecycle-failure="" role="alert">
          {failure}
        </span>
      )}
    </span>
  );
}
