/**
 * WHAT THE BROWSER SAYS ABOUT THIS SITE REACHING THE LOCAL NETWORK.
 *
 * A daemon on this machine is reached at a loopback address, and Chrome 150 refuses such a request
 * from a page on a public origin BEFORE it is sent: the server sees no connection, no preflight and
 * no log line, and the page gets a `TypeError` with no status. That is byte-for-byte what a stopped
 * daemon looks like from the tab, which is why a panel that read one failure and said "the daemon is
 * unavailable" cost an owner and two agents an afternoon while `fy daemon status` printed a pid.
 *
 * This is the one thing the page can ask that tells them apart. It is asked ONCE, on a failure, and
 * it decides only what a sentence SAYS — never whether a request is made. A diagnostic that could
 * refuse a request would be a worse defect than the message it explains.
 *
 * ## `"prompt"` DOES NOT MEAN "IT WILL WORK", AND THAT IS THE COUNTER-INTUITIVE PART
 *
 * Measured on real Chrome 150: while the fetch is refused and zero requests reach the server, the
 * state reads `"prompt"` — not `"denied"`. Chrome does not raise a prompt to make it `"denied"`
 * first. So a check that treats anything other than `"denied"` as fine reports the blocked case as
 * healthy, which is the exact failure this module exists to end. `"prompt"` and `"denied"` are both
 * "not granted", and only `"granted"` rules the restriction out.
 *
 * ## IT NEVER THROWS AND NEVER GUESSES
 *
 * Firefox and Safari have no such permission, an older Chrome may not know the name, and a browser
 * is free to reject the query for a reason of its own. Every one of those answers `'unknown'`, and
 * `'unknown'` is worded as "either of two things could have happened" rather than as a diagnosis.
 */

import { z } from 'zod';

/**
 * The browser's answer, or the honest absence of one.
 *
 * The three real states are kept as the browser spells them rather than collapsed to a boolean: a
 * reader who is told "not allowed" acts differently from one told "refused", and the wording that
 * names the difference can only exist if the difference survives to here.
 */
export type LocalNetworkAccess = 'granted' | 'prompt' | 'denied' | 'unknown';

/** Not granted, whichever way it is spelled — the one distinction the message turns on. */
export const localNetworkBlocked = (access: LocalNetworkAccess): boolean => access === 'prompt' || access === 'denied';

/**
 * The permission query, as an object rather than a bare method.
 *
 * `query` is a WebIDL operation whose receiver must be the `Permissions` instance, so this seam
 * carries the OWNER and calls the member on it. A stored bare method is the bug
 * `scripts/validate/fetch-binding.sh` exists to fail: it works until somebody keeps it, and then the
 * browser answers `Illegal invocation` — presenting, of all things, as an unreachable daemon.
 *
 * Declared as a method so a real `navigator.permissions`, whose descriptor type accepts only the
 * names that browser knows, satisfies it.
 */
export interface LocalNetworkPermissions {
  query(descriptor: { readonly name: string }): Promise<{ readonly state: string }>;
}

const PermissionStateSchema = z.enum(['granted', 'prompt', 'denied']);

/**
 * The names to ask by, in the order they are tried.
 *
 * All three resolve on Chrome 150; the first is the one that answers there, so the ordinary blocked
 * case costs exactly one query. The rest exist because a browser that spells it differently would
 * otherwise be indistinguishable from one that has no such concept, and the difference between an
 * answer and no answer is the difference between a diagnosis and a list of possibilities.
 */
const PERMISSION_NAMES = ['local-network-access', 'local-network', 'loopback-network'] as const;

const defaultPermissions = (): LocalNetworkPermissions | undefined =>
  globalThis.navigator?.permissions as LocalNetworkPermissions | undefined;

/**
 * Ask the browser whether this site may reach the local network. Total: every failure is `'unknown'`.
 *
 * Called on a failure path only. Nothing polls it, nothing caches it, and no request is gated on it.
 */
export const readLocalNetworkAccess = async (
  permissions: LocalNetworkPermissions | undefined = defaultPermissions(),
): Promise<LocalNetworkAccess> => {
  if (permissions === undefined) return 'unknown';
  for (const name of PERMISSION_NAMES) {
    let state: unknown;
    try {
      state = (await permissions.query({ name })).state;
    } catch {
      // This browser does not know this name. A rejection is not an answer about the network.
      continue;
    }
    const parsed = PermissionStateSchema.safeParse(state);
    // A name that resolved has answered, even if the value is one this app does not know: asking the
    // next spelling would be asking a browser that already replied to reply again.
    return parsed.success ? parsed.data : 'unknown';
  }
  return 'unknown';
};
