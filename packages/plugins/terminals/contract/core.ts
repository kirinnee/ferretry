/**
 * STAND-IN for the core contracts (`@ferretry/core-gate/contract`, `@ferretry/core-vault/contract`,
 * `@ferretry/core-ferrets/contract`) until the core-contracts slice lands on origin/rebuild/5.0. The ONLY file here
 * that names a core export, each by its core name (`CAPABILITIES`, `auditKind`, `InputTargets`, `Runners`); replace
 * the body with re-exports when the core contracts merge.
 */
import { defineHook, type PolicyRef, policyRef } from '@ferretry/kernel/contract';
import { z } from 'zod';

export const CAPABILITIES = {
  fleet: policyRef('capability', 'fleet'),
  terminal: policyRef('capability', 'terminal'),
} as const satisfies Readonly<Record<string, PolicyRef<'capability'>>>;

export const auditKind = (name: string): PolicyRef<'audit'> => policyRef('audit', name);

/** Vault's `input.targets` (provide, security path): each tool's adapter for typing an owner's value. */
export const InputTargets = defineHook('input.targets', {
  mode: 'provide',
  key: z.enum(['terminal', 'page']),
  value: z.custom<unknown>(),
  takers: ['terminals', 'browsers'],
});

/** Ferrets' `runners` (provide, security path): where a ferret's process runs; `attach` adopts a live pane (D15). */
export const Runners = defineHook('runners', {
  mode: 'provide',
  key: z.enum(['tmux']),
  value: z.custom<unknown>(),
  takers: ['terminals'],
});
