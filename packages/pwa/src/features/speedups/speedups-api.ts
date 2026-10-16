/**
 * The browser's half of Speed-ups.
 *
 * NO KEY IS READ HERE AND NONE IS SENT HERE. A key goes in through the ordinary secret route
 * (`putSecret`), under the name the daemon told us; the status read answers names, booleans and
 * instants; a Test answers a code and a fixed sentence. The daemon spends a key only through its one
 * outbound holder, so nothing in this browser can obtain one however it asks.
 */

import {
  type IFyApiClient,
  SPEEDUPS_PATH,
  type SpeedupProvider,
  type SpeedupsView,
  SpeedupsViewSchema,
  type SpeedupTestResult,
  SpeedupTestResultSchema,
} from '@ferretry/protocol';

/** The only client capability the Speed-ups surface uses. */
export type SpeedupClient = Pick<IFyApiClient, 'request'>;

export async function readSpeedups(client: SpeedupClient): Promise<SpeedupsView> {
  return await client.request(SPEEDUPS_PATH, SpeedupsViewSchema);
}

/** Spends the provider's key once, the cheapest way that provider allows. Never on a timer. */
export async function testSpeedup(client: SpeedupClient, provider: SpeedupProvider): Promise<SpeedupTestResult> {
  return await client.request(`/v1/speedups/${provider}/test`, SpeedupTestResultSchema, { method: 'POST' }, 15_000);
}
