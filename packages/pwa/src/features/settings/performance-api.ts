/**
 * The browser's half of the daemon's profile route (`POST /v1/diagnostics/profile`, then
 * `GET /v1/diagnostics/profile/:id`).
 *
 * A profile is STARTED, then READ: the start answers at once with an id and when the window ends, and
 * the panel reads it back once the window is over. A thirty-second request over a relay would be one
 * dropped connection away from losing the whole window; a lost read is only asked again.
 *
 * Like every Settings client this takes a client rather than building one, so a profile started on
 * machine A is never read from machine B.
 */

import { type IFyApiClient, type PerformanceProfileView, PerformanceProfileViewSchema } from '@ferretry/protocol';

export type PerformanceClient = Pick<IFyApiClient, 'request'>;

/** Starts the daemon's profile over `seconds`; answers the running view (its id and window). */
export async function startDaemonProfile(client: PerformanceClient, seconds: number): Promise<PerformanceProfileView> {
  return await client.request('/v1/diagnostics/profile', PerformanceProfileViewSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds }),
  });
}

/** Reads a profile back: still `running`, or `finished` with its report. */
export async function readDaemonProfile(client: PerformanceClient, id: string): Promise<PerformanceProfileView> {
  return await client.request(`/v1/diagnostics/profile/${encodeURIComponent(id)}`, PerformanceProfileViewSchema);
}
