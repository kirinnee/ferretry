/**
 * HOW THE DAEMON-LESS `/pair` PAGE REACHES THE MACHINE IT HAS JUST PAIRED WITH, to offer its first passkey.
 *
 * A daemon-less screen is handed no client, by type (`DaemonlessPorts`): before a pairing there is no machine to talk
 * to. After one there is, and the only holder of Access's guarded client on it is the passkey provision
 * (`accessPasskey`, built from the shell's {@link PasskeyPorts}). That provision leaves its `client` lookup here when it
 * is built, and this module hands the page a factory over it: nothing is added to the daemon-less ports, the page
 * still cannot reach any machine it has not paired with, and the reach is used for the passkey routes only.
 *
 * The shell connects to a daemon just after the pairing adds it, so the first look may find no client yet; the factory
 * looks a few more times before it gives up (and the offer, which treats any failure as "nothing to offer", stays quiet).
 */
import type { ShellPluginClient } from '@ferretry/app';
import { ACCESS_ROUTE_KEYS } from './daemon-scope.tsx';
import type { FirstPasskeyClientFactory } from './features/pairing/first-passkey-offer.tsx';
import { routeRequestClient } from './lib/route-request.ts';

/** Access's client on one machine, as the shell hands it to the passkey provision. */
export type PasskeyReach = (daemon: string) => ShellPluginClient | undefined;

let held: PasskeyReach | undefined;

/** Called once by the passkey provision with the shell's lookup; a later provision replaces it. */
export function holdPasskeyReach(reach: PasskeyReach): void {
  held = reach;
}

export interface PairedPasskeyClientOptions {
  /** Test seam; production reads what the passkey provision left. */
  readonly reach?: () => PasskeyReach | undefined;
  /** Test seam: waits between looks. */
  readonly wait?: (milliseconds: number) => Promise<void>;
  /** How many looks before giving up (default 6, 250 ms apart). */
  readonly attempts?: number;
}

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, milliseconds));
};

/** The offer's client factory for the `/pair` page. */
export function pairedPasskeyClient({
  reach = () => held,
  wait = sleep,
  attempts = 6,
}: PairedPasskeyClientOptions = {}): FirstPasskeyClientFactory {
  return async connection => {
    // No provision at all (a shell with no passkey half): there is nothing to wait for.
    const lookup = reach();
    if (lookup === undefined) throw new Error('this shell has no passkey provision to reach the machine through');
    for (let look = 0; look < attempts; look += 1) {
      const routed = lookup(connection.daemonId);
      if (routed !== undefined) return routeRequestClient(routed, ACCESS_ROUTE_KEYS);
      if (look < attempts - 1) await wait(250);
    }
    throw new Error('this device has no client on the machine it just paired with yet');
  };
}
