/**
 * Who a relay deployment is for.
 *
 * A relay is single-tenant by construction: it carries the daemons its deployer listed and refuses
 * everything else. That is the whole abuse answer. A relay that accepted any fingerprint that
 * connected would be an anonymous tunnel whose operator cannot see what it carries and cannot be
 * asked to stop carrying it, and the bill for that arrives in somebody's Cloudflare account.
 *
 * The listed value is a fingerprint, not a secret — the same string a pairing QR prints. It is
 * configuration, not credentials, so it belongs in a plain deployment variable and there is
 * nothing here for a leaked repository to expose. The fingerprint decides which rendezvous may
 * exist at all; possession of the key behind it is proved separately, per socket, by the claim.
 *
 * An unset or empty list serves **nobody**. A relay with no tenants is a misconfigured relay, and
 * reading that as "serve everyone" is exactly the shape of bug this repository keeps finding:
 * absent evidence read as the benign case. There is no configuration of this module that opens it
 * to the world.
 */

import { parseDaemonId } from './identity.ts';

export interface RelayTenancy {
  readonly daemonIds: ReadonlySet<string>;
  /** Entries that were present but not a valid fingerprint, so a typo is visible rather than silent. */
  readonly rejected: readonly string[];
}

/**
 * Parse the deployment's tenant list.
 *
 * Whitespace, commas and newlines all separate, because this value gets typed into a dashboard
 * field, pasted from a terminal and written into a config file, and a list that only works with
 * one of those separators fails at the least convenient moment.
 */
export function parseRelayTenancy(configured: string | undefined | null): RelayTenancy {
  const daemonIds = new Set<string>();
  const rejected: string[] = [];
  for (const entry of (configured ?? '').split(/[\s,]+/u)) {
    if (entry === '') continue;
    const parsed = parseDaemonId(entry);
    if (parsed === null) rejected.push(entry);
    else daemonIds.add(parsed);
  }
  return { daemonIds, rejected };
}

/** Does this deployment carry that daemon? Empty tenancy answers no, for every daemon. */
export function servesDaemon(tenancy: RelayTenancy, daemonId: string): boolean {
  const parsed = parseDaemonId(daemonId);
  return parsed !== null && tenancy.daemonIds.has(parsed);
}
