/**
 * What today's sessions on ONE machine cost, read from that machine's own analytics.
 *
 * `null` is "not known": the first read has not landed, the machine did not answer, or its sessions today
 * carry no price. A failed read never becomes a zero — the tile shows a dash instead of a false "$0".
 */

import { useEffect, useState } from 'react';
import { spendToday } from '../components/machine-home-model.ts';
import { fetchAnalytics } from '../features/analytics/analytics-api.ts';
import { utcDay } from '../features/analytics/analytics-overview.ts';
import { readAnalyticsWindow } from '../features/analytics/analytics-overview-load.ts';
import type { DaemonConnection, DaemonId } from '../lib/daemon-connection.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';

const realNow = (): Date => new Date();

/** How often the figure is read again while the page stays open. */
const SPEND_REFRESH_MS = 5 * 60 * 1000;

interface Held {
  readonly daemonId: DaemonId;
  readonly usd: number | null;
}

export const useSpendToday = (
  connection: DaemonConnection,
  fetcher: DaemonFetch,
  now: () => Date = realNow,
): number | null => {
  const [held, setHeld] = useState<Held>({ daemonId: connection.daemonId, usd: null });
  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const { rows } = await readAnalyticsWindow(
          query => fetchAnalytics(connection, query, fetcher),
          [utcDay(now())],
        );
        if (!cancelled) setHeld({ daemonId: connection.daemonId, usd: spendToday(rows) });
      } catch {
        // A machine that does not answer keeps the dash (or the last good figure); it is not a zero.
      }
    };
    void read();
    const timer = setInterval(() => void read(), SPEND_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, fetcher, now]);
  return held.daemonId === connection.daemonId ? held.usd : null;
};
