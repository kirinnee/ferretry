/**
 * Access's policy entries (§7.1): the capability demands, audit kinds and audit/guard declarations its routes carry,
 * copied from today's route tables (`runtime/mounts/{pairing,push,step-up}.ts` and the audit rules). Gate owns the
 * vocabulary; these are references into it.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';

export const CAPABILITY = {
  fleet: CAPABILITIES.fleet,
  pairing: CAPABILITIES.pairing,
} as const;

export const USE = {
  fleet: { capability: CAPABILITY.fleet, axis: 'use' },
  pairing: { capability: CAPABILITY.pairing, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const NARROW = {
  pairing: { capability: CAPABILITY.pairing, axis: 'use', narrowing: true },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT = {
  deviceRevoked: auditKind('device.revoked'),
  grantsChanged: auditKind('grants.changed'),
  pairingCodeMinted: auditKind('pairing.code-minted'),
  pairingCodeRevoked: auditKind('pairing.code-revoked'),
  passkeyRegistered: auditKind('passkey.registered'),
  pushChanged: auditKind('push.changed'),
  securityChanged: auditKind('security.changed'),
  stepUpSucceeded: auditKind('step-up.succeeded'),
} as const;

/** A read changes nothing, so it is not kept in the audit log (today's rule tables keep no read). */
export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
/** Today's audit rules keep no entry for this act; the descriptor says so rather than inventing one. */
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
/** Device, pairing, passkey and push answers carry ids, names, times and grants: no pane, page or vault text. */
export const GUARD_NONE = {
  none: 'device, pairing, passkey and push records only; no pane, page or vault text',
} as const satisfies GuardDeclaration;
