/**
 * Accounts' policy entries (§7.1), copied from today's `runtime/mounts/{secrets (the /v1/accounts half),
 * sign-in-rules,secure-copy,task-plans,input-requests (phone approvals)}.ts` and their audit rules. Gate owns the
 * vocabulary; these are references into it.
 */
import { auditKind, CAPABILITIES } from '@ferretry/core-gate/contract';
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';

export const CAPABILITY = {
  secrets: CAPABILITIES.secrets,
  terminal: CAPABILITIES.terminal,
} as const;

export const USE = {
  secrets: { capability: CAPABILITY.secrets, axis: 'use' },
  terminal: { capability: CAPABILITY.terminal, axis: 'use' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const CONFIGURE = {
  secrets: { capability: CAPABILITY.secrets, axis: 'configure' },
  terminal: { capability: CAPABILITY.terminal, axis: 'configure' },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const NARROW = {
  secrets: { capability: CAPABILITY.secrets, axis: 'use', narrowing: true },
  terminal: { capability: CAPABILITY.terminal, axis: 'use', narrowing: true },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

export const NARROW_CONFIGURE = {
  secrets: { capability: CAPABILITY.secrets, axis: 'configure', narrowing: true },
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

/** `agentTool`: every tool call is one `agent.tool` entry — the tool and ids, never a value. */
export const AUDIT = {
  agentTool: auditKind('agent.tool'),
  secretsChanged: auditKind('secrets.changed'),
  securityChanged: auditKind('security.changed'),
} as const;

export const SKIP_READ = { skip: 'a read: it changes nothing' } as const satisfies AuditDeclaration;
export const SKIP_UNRECORDED = { skip: 'not kept in the audit log today' } as const satisfies AuditDeclaration;
/** Today the sign-in-rule and task-plan services write `security.changed` themselves, only when a rule really moves. */
export const SKIP_BY_SERVICE = {
  skip: 'the service records security.changed itself when a rule or plan really changes',
} as const satisfies AuditDeclaration;
/** A 2FA key route keeps its own `secrets.changed` record (account id, action, key or stage id, proof) through Gate. */
export const SKIP_BY_ROUTE = {
  skip: 'the route records secrets.changed itself, with the account, the action and the key or stage id',
} as const satisfies AuditDeclaration;
export const GUARD_NONE = {
  none: 'account names, places, ids and rule state only; every saved value stays sealed in the Vault',
} as const satisfies GuardDeclaration;
