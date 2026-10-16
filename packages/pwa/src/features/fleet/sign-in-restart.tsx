/**
 * The two pieces both harnesses' sign-in panels share for a sign-in that was already running.
 *
 * A credential has one sign-in at a time, so starting one that is already running PICKS IT UP: the
 * daemon answers with it, marked `resumed`, and the panel says so in plain words instead of showing an
 * error. "Start over" is the way out when that sign-in is the wrong one — a link that went stale, a code
 * typed on a phone that is now off — and it ends it and starts afresh in one press. On a Codex sign-in
 * it also clears a leftover Codex sign-in off the machine's callback port, and names anything else
 * holding that port rather than stopping it.
 */

import type { HarnessLoginFlow } from '@ferretry/protocol';
import { RotateCcw } from 'lucide-react';
import { Button } from '../../shell/primitives.tsx';

/** Said when a start picked up a sign-in already running for this login. */
export const RESUMED_SENTENCE = 'You started this sign-in earlier, so it carries on from where you left it.';

export function ResumedNote({ flow }: { readonly flow: HarnessLoginFlow | null }) {
  if (flow?.resumed !== true || flow.state === 'complete' || flow.state === 'failed') return null;
  return (
    <p className="m-0 text-ui leading-base text-muted" role="status" data-sign-in-resumed="">
      {RESUMED_SENTENCE}
    </p>
  );
}

/** An alternative to the running sign-in, so outlined — never the filled main action. */
export function StartOverButton({
  onStartOver,
  busy,
}: {
  readonly onStartOver: (() => void) | undefined;
  readonly busy: boolean;
}) {
  if (onStartOver === undefined) return null;
  return (
    <Button type="button" variant="outline" onClick={onStartOver} disabled={busy} data-sign-in-start-over="">
      <RotateCcw size={16} aria-hidden="true" />
      Start over
    </Button>
  );
}
