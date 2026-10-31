/**
 * "Access refused": the publisher no longer accepts this browser's key.
 *
 * The key is still here. Nothing is deleted until the person taps Forget and confirms, and joining
 * again needs a new link from the owner, which this screen says and does not fetch.
 */

import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../shell/primitives.tsx';
import {
  FORGET_CATALOG,
  FORGET_NOTE,
  REFUSED_JOIN_AGAIN,
  REFUSED_JOIN_AGAIN_NOTE,
  REFUSED_SENTENCE,
  REFUSED_TITLE,
} from './shared-model.ts';
import { CONFIRM_FORGET, CONFIRM_FORGET_YES, KEEP } from './shared-screens-model.ts';

/** "Join again with a new link": says what to do. Joining needs a link only the owner can make, so it fetches nothing. */
export function JoinAgain() {
  const [explained, setExplained] = useState(false);
  return (
    <div className="flex min-w-0 flex-col items-start gap-xs">
      <Button type="button" onClick={() => setExplained(true)} data-join-again="">
        {REFUSED_JOIN_AGAIN}
      </Button>
      {explained ? (
        <p className="m-0 text-cell" role="status" data-join-again-note="">
          {REFUSED_JOIN_AGAIN_NOTE}
        </p>
      ) : null}
    </div>
  );
}

export function AccessRefused({
  label,
  level,
  onForget,
}: {
  /** The person's own name for the publisher. */
  readonly label: string;
  /** The heading level, so the title sits right under whatever heading the page already has. */
  readonly level: 2 | 3;
  readonly onForget: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const Heading = level === 2 ? 'h2' : 'h3';
  const forget = async (): Promise<void> => {
    setBusy(true);
    try {
      await onForget();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="flex min-w-0 flex-col gap-sm rounded-control border border-err-border bg-err-bg p-control-x py-2 text-err"
      aria-label={`${REFUSED_TITLE}: ${label}`}
      data-access-refused=""
    >
      <Heading className="m-0 flex items-center gap-2 text-row font-semibold">
        <CircleAlert size={16} aria-hidden="true" />
        {REFUSED_TITLE}
      </Heading>
      <p className="m-0 break-words text-cell">{REFUSED_SENTENCE}</p>
      <JoinAgain />
      <div className="flex min-w-0 flex-col items-start gap-xs">
        <p className="m-0 text-cell">{FORGET_NOTE}</p>
        {confirming ? (
          <fieldset className="m-0 flex border-0 p-0 min-w-0 flex-col items-start gap-xs" aria-label={CONFIRM_FORGET}>
            <p className="m-0 text-cell font-semibold">{CONFIRM_FORGET}</p>
            <div className="flex flex-wrap gap-xs">
              <Button
                type="button"
                variant="danger"
                disabled={busy}
                onClick={() => void forget()}
                data-refused-forget-yes=""
              >
                {CONFIRM_FORGET_YES}
              </Button>
              <Button type="button" disabled={busy} onClick={() => setConfirming(false)} data-refused-keep="">
                {KEEP}
              </Button>
            </div>
          </fieldset>
        ) : (
          <Button type="button" variant="danger" onClick={() => setConfirming(true)} data-refused-forget="">
            {FORGET_CATALOG}
          </Button>
        )}
      </div>
    </section>
  );
}
