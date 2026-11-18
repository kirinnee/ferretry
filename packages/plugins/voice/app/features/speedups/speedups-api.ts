/**
 * The browser's half of Speed-ups.
 *
 * NO KEY IS READ HERE AND NONE IS SENT HERE. A key goes in through the ordinary secret route
 * (`putSecret`), under the name the daemon told us; the status read answers names, booleans and
 * instants; a Test answers a code and a fixed sentence. The daemon spends a key only through its one
 * outbound holder, so nothing in this browser can obtain one however it asks.
 */

import type { IFyApiClient } from '../../shell-voice.ts';
import {
  SPEEDUPS_PATH,
  type SpeedupProvider,
  type SpeedupsView,
  SpeedupsViewSchema,
  type SpeedupTestResult,
  SpeedupTestResultSchema,
} from '../../../contract/index.ts';

/** The only client capability the Speed-ups surface uses. */
export type SpeedupClient = Pick<IFyApiClient, 'request'>;

/**
 * `read`: `'pressed'` (or `true`) when the person asked — "Confirm it's you to see this" — so a step-up may be asked for;
 * `'quiet'` when the panel reads on its own (it mounted, or the machine said a key moved), so a step-up the machine
 * wants is the answer and no prompt opens; neither, a read that follows the person's own press (a Save).
 */
export async function readSpeedups(
  client: SpeedupClient,
  read: boolean | 'pressed' | 'quiet' = false,
): Promise<SpeedupsView> {
  const init = read === true || read === 'pressed' ? { pressed: true } : read === 'quiet' ? { quiet: true } : undefined;
  return await client.request(SPEEDUPS_PATH, SpeedupsViewSchema, init);
}

/** Spends the provider's key once, the cheapest way that provider allows. Never on a timer. */
export async function testSpeedup(client: SpeedupClient, provider: SpeedupProvider): Promise<SpeedupTestResult> {
  return await client.request(`/v1/speedups/${provider}/test`, SpeedupTestResultSchema, { method: 'POST' }, 15_000);
}
