import type { UsageFeedPort, UsageSnapshot } from '../../usage/types.ts';
import { renderUsageMetrics } from '../metrics.ts';
import { jsonResponse, PROMETHEUS_CONTENT_TYPE, textResponse } from '../responses.ts';
import type { ApiRoute } from '../route.ts';
import type { MillisecondClockPort } from '../../runtime/boot.ts';

/**
 * The account-health feed, in the two shapes its consumers need.
 *
 * There is exactly ONE collection behind both: the daemon-wide cached feed. The source ran a
 * separate collector process per host and every consumer probed it independently, which is how a
 * scrape could cost real inference calls. Here a scrape only reads what the feed already has.
 */

/** The JSON body external consumers already parse: `{at, accounts}`. */
export interface UsageFeedDocument {
  /** Epoch milliseconds of the last completed collection, or 0 when there has never been one. */
  readonly at: number;
  /**
   * Whether `accounts` reflects a real collection.
   *
   * The source answered `{at: 0, accounts: []}` for both "the fleet is empty" and "the collector
   * failed", so its only hard gate on this feed could not tell them apart and chose to fail open —
   * a rate-limited account looked exactly like an unconfigured one. This flag is the distinction.
   */
  readonly ready: boolean;
  readonly accounts: UsageSnapshot['accounts'];
}

async function currentSnapshot(feed: UsageFeedPort): Promise<UsageSnapshot | undefined> {
  let accounts: UsageSnapshot['accounts'];
  try {
    accounts = await feed.accounts();
  } catch {
    // A collection failure must not fail the scrape: a scraper that gets a 500 records an outage of
    // the DAEMON, when what is actually down is one upstream account API.
    return undefined;
  }
  const at = feed.snapshotAt();
  return at === undefined ? undefined : { at, accounts };
}

function document(snapshot: UsageSnapshot | undefined): UsageFeedDocument {
  return { at: snapshot?.at ?? 0, ready: snapshot !== undefined, accounts: snapshot?.accounts ?? [] };
}

/**
 * `/usage` is public and `/v1/usage` is token-scoped, serving the same body.
 *
 * The public one exists because the feed's external consumers are separate processes on this host
 * that hold no daemon token; the percentages it carries are operational telemetry, not secrets. The
 * `/v1` one is the surface the CLI and the recommender use, and it stays behind a token so the
 * versioned API has one consistent authorization story.
 */
export function usageRoutes(feed: UsageFeedPort, clock: MillisecondClockPort): readonly ApiRoute[] {
  const usage = async () => jsonResponse(document(await currentSnapshot(feed)));
  return [
    { method: 'GET', path: '/usage', scope: 'public', noStore: true, handle: usage },
    { method: 'GET', path: '/v1/usage', scope: 'warden', noStore: true, handle: usage },
    {
      method: 'GET',
      path: '/metrics',
      scope: 'public',
      noStore: true,
      handle: async () =>
        textResponse(renderUsageMetrics(await currentSnapshot(feed), clock.now()), 200, PROMETHEUS_CONTENT_TYPE),
    },
  ];
}
