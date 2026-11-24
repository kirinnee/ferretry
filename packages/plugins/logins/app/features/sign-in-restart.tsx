/**
 * The pieces both harnesses' sign-in panels share: the notes and the restart for a sign-in already running, the link, and the answers under the paste field.
 *
 * A credential has one sign-in at a time, so starting one that is already running PICKS IT UP: the
 * daemon answers with it, marked `resumed`, and the panel says so in plain words instead of showing an
 * error. "Start over" is the way out when that sign-in is the wrong one — a link that went stale, a code
 * typed on a phone that is now off — and it ends it and starts afresh in one press. On a Codex sign-in
 * it also clears a leftover Codex sign-in off the machine's callback port, and names anything else
 * holding that port rather than stopping it.
 */

import type { HarnessLoginFlow } from '../../contract/index.ts';
import { RotateCcw, ShieldCheck } from 'lucide-react';
import { useId, useState } from 'react';
import { Button, cn, type ClipboardWriter, CopyButton } from '../ui.ts';

/** Said when a start picked up a sign-in already running for this login. */
const RESUMED_SENTENCE = 'You started this sign-in earlier, so it carries on from where you left it.';

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

/** A link at least this long is shown cut short, with a button for the rest (C59 O5: "the link is too long"). */
export const LONG_LINK = 48;

/**
 * The sign-in link both harnesses show: one line cut with an ellipsis, and "Show full" / "Show less" to open it. The
 * Copy button always has the whole link. `name` is the tool the link signs in to, for the Copy button's label.
 */
export function SignInLink({
  url,
  copy,
  name = 'Claude',
}: {
  readonly url: string;
  readonly copy: ClipboardWriter;
  readonly name?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = url.length >= LONG_LINK;
  const shown = !long || open;
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <code
          id={id}
          data-sign-in-link=""
          data-expanded={shown}
          className={cn(
            'block min-w-0 rounded-control border border-border bg-surface px-2 py-2 font-mono text-meta leading-base text-fg',
            shown ? 'break-all' : 'truncate',
          )}
        >
          {url}
        </code>
        {long ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="self-start"
            aria-expanded={open}
            aria-controls={id}
            data-sign-in-link-toggle=""
            onClick={() => setOpen(value => !value)}
          >
            {open ? 'Show less' : 'Show full'}
          </Button>
        ) : null}
      </div>
      <CopyButton text={url} label={`Copy the ${name} sign-in link`} write={copy} />
    </div>
  );
}

/**
 * The answers under the paste field, the same for both harnesses: Finish the column's width, then Start over and Cancel
 * as one balanced row (one full-width Cancel where there is no Start over).
 */
export function SignInAnswers({
  finishLabel,
  finishDisabled,
  finishBusy,
  finishBusyLabel,
  busy,
  onStartOver,
  onCancel,
}: {
  readonly finishLabel: string;
  readonly finishDisabled: boolean;
  readonly finishBusy: boolean;
  readonly finishBusyLabel: string;
  readonly busy: boolean;
  readonly onStartOver: (() => void) | undefined;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex flex-col gap-3" data-sign-in-actions="">
      <Button
        type="submit"
        variant="primary"
        disabled={finishDisabled}
        icon={<ShieldCheck size={16} />}
        busy={finishBusy}
        busyLabel={finishBusyLabel}
      >
        {finishLabel}
      </Button>
      <div
        className={cn('grid gap-3', onStartOver === undefined ? 'grid-cols-1' : 'grid-cols-2')}
        data-sign-in-secondary=""
      >
        <StartOverButton onStartOver={onStartOver} busy={busy} />
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
