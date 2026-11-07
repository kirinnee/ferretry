/**
 * The fail-closed status ports while the kernel cannot bind Logins' owned credentials root.
 *
 * The approved metadata readers live in adapters/credentials/owned-store.ts and accept only that internal root.
 * Until the root contract is available, default composition grants no access and uses these ports. Host-home reads
 * remain unavailable. Nothing here invents a status: an unread store is never "ready" because nothing contradicted it.
 */
import { UNREADABLE_CREDENTIAL_FACTS, type CredentialStatusPorts } from './credential-status.ts';
import { InMemoryCredentialStatusStore } from './credential-status.ts';
import type { CredentialStoreInspection } from '../shared/store-inspection.ts';

const WHY = 'this build cannot open a harness’s sign-in files, so it cannot say what is stored there';

/** The one inspection every store gets: nothing was looked at, and the reading says why. */
export const UNOPENABLE_INSPECTION: CredentialStoreInspection = {
  reading: { state: 'unreadable', reason: WHY },
  checked: [],
};

export function unreadableStatusPorts(now: () => number, usageIntervalMs: number): CredentialStatusPorts {
  return {
    local: async () => UNREADABLE_CREDENTIAL_FACTS,
    passiveUsage: async () => undefined,
    activeUsage: async () => ({
      result: { usageBased: false, ok: false, unavailable: true, unavailableReason: WHY },
      local: UNREADABLE_CREDENTIAL_FACTS,
    }),
    refresh: { refresh: async () => ({ outcome: 'unavailable', reason: WHY }) },
    heads: new InMemoryCredentialStatusStore(),
    now,
    usageIntervalMs,
  };
}
