/**
 * STAND-IN for the core contracts (`@ferretry/core-gate/contract`, `@ferretry/core-vault/contract`) until the
 * core-contracts slice lands on origin/rebuild/5.0. The ONLY file here that names a core export, each by its core
 * name (`CAPABILITIES`, `auditKind`, `InputTargets`, `SECRET_REFERENCE_SOURCE`); replace with re-exports on merge.
 */
import { defineHook, type PolicyRef, policyRef } from '@ferretry/kernel/contract';
import { z } from 'zod';

export const CAPABILITIES = {
  browser: policyRef('capability', 'browser'),
} as const satisfies Readonly<Record<string, PolicyRef<'capability'>>>;

export const auditKind = (name: string): PolicyRef<'audit'> => policyRef('audit', name);

/** Vault's `input.targets` (provide, security path): each tool's adapter for typing an owner's value. */
export const InputTargets = defineHook('input.targets', {
  mode: 'provide',
  key: z.enum(['terminal', 'page']),
  value: z.custom<unknown>(),
  takers: ['terminals', 'browsers'],
});

/** The `${secret:NAME}` grammar (docs/secrets.md): a value used by name, never written in a file. */
export const SECRET_REFERENCE_SOURCE = '\\$\\{secret:([A-Z][A-Z0-9_]{0,63})\\}';
