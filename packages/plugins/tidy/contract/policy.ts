/**
 * Tidy's policy entries (§7.1), copied from today's `runtime/mounts/{scratch-gc,tidy}.ts` and the housekeeping module's
 * route contract: `/v1/gc` is ungoverned (operator, any caller), the plan is a `fleet` read.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { cap } from '@ferretry/core-gate/contract';

export const USE = { fleet: cap('fleet', 'use') } as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT_SKIP = {
  sweep: { skip: 'scratch cleanup of files a stopped ferret left; reaches nobody' },
  plan: {
    skip: 'a read: a POST only so a plan is never cached by a proxy; it decides what one ferret could tidy and changes nothing',
  },
  read: { skip: 'a read: it changes nothing' },
} as const satisfies Readonly<Record<string, AuditDeclaration>>;

export const GUARD_NONE = {
  none: 'file names and sizes of stopped ferrets, and card titles; no pane, page or vault text',
} as const satisfies GuardDeclaration;
