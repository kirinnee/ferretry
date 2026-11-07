/**
 * The status ports for a build whose daemon half cannot open a harness's sign-in files.
 *
 * `credentials/<login>/` is declared `opaque` state (§9.2): Ferretry links and points at a harness's own files and never
 * opens one. Today's status read parsed those files (shape, expiry, account) and made the free provider read with the
 * token inside; neither is available to a plugin, so every port here answers "not readable" and nothing is invented:
 * a status is never "ready" because nothing contradicted it. This is a declared GAP, closed when the kernel offers a
 * store reader or the harness plugins report their own sign-in state (see the port report).
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
