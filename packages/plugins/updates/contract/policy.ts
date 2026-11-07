/**
 * Updates' policy entries (§7.1), copied from today's `runtime/mounts/{daemon-update,harness-update,update}.ts` and
 * their audit rules: updating runs new code on the machine, so it is kept as a change to the machine's security.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';

export const CAPABILITY = {
  fleet: CAPABILITIES.fleet,
} as const;

export const USE = {
  fleet: { capability: CAPABILITY.fleet, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const CONFIGURE = {
  fleet: { capability: CAPABILITY.fleet, axis: 'configure' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT = {
  securityChanged: auditKind('security.changed'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'versions, install methods and update reports only; no pane, page or vault text',
} as const satisfies GuardDeclaration;
