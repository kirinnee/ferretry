import { useEffect, useRef, useState } from 'react';
import type { DaemonAttentionClient } from '../lib/attention-client.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import { useAttentionSnapshot } from './use-attention.ts';

/** The clock the countdown reads: `now` in epoch ms, and `every` to be called on each tick until undone. */
export interface RepliesClock {
  readonly now: () => number;
  readonly every: (tick: () => void, ms: number) => () => void;
}

export const browserRepliesClock: RepliesClock = {
  now: () => Date.now(),
  every: (tick, ms) => {
    const handle = setInterval(tick, ms);
    return () => clearInterval(handle);
  },
};

export interface AttentionReplies {
  /** Whole seconds until the daemon sends the held answers; `null` when nothing is held. */
  readonly secondsLeft: number | null;
  readonly pending: readonly string[];
  readonly sending: boolean;
  readonly sendNow: () => void;
}

/** Whole seconds from `now` to `dueAt`, rounded up, never negative; `null` for an unreadable instant. */
export const secondsUntil = (dueAt: string, now: number): number | null => {
  const due = Date.parse(dueAt);
  return Number.isNaN(due) ? null : Math.max(0, Math.ceil((due - now) / 1000));
};

/**
 * The daemon holds a ferret's answers for a settle window; this counts it down from the board's `replies`
 * and offers "Send now". A daemon that never sends `replies` delivers at once, so this stays empty for it.
 * When the window passes, the board is read again once, so the held answers are seen to have left.
 */
export const useAttentionReplies = (
  client: DaemonAttentionClient,
  connection: DaemonConnection,
  scope: DaemonSessionScope | null,
  clock: RepliesClock = browserRepliesClock,
): AttentionReplies => {
  const replies = useAttentionSnapshot(client, scope)?.replies;
  const dueAt = replies?.dueAt;
  const [now, setNow] = useState(() => clock.now());
  const [sending, setSending] = useState(false);
  const rereadFor = useRef<string | null>(null);

  useEffect(() => {
    if (dueAt === undefined) return undefined;
    setNow(clock.now());
    return clock.every(() => setNow(clock.now()), 1000);
  }, [dueAt, clock]);

  const secondsLeft = dueAt === undefined ? null : secondsUntil(dueAt, now);
  const expired = dueAt !== undefined && secondsLeft === 0;

  useEffect(() => {
    if (!expired || scope === null || dueAt === undefined || rereadFor.current === dueAt) return;
    rereadFor.current = dueAt;
    void client.revalidate(connection, scope).catch(() => {});
  }, [expired, dueAt, client, connection, scope]);

  const sendNow = (): void => {
    if (scope === null || sending) return;
    setSending(true);
    void client
      .sendReplies(connection, scope)
      .catch(() => {})
      .finally(() => setSending(false));
  };

  return {
    secondsLeft: expired ? null : secondsLeft,
    pending: expired ? [] : (replies?.pending ?? []),
    sending,
    sendNow,
  };
};
