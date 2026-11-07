/**
 * THE PAIRING EXCHANGE, OVER WHAT THE APP SHELL HANDS ACCESS.
 *
 * The pairing screen asks for an exchange (`onPair`); this is Access's side of it. It holds no socket and chooses no
 * carrier: the shell opens the sealed `pair` session (§14: the daemon is proved against the QR's fingerprint inside it,
 * before the code leaves the page), and Connections, when it is present, decides which carrier first contact walks
 * (the daemon's own address first, then the one discovered rendezvous; R582). Access mints the key, reads the daemon's
 * answer, applies the checks that only Access knows, and keeps the pairing.
 *
 * `ports.pair` is the walk; a shell with no Connections walk answers it as one direct attempt, and a shell build that
 * has no `pair` at all falls back to `pairDirect` over the pairing's address. Pairing is never relayed by the shell's
 * own carrier, so that fallback is always direct.
 *
 * THE KEY IS KEPT ONLY AFTER THE DAEMON ANSWERED, AND ONLY ONE PLACE KEEPS IT. `claims.pairingKey` is memory-only; the
 * shell calls its `save` after the sealed `paired` answer (P28), on the walk and on the direct fallback alike, and
 * `save` checks the answer parses and names the daemon the link pinned before it writes. This exchange persists
 * nothing itself: a refused code never reaches `save`, so it leaves nothing behind. The checks only this side can make
 * (the §14 rendezvous rule, the daemon list) come after `save`, so on failing them the key the person had before
 * this attempt is put back, and a re-pair of a known daemon never loses the key that still works.
 */
import type { ConnectPorts, DeviceClaims, PairDirectInput, PairedDaemon, PairedOver } from '@ferretry/app';
import { PairingResponseSchema } from '../../contract/index.ts';
import { ConnectionMethodSchema, type RelayCarrier } from '../shell-pairing.ts';
import type { DeviceKeyStore } from './device-keys.ts';
import { type PairingSeed, pairedDaemonConnection } from './pairing.ts';

/** What the exchange touches of the shell's ports. */
export type PairingPorts = Pick<ConnectPorts, 'daemons' | 'pairDirect'> & Partial<Pick<ConnectPorts, 'pair'>>;

export interface PairingExchangeDependencies {
  readonly ports: PairingPorts;
  readonly claims: DeviceClaims;
  readonly store: Pick<DeviceKeyStore, 'load' | 'save'>;
}

/** Opens a `pair` session for this input: the shell's walk when it has one, else one direct attempt. */
const pairOver = async (ports: PairingPorts, input: PairDirectInput): Promise<PairedOver> => {
  if (ports.pair !== undefined) return await ports.pair(input);
  const outcome = await ports.pairDirect(input);
  return { ...outcome, via: { kind: 'direct', address: input.address } };
};

/** The rendezvous a relayed redemption crossed, as the §14 rule compares it; `undefined` for a direct one. */
const crossing = (via: PairedOver['via']): RelayCarrier | undefined => {
  if (via.kind === 'direct') return undefined;
  const parsed = ConnectionMethodSchema.safeParse({ kind: 'relay', relayUrl: via.address });
  if (!parsed.success || parsed.data.kind !== 'relay')
    throw new Error('the pairing crossed a rendezvous that is not dialable');
  return parsed.data;
};

/**
 * Redeems the seed's code as `deviceName`, keeps the key and the pairing, and answers the daemon now paired.
 * Rejects with the shell's own errors untouched (a refusal is `RelayPairingRefusedError`, so the screen can tell it
 * from a transport failure); nothing is kept on any rejection.
 */
export async function exchangePairing(
  dependencies: PairingExchangeDependencies,
  seed: PairingSeed,
  deviceName: string,
): Promise<PairedDaemon> {
  const { ports, claims, store } = dependencies;
  // Read before the attempt: `save` replaces it, and a failure after `save` must not cost the person a working key.
  const previous = await store.load(seed.daemonId);
  const pairingKey = await claims.pairingKey(seed.daemonId);
  const undo = async (): Promise<void> => {
    if (previous === undefined) await claims.forget(seed.daemonId);
    else await store.save(seed.daemonId, previous);
  };
  try {
    const outcome = await pairOver(ports, {
      address: seed.daemonUrl,
      daemonId: seed.daemonId,
      code: seed.code,
      key: { ...pairingKey, deviceName },
    });
    const response = PairingResponseSchema.parse(outcome.response);
    const connection = pairedDaemonConnection(seed, response, undefined, crossing(outcome.via));
    return ports.daemons.add({
      daemon: connection.daemonId,
      machine: response.daemonName,
      deviceId: response.deviceId,
      address: connection.baseUrl,
      carriers: response.carriers,
    });
  } catch (reason) {
    // Only a key `save` wrote can differ from `previous`; before `save` there is nothing to undo.
    if ((await store.load(seed.daemonId)) !== previous) await undo();
    throw reason;
  }
}
