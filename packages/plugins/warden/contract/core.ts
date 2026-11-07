/**
 * STAND-IN for the core contracts (`@ferretry/core-ferrets/contract`, `@ferretry/core-asks/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. It is the ONLY file in this package that names a core
 * hook/id/port; when the real contracts merge, replace the body of this file with re-exports of the same names.
 */
import { defineHook, definePort, type FerretId } from '@ferretry/kernel/contract';
import { z } from 'zod';

export type { FerretId };
export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);

/** A ferret's state (Ferrets' word): starting, working, idle, stopped. */
export const FerretStateSchema = z.enum(['starting', 'working', 'idle', 'stopped']);

/** `ferret.changed` (Ferrets, observe): a ferret's state or process changed. Warden watches for trouble from it. */
export const FerretChanged = defineHook('ferret.changed', {
  mode: 'observe',
  payload: z.strictObject({ ferret: FerretIdSchema, state: FerretStateSchema }),
});

/** Stand-ins for the slices of `FerretsPort` and `AsksPort` Warden reads. */
export interface FerretsApi {
  state(ferret: FerretId): Promise<z.infer<typeof FerretStateSchema> | undefined>;
  list(): Promise<readonly FerretId[]>;
}
export const FerretsPort = definePort<FerretsApi>('ferrets');
export interface AsksApi {
  raise(ask: {
    readonly source: string;
    readonly ref: string;
    readonly entry?: string;
  }): Promise<{ readonly ask: string }>;
}
export const AsksPort = definePort<AsksApi>('asks');
