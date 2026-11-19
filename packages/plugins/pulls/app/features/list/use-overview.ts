/**
 * The PRs screen, the live half (r9 E3): one read, then a re-read every minute while the tab is visible, and at once when
 * the daemon says a project's PRs changed. The reads are the daemon's own snapshot, never GitHub, and reading it is what
 * tells the watch a screen is open (E2's 60-second cadence), so a hidden tab reads nothing and the watch relaxes.
 *
 * Only the newest read counts: a read that starts supersedes the one in flight (it is aborted, and whatever it answers
 * is dropped), so a slow older answer can never replace a newer one, and exactly one timer is ever pending.
 */
import { useDocumentVisible } from '@ferretry/app';
import { readPress } from '@ferretry/app/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { PullsChanged, type WatchOverview } from '../../../contract/index.ts';
import { type ListClient, type ProjectFacts, readOverview, readProjects } from './api.ts';

/** Under E2's `viewedWithinMs` (150 s), so one screen keeps the watch at its 60-second pace. */
const REFRESH_MS = 60_000;

export type Reading =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly message: string }
  | {
      readonly status: 'ready';
      readonly overview: WatchOverview;
      /** What the project records say, by project id (a name; whether the folder holds no repository). */
      readonly projects: ReadonlyMap<string, ProjectFacts>;
      /** A refresh that failed after one that worked: what is drawn is the last good read. */
      readonly stale?: string;
    };

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export function useOverview(client: ListClient): { reading: Reading; reload: () => void } {
  const [reading, setReading] = useState<Reading>({ status: 'loading' });
  const [round, setRound] = useState(0);
  // Set by Try again, spent by the very next read: only that one is the person's press.
  const pressed = useRef(false);
  const visible = useDocumentVisible();

  useEffect(() => {
    // `round` is a new read on demand (a change just landed): it is only a reason to run again.
    void round;
    if (!visible) return undefined;
    let current: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let press = readPress(pressed.current);
    pressed.current = false;
    const read = (): void => {
      const spent = press;
      press = {};
      if (timer !== undefined) clearTimeout(timer);
      current?.abort();
      const mine = new AbortController();
      current = mine;
      void Promise.all([readOverview(client, mine.signal, spent), readProjects(client, mine.signal)]).then(
        ([overview, projects]) => {
          if (mine.signal.aborted) return;
          setReading({ status: 'ready', overview, projects });
          timer = setTimeout(read, REFRESH_MS);
        },
        (cause: unknown) => {
          if (mine.signal.aborted) return;
          setReading(previous =>
            previous.status === 'ready'
              ? { ...previous, stale: reasonOf(cause) }
              : { status: 'failed', message: reasonOf(cause) },
          );
          timer = setTimeout(read, REFRESH_MS);
        },
      );
    };
    read();
    // A change the daemon saw reads again at once, so the list moves without a reload.
    const cancel = client.subscribe?.(PullsChanged, () => read());
    return () => {
      current?.abort();
      if (timer !== undefined) clearTimeout(timer);
      cancel?.();
    };
  }, [client, visible, round]);

  const reload = useCallback(() => {
    pressed.current = true;
    setRound(value => value + 1);
  }, []);
  return { reading, reload };
}
