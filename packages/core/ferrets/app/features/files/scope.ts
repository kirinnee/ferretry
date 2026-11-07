/**
 * WHICH FERRET, ON WHICH DAEMON, a file read is addressed to.
 *
 * The shell hands a half one client per daemon, already bound to that daemon and its credential, so a scope is only the
 * client plus the ferret id. Everything remembered about a ferret's files (the change probe, the open tabs, the tree)
 * is keyed by BOTH: two paired daemons can each hold a ferret with the same id, and a map keyed by the id alone would
 * hand one daemon's open files, listings and paths to the other.
 */
import type { FerretsClient } from '../../lib/client.ts';

export interface FilesScope {
  readonly client: FerretsClient;
  readonly ferretId: string;
}

const clientNumbers = new WeakMap<object, number>();
let nextClientNumber = 0;

/** A stable key for one ferret on one daemon: the client's identity and the ferret id. */
export const scopeKey = (scope: FilesScope): string => {
  let number = clientNumbers.get(scope.client);
  if (number === undefined) {
    nextClientNumber += 1;
    number = nextClientNumber;
    clientNumbers.set(scope.client, number);
  }
  return `${String(number)}:${scope.ferretId}`;
};
