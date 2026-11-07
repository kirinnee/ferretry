/**
 * Connections' policy entries (§7.1), copied from today's `runtime/mounts/{carriers,direct-carrier,tunnel,webrtc}.ts`
 * and the audit rules. Gate owns the vocabulary; these are references into it.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';

export const CAPABILITY = {
  pairing: CAPABILITIES.pairing,
} as const;

export const CONFIGURE = {
  pairing: { capability: CAPABILITY.pairing, axis: 'configure' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const AUDIT = {
  securityChanged: auditKind('security.changed'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
/** The direct carrier's socket carries sealed frames only; the session layer records what a session does. */
export const SKIP_SEALED = {
  skip: 'sealed frames only: the session layer authenticates and records what the session does',
} as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'carrier addresses, tunnel state and SDP only; sealed frames are opaque here; no pane, page or vault text',
} as const satisfies GuardDeclaration;
