/**
 * A project's watch controls, drawn at the FOOT of its PR list (r11 S7). A project with a linked GitHub account is
 * watched without anyone setting anything up, so the only watch control is a quiet "Stop watching" (and, once stopped,
 * one line with "Watch again"). A project with no linked account says so, with a way to link one. "What notifies your
 * phone" stays as a disclosure; a project watched only by default pushes nothing until an event is ticked.
 *
 * Every change is one PATCH of what changed; the screen then reads again, so what is drawn is what the daemon holds. A
 * change the daemon holds for the owner (it would loosen something) is shown as the daemon worded it, never as done.
 */
import { RouteLink } from '@ferretry/app/ui';
import { Info } from 'lucide-react';
import { useState } from 'react';
import type { WatchEvent, WatchProjectView } from '../../../contract/index.ts';
import { type ListClient, patchWatch } from './api.ts';
import { EVENT_ORDER, EVENT_WORDS, EMPTY_WORDS, STOP_WATCHING_TIP } from './model.ts';

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** A quiet text button: no border, no fill, never a full row. */
const QUIET =
  'inline-flex min-h-[44px] w-fit cursor-pointer items-center gap-1 border-0 bg-transparent px-0 text-meta text-muted underline hover:text-fg';

export interface WatchControlsProps {
  readonly client: ListClient;
  readonly view: WatchProjectView;
  /** Called after the daemon took a change, so the screen reads the truth again. */
  readonly onChanged: () => void;
  /** Where "Link a GitHub account" goes (the project's page), when the screen knows it. */
  readonly accountsHref?: string | undefined;
  readonly onOpen?: ((to: string) => void) | undefined;
}

export function WatchControls({ client, view, onChanged, accountsHref, onOpen }: WatchControlsProps) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const [held, setHeld] = useState<readonly string[]>([]);

  const change = (patch: Parameters<typeof patchWatch>[2]): void => {
    setBusy(true);
    setProblem(undefined);
    setHeld([]);
    patchWatch(client, view.project, patch).then(
      result => {
        setBusy(false);
        setHeld(result.held);
        onChanged();
      },
      (cause: unknown) => {
        setBusy(false);
        setProblem(reasonOf(cause));
      },
    );
  };

  const tipId = `pulls-watch-tip-${view.project}`;
  return (
    <div className="grid gap-xs" data-pulls-watch={view.project}>
      {!view.watch && view.watchedBy === 'you' && (
        <p className="m-0 flex flex-wrap items-center gap-x-xs text-meta text-muted" data-pulls-empty="watch-off">
          <span>{EMPTY_WORDS['watch-off']}</span>
          <button
            className={QUIET}
            data-pulls-watch-again=""
            disabled={busy}
            onClick={() => change({ watch: true })}
            type="button"
          >
            Watch again
          </button>
        </p>
      )}
      {!view.watch && view.watchedBy === 'default' && (
        <p className="m-0 text-meta text-muted" data-pulls-empty="no-reader">
          {accountsHref !== undefined && onOpen !== undefined ? (
            <>
              <RouteLink className="underline" onNavigate={onOpen} to={accountsHref}>
                Link a GitHub account
              </RouteLink>{' '}
              to see its pull requests.
            </>
          ) : (
            EMPTY_WORDS['no-reader']
          )}
        </p>
      )}
      {view.watch && (
        <>
          <details className="text-ui" data-pulls-notify="">
            <summary className="flex min-h-[44px] cursor-pointer items-center text-meta font-medium text-fg-soft">
              What notifies your phone
            </summary>
            {view.watchedBy === 'default' && (
              <p className="m-0 text-meta text-muted" data-pulls-notify-hint="">
                Pick what should notify your phone.
              </p>
            )}
            <ul className="m-0 grid list-none gap-1 p-0 pt-1">
              {EVENT_ORDER.map((event: WatchEvent) => (
                <li key={event}>
                  <label className="flex min-h-[44px] items-center gap-xs">
                    <input
                      checked={view.notify[event]}
                      className="size-4 shrink-0"
                      data-pulls-notify-event={event}
                      disabled={busy}
                      onChange={changeEvent => change({ notify: { [event]: changeEvent.currentTarget.checked } })}
                      type="checkbox"
                    />
                    <span>{EVENT_WORDS[event]}</span>
                  </label>
                </li>
              ))}
            </ul>
          </details>
          <div>
            <button
              aria-describedby={tipId}
              className={QUIET}
              data-pulls-stop=""
              disabled={busy}
              onClick={() => change({ watch: false })}
              title={STOP_WATCHING_TIP}
              type="button"
            >
              Stop watching
              <Info aria-hidden="true" size={14} />
            </button>
            <span className="sr-only" id={tipId}>
              {STOP_WATCHING_TIP}
            </span>
          </div>
        </>
      )}
      {problem !== undefined && (
        <p className="m-0 text-meta text-err" role="alert">
          Could not change this: {problem}
        </p>
      )}
      {held.length > 0 && (
        <p className="m-0 text-meta text-warn" role="status">
          Waiting for you to confirm on the machine: {held.join(' ')}
        </p>
      )}
    </div>
  );
}
