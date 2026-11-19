/**
 * Policy entries (docs/grants.md): no new capability. Connecting and removing an account is `secrets.configure`
 * (passkey step-up from a paired device); listing is `secrets.use`.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { cap } from '@ferretry/core-gate/contract';

export const GIT_ACCOUNT_CAPS = {
  list: cap('secrets', 'use'),
  configure: cap('secrets', 'configure'),
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

/** Ids only: the account id, never a login's token or a code. */
export const GIT_ACCOUNT_AUDIT = {
  added: 'git-account.added',
  removed: 'git-account.removed',
} as const;

export const GIT_ACCOUNT_AUDIT_SKIP = {
  startFlow: { skip: 'starting a flow files nothing; the account is recorded when it is added' },
  pollFlow: {
    skip: 'a poll; the service records git-account.added once, with the account id, when the flow connects it',
  },
  list: { skip: 'a read of logins and key titles; no token' },
} as const satisfies Readonly<Record<string, AuditDeclaration>>;

export const GIT_ACCOUNT_GUARD = {
  none: 'a user code, a verification address, a login and key titles; never a token, a device code or key material',
} as const satisfies GuardDeclaration;
