import { HealthViewSchema, type IFyApiClient } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';

/** Where the daemon reports what it offers (`HealthView.features`). */
export const DAEMON_HEALTH_PATH = '/v1/health';

/**
 * Said when the daemon could not be asked what it offers. Told apart from "it does not report that feature" on
 * purpose: a new daemon whose health read failed is not an old daemon, and nothing should be blamed on its version.
 */
export class DaemonFeaturesUnreadable extends Error {
  constructor(cause: unknown) {
    super(
      `could not ask the daemon what it offers (${cause instanceof Error ? cause.message : String(cause)}): nothing was changed; check \`fy daemon status\` and run this again`,
    );
    this.name = 'DaemonFeaturesUnreadable';
  }
}

/** The one sentence for a daemon that does not report `what` yet: the machine needs an update, said with the remedy. */
export const daemonNeedsUpdate = (what: string): string =>
  `this machine's daemon is too old for ${what}: update it (fy daemon update), then run this again. Nothing was changed`;

/**
 * THE ONE READ OF THE DAEMON'S FEATURES for every CLI gateway. It throws {@link DaemonFeaturesUnreadable} when the
 * health read fails (network, auth or a reply that does not parse), so a caller that gates on a feature never
 * mistakes "could not ask" for "not reported". A daemon that answers but lists no features reports none.
 */
export async function readDaemonFeatures(client: Pick<IFyApiClient, 'request'>): Promise<readonly string[]> {
  try {
    const health = await client.request(DAEMON_HEALTH_PATH, HealthViewSchema);
    return health.features ?? [];
  } catch (error) {
    throw new DaemonFeaturesUnreadable(error);
  }
}

/** Whether `error` is the daemon's "no such route" (`404 unknown_route`): its routes for this are missing. */
export const isUnknownRoute = (error: unknown): boolean =>
  error instanceof FyHttpError && error.status === 404 && error.code === 'unknown_route';

/** Turns a `404 unknown_route` into {@link daemonNeedsUpdate}'s sentence for `what`; any other error passes through. */
export const updateRefusal =
  (what: string) =>
  (error: unknown): never => {
    throw isUnknownRoute(error) ? new Error(daemonNeedsUpdate(what)) : error;
  };
