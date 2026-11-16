/**
 * The browser's half of the daemon's profile route (`POST /v1/diagnostics/profile`, then
 * `GET /v1/diagnostics/profile/:id`).
 *
 * A profile is STARTED, then READ: the start answers at once with an id and when the window ends, and
 * the panel reads it back once the window is over. A thirty-second request over a relay would be one
 * dropped connection away from losing the whole window; a lost read is only asked again.
 *
 * Like every Settings client this takes the daemon's client rather than building one, so a profile started on
 * machine A is never read from machine B.
 */

import { type PerformanceProfileView, PerformanceProfileViewSchema } from '../../../contract/index.ts';
import type { UsageClient } from '../../shell.ts';

export type PerformanceClient = UsageClient;

/** Starts the daemon's profile over `seconds`; answers the running view (its id and window). */
export async function startDaemonProfile(client: PerformanceClient, seconds: number): Promise<PerformanceProfileView> {
  return PerformanceProfileViewSchema.parse(await client.call('POST /v1/diagnostics/profile', { body: { seconds } }));
}

/** Reads a profile back: still `running`, or `finished` with its report. */
export async function readDaemonProfile(client: PerformanceClient, id: string): Promise<PerformanceProfileView> {
  return PerformanceProfileViewSchema.parse(await client.call('GET /v1/diagnostics/profile/:id', { params: { id } }));
}
