/**
 * A project's watch switch and what may notify the phone (r9 E3). Watching is OFF until a person turns it on, because a
 * watch asks GitHub on a timer with the connected account; this is the one place that says so and offers the switch.
 *
 * Every change is one PATCH of what changed; the screen then reads again, so what is drawn is what the daemon holds. A
 * change the daemon holds for the owner (it would loosen something) is shown as the daemon worded it, never as done.
 */
import { useState } from 'react';
import type { WatchEvent, WatchProjectView } from '../../../contract/index.ts';
import { type ListClient, patchWatch } from './api.ts';
import { EVENT_ORDER, EVENT_WORDS } from './model.ts';

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export interface WatchControlsProps {
  readonly client: ListClient;
  readonly view: WatchProjectView;
  /** Called after the daemon took a change, so the screen reads the truth again. */
  readonly onChanged: () => void;
}

export function WatchControls({ client, view, onChanged }: WatchControlsProps) {
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

  const labelId = `pulls-watch-${view.project}`;
  return (
    <div className="grid gap-xs" data-pulls-watch={view.project}>
      <label className="flex min-h-[44px] items-start gap-xs py-1 text-ui" htmlFor={labelId}>
        <input
          checked={view.watch}
          className="mt-1 size-4 shrink-0"
          disabled={busy}
          id={labelId}
          onChange={event => change({ watch: event.currentTarget.checked })}
          type="checkbox"
        />
        <span className="min-w-0">
          <span className="font-medium text-fg">Watch this project’s pull requests</span>
          <span className="block text-meta text-muted">
            Off until you turn it on. Ferretry then asks GitHub every few minutes, with the account connected to the
            project, and tells you when something changes.
          </span>
        </span>
      </label>
      {view.watch && (
        <details className="text-ui" data-pulls-notify="">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-meta font-medium text-fg-soft">
            What notifies your phone
          </summary>
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
