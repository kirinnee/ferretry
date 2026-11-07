/**
 * STAND-IN for `@ferretry/core-gate/contract` and `@ferretry/core-ferrets/contract` until the core-contracts slice
 * lands on origin/rebuild/5.0. The ONLY file here that names a core export, each by its core name (`CAPABILITIES`,
 * `auditKind`, `FerretChanged`, `FerretsPort`); replace the body with re-exports when the core contracts merge.
 */
import { defineHook, definePort, type FerretId, type PolicyRef, policyRef } from '@ferretry/kernel/contract';
import { z } from 'zod';

export const CAPABILITIES = {
  fleet: policyRef('capability', 'fleet'),
} as const satisfies Readonly<Record<string, PolicyRef<'capability'>>>;

export const auditKind = (name: string): PolicyRef<'audit'> => policyRef('audit', name);

export const FerretIdSchema = z
  .string()
  .min(1)
  .transform(value => value as FerretId);
export const FerretStateSchema = z.enum(['starting', 'working', 'idle', 'stopped']);

/** `ferret.changed` (Ferrets, observe): Updates installs only when no ferret is mid-turn. */
export const FerretChanged = defineHook('ferret.changed', {
  mode: 'observe',
  payload: z.strictObject({ ferret: FerretIdSchema, state: FerretStateSchema }),
});

/** The slice of Ferrets' port Updates reads: how many ferrets are mid-turn right now. */
export interface FerretsApi {
  list(): Promise<readonly FerretId[]>;
  state(ferret: FerretId): Promise<z.infer<typeof FerretStateSchema> | undefined>;
}
export const FerretsPort = definePort<FerretsApi>('ferrets');
