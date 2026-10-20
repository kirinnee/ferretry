/**
 * READING ONE WINDOW OF SESSIONS with the fewest requests the query language allows.
 *
 * The overview needs per-session rows (see `analytics-overview.ts` for why an aggregate cannot carry a
 * partial cost), and a raw read returns at most one page of the newest rows. So the read starts wide
 * and narrows only where it has to:
 *
 * 1. one raw read per calendar month the window touches — a small fleet is done here, in one or two
 *    requests;
 * 2. a month that came back truncated is re-read one day at a time, for the window's days only;
 * 3. a single day that is still truncated keeps the rows it listed, and its session and unpriced
 *    counts come from the daemon's own `sum by (day)` for that day, so the totals stay true and the
 *    day is marked partial rather than silently short.
 *
 * Nothing here knows a daemon or a transport: the caller hands in a function that answers one query.
 */

import type { AnalyticsRawSession, AnalyticsResponse } from '@ferretry/protocol';

import {
  type AnalyticsPartialDay,
  analyticsMonthGlobs,
  type OverviewMachine,
  type OverviewRow,
  overviewRow,
} from './analytics-overview.ts';

export type AnalyticsQueryRead = (query: string) => Promise<AnalyticsResponse>;

export interface AnalyticsWindowRead {
  readonly rows: readonly AnalyticsRawSession[];
  readonly partial: readonly AnalyticsPartialDay[];
}

/** A raw matcher on the `day` label; `value` may be a month glob or one exact day. */
export const analyticsDayQuery = (value: string): string => `{day=${JSON.stringify(value)}}`;

type RawResponse = Extract<AnalyticsResponse, { readonly kind: 'raw' }>;

const readRaw = async (read: AnalyticsQueryRead, query: string): Promise<RawResponse> => {
  const response = await read(query);
  if (response.kind !== 'raw') throw new Error(`expected session rows for ${query}`);
  return response;
};

const readDay = async (read: AnalyticsQueryRead, day: string): Promise<AnalyticsWindowRead> => {
  const listed = await readRaw(read, analyticsDayQuery(day));
  if (!listed.truncated) return { rows: listed.results, partial: [] };
  const counted = await read(`sum by (day) ${analyticsDayQuery(day)}`);
  const total = counted.kind === 'aggregate' ? counted.results[0] : undefined;
  const cost = total?.equivalentApiCostUsdMicros;
  return {
    rows: listed.results,
    partial: [
      {
        day,
        sessions: total?.sessions ?? listed.results.length,
        unpriced: cost === undefined ? 0 : cost.total - cost.known,
      },
    ],
  };
};

/** Reads every session that started on one of `days`, narrowing a month to days only when it must. */
export const readAnalyticsWindow = async (
  read: AnalyticsQueryRead,
  days: readonly string[],
): Promise<AnalyticsWindowRead> => {
  const parts = await Promise.all(
    analyticsMonthGlobs(days).map(async (glob): Promise<readonly AnalyticsWindowRead[]> => {
      const month = await readRaw(read, analyticsDayQuery(glob));
      if (!month.truncated) return [{ rows: month.results, partial: [] }];
      const prefix = glob.slice(0, -1);
      return await Promise.all(days.filter(day => day.startsWith(prefix)).map(day => readDay(read, day)));
    }),
  );
  const reads = parts.flat();
  return { rows: reads.flatMap(part => part.rows), partial: reads.flatMap(part => part.partial) };
};

export interface MachineWindowRead {
  readonly rows: readonly OverviewRow[];
  readonly partial: readonly AnalyticsPartialDay[];
}

/** One machine's window, every row and partial day tagged with the machine it came from. */
export const readMachineWindow = async (
  read: AnalyticsQueryRead,
  days: readonly string[],
  machine: OverviewMachine,
): Promise<MachineWindowRead> => {
  const window = await readAnalyticsWindow(read, days);
  return {
    rows: window.rows.map(row => overviewRow(row, machine)),
    partial: window.partial.map(day => ({ ...day, daemonId: machine.daemonId })),
  };
};
