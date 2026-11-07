/**
 * Whether the machine's Jev key is set, read from Speed-ups (`GET /v1/speedups`): names, booleans and instants, never
 * a key. The Warden settings form shows the answer beside the Jev layer and links to where a key is entered.
 */

import { z } from 'zod';

export interface SpeedupStatus {
  readonly provider: string;
  readonly keyUrl: string;
  readonly set: boolean;
}

/** The Speed-ups description of a machine, as far as the Warden reads it. */
export interface SpeedupsView {
  readonly providers: readonly SpeedupStatus[];
  readonly vault: 'ok' | 'damaged';
}

const SpeedupsViewSchema = z.object({
  providers: z.array(z.object({ provider: z.string(), keyUrl: z.string(), set: z.boolean() })),
  vault: z.enum(['ok', 'damaged']),
});

/** Speed-ups' answer, parsed. Throws when the body is not one. */
export const parseSpeedups = (body: unknown): SpeedupsView => SpeedupsViewSchema.parse(body);

/**
 * GAP(plugin-edge): the read itself ('Speed-ups' description of the machine, owned by Voice) waits for the Warden
 * manifest to declare it uses Voice; until then no route of another plugin is called and the card says the key
 * could not be checked. The swap is this one function: call Voice's route through the client and `parseSpeedups`.
 */
export const readSpeedups = async (): Promise<SpeedupsView> => {
  throw new Error('The Warden does not read Speed-ups yet.');
};
