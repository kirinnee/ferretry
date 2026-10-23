/**
 * WHICH PAIRED DAEMON, IF ANY, IS ON THIS COMPUTER — the one fact "Open links in › Your computer's
 * default browser" depends on.
 *
 * It is the machine whose connection is MEASURED to be a direct one to a loopback address: the page
 * and the daemon share a host, so the daemon's operating system is this computer's. Nothing else
 * qualifies. A relay, a tunnel or a WebRTC session is a remote carrier by construction, a LAN address
 * is another machine, and a connection that has carried nothing yet has not been measured at all — so
 * the option stays hidden rather than being offered on a guess. The daemon decides again for itself
 * from the carrier a request arrives on (`docs/grants.md`), so this only chooses what to offer; a
 * wrong answer here costs a silent fall-back to a new tab, never an open on the wrong machine.
 */

import { isLoopbackHost } from '@ferretry/protocol';
import type { ConnectionChoice } from '@ferretry/relay';
import type { DaemonId } from '../../lib/daemon-connection.ts';

/** A paired daemon and what its traffic is measured to be riding. */
export interface LocalComputerCandidate {
  readonly daemonId: DaemonId;
  readonly choice: ConnectionChoice | undefined;
}

/** Whether one measured carrier is a direct connection to an address on this computer. */
export const isLocalDirect = (choice: ConnectionChoice | undefined): boolean => {
  if (choice === undefined || !choice.ok || choice.method.kind !== 'direct') return false;
  try {
    return isLoopbackHost(new URL(choice.method.daemonUrl).hostname);
  } catch {
    return false;
  }
};

/** The first paired daemon that is on this computer, in the order the reader paired them. */
export const findLocalComputer = (candidates: readonly LocalComputerCandidate[]): DaemonId | undefined =>
  candidates.find(candidate => isLocalDirect(candidate.choice))?.daemonId;

/** Hands one address to this computer's browser, or rejects so the caller can open a tab itself. */
export type ComputerLinkPort = (href: string) => Promise<void>;
