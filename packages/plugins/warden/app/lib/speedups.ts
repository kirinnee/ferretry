/**
 * Whether the machine's Jev key is set, read from Voice's Speed-ups (`GET /v1/speedups`): names, booleans and instants,
 * never a key. The Warden settings form shows the answer beside the Jev layer and links to where a key is entered.
 * Voice is an optional use of the Warden: with Voice off the read answers `off` and the form shows no key line.
 */

import { isPluginOff } from './plugin-off.ts';
import { SpeedupsViewSchema, type SpeedupsView } from '@ferretry/plugin-voice/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';

export type { SpeedupsView };

/** The Speed-ups description of a machine, or `off` when Voice is not running on it. */
export const readSpeedups = async (client: Pick<PluginClient, 'call'>): Promise<SpeedupsView | 'off'> => {
  try {
    return SpeedupsViewSchema.parse(await client.call<unknown>('GET /v1/speedups'));
  } catch (cause) {
    if (isPluginOff(cause)) return 'off';
    throw cause;
  }
};
