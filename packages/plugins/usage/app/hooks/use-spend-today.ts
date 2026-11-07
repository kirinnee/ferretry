/**
 * What today's ferrets on ONE machine cost, read from that machine's own insights.
 *
 * `null` is "not known": the first read has not landed, the machine did not answer, or its ferrets today
 * carry no price. A failed read never becomes a zero — the tile shows a dash instead of a false "$0".
 */

import { useEffect, useState } from 'react';
import type { AnalyticsRawSession } from '../../contract/index.ts';
import { fetchAnalytics } from '../features/analytics/analytics-api.ts';
import { utcDay } from '../features/analytics/analytics-overview.ts';
import { readAnalyticsWindow } from '../features/analytics/analytics-overview-load.ts';
import { browserClock, type DaemonConnection, type DaemonId, type UsageClient } from '../shell.ts';

const realNow = browserClock.now;

/** How often the figure is read again while the page stays open. */
const SPEND_REFRESH_MS = 5 * 60 * 1000;

/** Dollars the priced sessions of one day cost; an unpriced-only day is unknown, an empty day is a true zero. */
export const spendToday = (rows: readonly AnalyticsRawSession[]): number | null => {
  if (rows.length === 0) return 0;
  const priced = rows.flatMap(row => (row.equivalentApiCostUsdMicros === null ? [] : [row.equivalentApiCostUsdMicros]));
  return priced.length === 0 ? null : priced.reduce((sum, micros) => sum + micros, 0) / 1_000_000;
};

interface Held {
  readonly daemonId: DaemonId;
  readonly usd: number | null;
}

export const useSpendToday = (
  connection: DaemonConnection,
  client: UsageClient,
  now: () => Date = realNow,
): number | null => {
  const [held, setHeld] = useState<Held>({ daemonId: connection.daemonId, usd: null });
  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      try {
        const { rows } = await readAnalyticsWindow(query => fetchAnalytics(client, query), [utcDay(now())]);
        if (!cancelled) setHeld({ daemonId: connection.daemonId, usd: spendToday(rows) });
      } catch {
        // A machine that does not answer keeps the dash (or the last good figure); it is not a zero.
      }
    };
    void read();
    const stop = browserClock.every(() => void read(), SPEND_REFRESH_MS);
    return () => {
      cancelled = true;
      stop();
    };
  }, [connection, client, now]);
  return held.daemonId === connection.daemonId ? held.usd : null;
};
