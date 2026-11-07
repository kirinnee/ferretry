/**
 * STAND-IN for `@ferretry/core-gate/contract` until the core-contracts slice lands on origin/rebuild/5.0. It is the
 * ONLY file in this package that names a Gate export, and every name below is the one Gate's contract exports
 * (`CAPABILITIES`, `auditKind`, `CapabilityGrantsSchema`, `Credentials`, `StepUp`, `HolderKindSchema`). When Gate
 * merges, replace this body with `export { … } from '@ferretry/core-gate/contract'` and add the dependency.
 */
import { type PolicyRef, defineHook, policyRef } from '@ferretry/kernel/contract';
import { z } from 'zod';

export const CAPABILITY_NAMES = [
  'fleet',
  'terminal',
  'browser',
  'filesystem',
  'warden',
  'pairing',
  'secrets',
  'sharing',
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export const CAPABILITIES = Object.freeze(
  Object.fromEntries(CAPABILITY_NAMES.map(name => [name, policyRef('capability', name)])),
) as { readonly [K in CapabilityName]: PolicyRef<'capability'> };

export const auditKind = (name: string): PolicyRef<'audit'> => policyRef('audit', name);

export const CapabilityGrantSchema = z.strictObject({ use: z.boolean(), configure: z.boolean() });
export const CapabilityGrantsSchema = z.strictObject(
  Object.fromEntries(CAPABILITY_NAMES.map(name => [name, CapabilityGrantSchema])) as {
    readonly [K in CapabilityName]: typeof CapabilityGrantSchema;
  },
);
export type CapabilityGrants = z.infer<typeof CapabilityGrantsSchema>;

export const HolderKindSchema = z.enum(['device', 'member']);

/** Gate's `credentials` hook (provide, security path): Access answers for `device`, Catalogs for `member`. */
export const Credentials = defineHook('credentials', {
  mode: 'provide',
  key: HolderKindSchema,
  value: z.custom<unknown>(),
  takers: ['access', 'catalogs'],
});

/** Gate's `step-up` hook (provide, security path): the passkey witness for each holder kind. */
export const StepUp = defineHook('step-up', {
  mode: 'provide',
  key: HolderKindSchema,
  value: z.custom<unknown>(),
  takers: ['access', 'catalogs'],
});
