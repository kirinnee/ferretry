/**
 * The connector's policy entries (§7.1): references into Gate's vocabulary, the way Connections' `policy.ts` is.
 * The owner routes are a person's (`caller: 'person'`) on the `pairing` capability, as the tunnel switch is; the door
 * routes are Public (`minimum: 'none'`) and carry no capability at all.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { auditKind, CAPABILITIES, STEP_UP_ACTS } from '@ferretry/core-gate/contract';

export const PAIRING_USE: CapabilityDemand = { capability: CAPABILITIES.pairing, axis: 'use' };
/** Approving ADDS access, so it asks `configure`: a device the operator narrowed to `pairing.use` cannot hand out a connector. */
export const PAIRING_CONFIGURE: CapabilityDemand = { capability: CAPABILITIES.pairing, axis: 'configure' };
/** Denying and revoking only take away, declared `narrowing` exactly as a device revocation is. */
export const PAIRING_NARROWING: CapabilityDemand = { ...PAIRING_USE, narrowing: true };
/** The passkey the app proves for one approval. Named on the route so the first refusal says which act to confirm. */
export const APPROVE_CONNECTOR: CapabilityDemand = { ...PAIRING_CONFIGURE, act: STEP_UP_ACTS.approveConnector };

export const SECURITY_CHANGED = { record: auditKind('security.changed') } as const;
/** `PUT /v1/connector` records `security.changed` itself (subject `connector`), once the switch really changed. */
export const RECORDED_BY_HANDLER = {
  skip: 'recorded by the handler as security.changed (subject connector, detail enabled) once the switch really changed',
} as const satisfies AuditDeclaration;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
/** An act of the connector's own is recorded by the authority (`connector.*` kinds), once the act really happened. */
export const RECORDED_BY_AUTHORITY = {
  skip: 'recorded by the authorization server itself, as the connector.* kinds, once the act has happened',
} as const satisfies AuditDeclaration;

export const GUARD_NONE = {
  none: 'sign-in metadata, a match code and a client name only; no pane, page or vault text',
} as const satisfies GuardDeclaration;
export const GUARD_DOOR = {
  none: 'OAuth documents and a refusal sentence only; a token is in the minting response alone and no vault text is read',
} as const satisfies GuardDeclaration;
